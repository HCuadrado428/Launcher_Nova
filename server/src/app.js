const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { createStore, MODPACK_IDS } = require('./store');
const { normalizeUuid } = require('./external');
const { readModId } = require('./jarinfo');

const MAX_MOD_SIZE = 300 * 1024 * 1024; // por .jar
const MAX_FILES_PER_UPLOAD = 300;
const MAX_NEWS_LENGTH = 1500;
const MAX_MOD_LABEL = 40;
const MAX_MOD_DESCRIPTION = 140;
const DISCORD_URL_RE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]{2,40}$/;
const SHA1_RE = /^[a-f0-9]{40}$/;
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// multer entrega el nombre original en latin1; lo pasamos a UTF-8 y nos
// quedamos solo con el nombre (nada de rutas) y con caracteres normales.
function cleanJarName(originalName) {
  const utf8 = Buffer.from(String(originalName || ''), 'latin1').toString('utf8');
  const base = utf8.split(/[\\/]/).pop().trim();
  if (!/\.jar$/i.test(base)) return null;
  if (base.length > 180 || base.startsWith('.')) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: se rechazan a propósito
  if (/[\u0000-\u001f<>:"|?*]/.test(base)) return null;
  return base;
}

function sha1OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// Un .jar es un zip: empieza por "PK\x03\x04".
function looksLikeJar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } finally {
    fs.closeSync(fd);
  }
}

function createApp(options) {
  const {
    dataDir,
    jwtSecret,
    ownerEmail,
    googleClientId = '',
    verifyGoogleCredential,
    fetchMinecraftProfile,
    lookupMojangProfile,
    rateLimitMax = 30,
  } = options;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres.');
  const owner = String(ownerEmail || '').trim().toLowerCase();
  if (!owner) throw new Error('Falta OWNER_EMAIL.');

  const store = createStore(dataDir);
  store.backfillModIds(readModId).catch((err) => console.error('[ERROR] No se pudieron leer los modId:', err));
  const app = express();
  app.set('trust proxy', 1); // Railway pone un proxy delante
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // El botón de Google necesita su script, su iframe y poder abrir un popup.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://accounts.google.com/gsi/client",
        "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
        'frame-src https://accounts.google.com/gsi/',
        "connect-src 'self' https://accounts.google.com/gsi/",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: rateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Espera unos minutos.' },
  });

  // ---------- Sesiones ----------

  function signToken(payload, audience, expiresIn) {
    return jwt.sign(payload, jwtSecret, { algorithm: 'HS256', audience, expiresIn });
  }

  function requireSession(audience) {
    return (req, res, next) => {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      try {
        req.session = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], audience });
      } catch {
        throw new HttpError(401, 'Sesión caducada o no válida. Vuelve a iniciar sesión.');
      }
      next();
    };
  }
  const requirePlayer = requireSession('launcher');
  const requireOwner = [
    requireSession('panel'),
    (req, res, next) => {
      // Se vuelve a comprobar en cada petición por si cambia OWNER_EMAIL.
      if (req.session.email !== owner) throw new HttpError(403, 'Esta cuenta no puede usar el panel.');
      next();
    },
  ];

  // Admin = cuenta de Microsoft verificada cuyo UUID está en la lista. Se
  // mira en cada petición (no va dentro del token) para que quitar a alguien
  // de la lista tenga efecto al momento.
  const isAdmin = (session) => session.premium === true && store.isAdminUuid(session.uuid);

  function playerInfo(session) {
    return { name: session.name, uuid: session.uuid, premium: session.premium === true, admin: isAdmin(session) };
  }

  function accessibleModpack(req) {
    const modpack = store.getModpack(req.params.id);
    if (!modpack) throw new HttpError(404, 'Ese modpack no existe.');
    if (modpack.id === 'admin' && !isAdmin(req.session)) {
      throw new HttpError(403, 'Este modpack es solo para cuentas admin.');
    }
    return modpack;
  }

  // ---------- API del launcher ----------

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/auth/microsoft', authLimiter, async (req, res) => {
    const accessToken = req.body && req.body.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192) {
      throw new HttpError(400, 'Falta el token de Minecraft.');
    }
    let profile;
    try {
      profile = await fetchMinecraftProfile(accessToken);
    } catch {
      throw new HttpError(502, 'No se pudo contactar con los servidores de Minecraft. Inténtalo de nuevo.');
    }
    if (!profile) throw new HttpError(401, 'Microsoft no reconoce esa sesión de Minecraft.');
    const session = { uuid: profile.uuid, name: profile.name, premium: true };
    res.json({ token: signToken(session, 'launcher', '30d'), player: playerInfo(session) });
  });

  app.post('/api/auth/offline', authLimiter, (req, res) => {
    const username = req.body && req.body.username;
    if (typeof username !== 'string' || !NICK_RE.test(username)) {
      throw new HttpError(400, 'El nick solo puede tener letras, números y _ (máximo 16).');
    }
    // Una cuenta offline nunca es admin: el nick no demuestra nada.
    const session = { uuid: null, name: username, premium: false };
    res.json({ token: signToken(session, 'launcher', '30d'), player: playerInfo(session) });
  });

  app.get('/api/me', requirePlayer, (req, res) => res.json({ player: playerInfo(req.session) }));

  app.get('/api/modpacks', requirePlayer, (req, res) => {
    const ids = isAdmin(req.session) ? MODPACK_IDS : ['normal'];
    res.json({
      player: playerInfo(req.session),
      modpacks: ids.map((id) => store.publicModpack(store.getModpack(id))),
      ...store.getAnnouncements(),
    });
  });

  app.get('/api/modpacks/:id/manifest', requirePlayer, (req, res) => {
    res.json(store.publicModpack(accessibleModpack(req), { withMods: true }));
  });

  app.get('/api/modpacks/:id/files/:sha1', requirePlayer, (req, res) => {
    const modpack = accessibleModpack(req);
    const { sha1 } = req.params;
    const mod = SHA1_RE.test(sha1) && modpack.mods.find((m) => m.sha1 === sha1);
    if (!mod) throw new HttpError(404, 'Ese archivo no forma parte del modpack.');
    res.setHeader('Content-Type', 'application/java-archive');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    // Con root: así una carpeta de datos con punto en la ruta no hace que Express lo trate como archivo oculto.
    res.sendFile(`${sha1}.jar`, { root: store.filesDir }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'El archivo ya no está en el servidor.' });
    });
  });

  // ---------- API del panel (solo el dueño) ----------

  app.get('/api/panel/config', (req, res) => res.json({ googleClientId }));

  app.post('/api/panel/login', authLimiter, async (req, res) => {
    const credential = req.body && req.body.credential;
    if (typeof credential !== 'string' || !credential) throw new HttpError(400, 'Falta la credencial de Google.');
    let google;
    try {
      google = await verifyGoogleCredential(credential);
    } catch {
      throw new HttpError(401, 'Google no ha podido verificar esa cuenta.');
    }
    if (google.email !== owner) throw new HttpError(403, 'Esta cuenta de Google no tiene acceso al panel.');
    res.json({ token: signToken({ email: google.email }, 'panel', '12h'), email: google.email });
  });

  function panelState() {
    return {
      modpacks: MODPACK_IDS.map((id) => store.publicModpack(store.getModpack(id), { withMods: true })),
      admins: store.listAdmins(),
      ...store.getAnnouncements(),
    };
  }

  app.get('/api/panel/state', requireOwner, (req, res) => res.json(panelState()));

  function panelModpack(req) {
    const modpack = store.getModpack(req.params.id);
    if (!modpack) throw new HttpError(404, 'Ese modpack no existe.');
    return modpack;
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: store.tmpDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
    }),
    limits: { fileSize: MAX_MOD_SIZE, files: MAX_FILES_PER_UPLOAD },
  }).array('mods', MAX_FILES_PER_UPLOAD);

  // Sube uno o varios .jar a un modpack. Cada archivo se valida por separado:
  // uno malo no impide que entren los demás, y la respuesta dice qué pasó
  // con cada uno.
  app.post(
    '/api/panel/modpacks/:id/mods',
    requireOwner,
    (req, res, next) => {
      panelModpack(req);
      upload(req, res, (err) => {
        if (!err) return next();
        for (const file of req.files || []) fs.rmSync(file.path, { force: true });
        if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'Hay un archivo de más de 300 MB.'));
        if (err.code === 'LIMIT_FILE_COUNT') return next(new HttpError(413, 'Demasiados archivos de una vez.'));
        next(new HttpError(400, 'No se pudo leer la subida.'));
      });
    },
    async (req, res) => {
      const results = [];
      for (const file of req.files || []) {
        const filename = cleanJarName(file.originalname);
        try {
          if (!filename) throw new Error('No es un .jar o el nombre no es válido.');
          if (file.size === 0 || !looksLikeJar(file.path)) throw new Error('El archivo no es un .jar válido.');
          const sha1 = await sha1OfFile(file.path);
          const modId = await readModId(file.path);
          const { replaced } = store.addMod(req.params.id, { tmpPath: file.path, filename, sha1, size: file.size, modId });
          results.push({ filename, ok: true, replaced: replaced.length > 0, replacedFiles: replaced });
        } catch (err) {
          fs.rmSync(file.path, { force: true });
          results.push({ filename: filename || String(file.originalname).slice(0, 180), ok: false, error: err.message });
        }
      }
      if (results.length === 0) throw new HttpError(400, 'No has enviado ningún archivo.');
      res.json({ results, ...panelState() });
    },
  );

  // Marca un mod como opcional (cada jugador decide en el launcher si lo usa)
  // y le pone el nombre y la descripción que verá el jugador.
  app.patch('/api/panel/modpacks/:id/mods/:modId', requireOwner, (req, res) => {
    panelModpack(req);
    const body = req.body || {};
    const fields = {};
    if (body.optional !== undefined) {
      if (typeof body.optional !== 'boolean') throw new HttpError(400, 'Falta indicar si es opcional.');
      fields.optional = body.optional;
    }
    if (body.label !== undefined) fields.label = String(body.label).trim().slice(0, MAX_MOD_LABEL);
    if (body.description !== undefined) fields.description = String(body.description).trim().slice(0, MAX_MOD_DESCRIPTION);
    if (Object.keys(fields).length === 0) throw new HttpError(400, 'No hay nada que cambiar.');
    if (!store.updateMod(req.params.id, req.params.modId, fields)) throw new HttpError(404, 'Ese mod ya no está.');
    res.json(panelState());
  });

  app.delete('/api/panel/modpacks/:id/mods/:modId', requireOwner, (req, res) => {
    panelModpack(req);
    if (store.removeMods(req.params.id, [req.params.modId]) === 0) throw new HttpError(404, 'Ese mod ya no está.');
    res.json(panelState());
  });

  app.delete('/api/panel/modpacks/:id/mods', requireOwner, (req, res) => {
    const modpack = panelModpack(req);
    store.removeMods(
      modpack.id,
      modpack.mods.map((m) => m.id),
    );
    res.json(panelState());
  });

  app.post('/api/panel/modpacks/:id/copy-from/:from', requireOwner, (req, res) => {
    const to = panelModpack(req);
    const from = store.getModpack(req.params.from);
    if (!from || from.id === to.id) throw new HttpError(400, 'Modpack de origen no válido.');
    store.copyMods(from.id, to.id);
    res.json(panelState());
  });

  app.patch('/api/panel/modpacks/:id', requireOwner, (req, res) => {
    const modpack = panelModpack(req);
    const body = req.body || {};
    const fields = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 40) throw new HttpError(400, 'El nombre debe tener entre 1 y 40 caracteres.');
      fields.name = name;
    }
    if (body.description !== undefined) fields.description = String(body.description).trim().slice(0, 200);
    if (body.mcVersion !== undefined) {
      if (!VERSION_RE.test(String(body.mcVersion))) throw new HttpError(400, 'Versión de Minecraft no válida.');
      fields.mcVersion = String(body.mcVersion);
    }
    if (body.loaderVersion !== undefined) {
      const value = String(body.loaderVersion).trim();
      if (value && !VERSION_RE.test(value)) throw new HttpError(400, 'Versión de Forge no válida.');
      fields.loaderVersion = value;
    }
    store.updateModpack(modpack.id, fields);
    res.json(panelState());
  });

  app.put('/api/panel/news', requireOwner, (req, res) => {
    const text = req.body && req.body.text;
    if (typeof text !== 'string' || text.length > MAX_NEWS_LENGTH) {
      throw new HttpError(400, `Las novedades no pueden pasar de ${MAX_NEWS_LENGTH} caracteres.`);
    }
    store.setNews(text.trim());
    res.json(panelState());
  });

  // Invitación al Discord: el botón «Abrir Discord» de la ayuda del launcher.
  app.put('/api/panel/discord', requireOwner, (req, res) => {
    const url = String((req.body && req.body.url) || '').trim();
    if (url && !DISCORD_URL_RE.test(url)) {
      throw new HttpError(400, 'El enlace debe ser una invitación de Discord (https://discord.gg/...).');
    }
    store.setDiscordUrl(url);
    res.json(panelState());
  });

  // Próximo evento (cuenta atrás en el launcher). Con { event: null } se quita.
  app.put('/api/panel/event', requireOwner, (req, res) => {
    const event = req.body && req.body.event;
    if (event === null) {
      store.setEvent(null);
      return res.json(panelState());
    }
    const name = String((event && event.name) || '').trim();
    const start = new Date(event && event.start);
    const hours = Number(event && event.hours) || 3;
    if (!name || name.length > 60) throw new HttpError(400, 'El evento necesita un nombre de hasta 60 caracteres.');
    if (Number.isNaN(start.getTime())) throw new HttpError(400, 'La fecha del evento no es válida.');
    if (hours < 1 || hours > 72) throw new HttpError(400, 'La duración debe estar entre 1 y 72 horas.');
    store.setEvent({ name, start: start.toISOString(), hours });
    res.json(panelState());
  });

  app.post('/api/panel/admins', requireOwner, async (req, res) => {
    const nick = String((req.body && req.body.nick) || '').trim();
    if (!NICK_RE.test(nick)) throw new HttpError(400, 'Ese nick no es válido.');
    let profile;
    try {
      profile = await lookupMojangProfile(nick);
    } catch {
      throw new HttpError(502, 'No se pudo consultar a Mojang. Inténtalo de nuevo en un momento.');
    }
    if (!profile) throw new HttpError(404, `No existe ninguna cuenta premium de Minecraft llamada "${nick}".`);
    store.addAdmin({ nick: profile.name, uuid: normalizeUuid(profile.uuid) });
    res.json(panelState());
  });

  app.delete('/api/panel/admins/:adminId', requireOwner, (req, res) => {
    if (!store.removeAdmin(req.params.adminId)) throw new HttpError(404, 'Ese admin ya no está en la lista.');
    res.json(panelState());
  });

  // ---------- Panel web y errores ----------

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', extensions: ['html'] }));

  // biome-ignore lint/correctness/noUnusedVariables: Express reconoce el manejador de errores por sus 4 argumentos
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[ERROR]', err);
    const message =
      err instanceof HttpError ? err.message : status < 500 ? 'Petición no válida.' : 'Error interno del servidor.';
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
