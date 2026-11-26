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
const { writeBackup, restoreBackup, BackupError } = require('./backup');
const { EXTRA_ROOTS, cleanExtraPath, extractExtras, ExtrasError } = require('./extras');

const MAX_MOD_SIZE = 300 * 1024 * 1024; // por .jar
const MAX_FILES_PER_UPLOAD = 300;
const MAX_NEWS_LENGTH = 1500;
const MAX_MOD_LABEL = 40;
const MAX_PHRASES = 60;
const MAX_PHRASE_LENGTH = 70;
const MAX_BACKUP_SIZE = 8 * 1024 ** 3;
const MAX_BAN_HOURS = 24 * 366;
const MAX_BAN_REASON = 120;
const MAX_MOD_DESCRIPTION = 140;
const DISCORD_URL_RE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]{2,40}$/;
const SHA1_RE = /^[a-f0-9]{40}$/;
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;

class HttpError extends Error {
  // extra: campos que se añaden a la respuesta JSON junto al mensaje.
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
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

// Cierres por error que se cuentan al día de un mismo jugador.
const MAX_CRASHES_PER_PLAYER_DAY = 5;
// Personajes (nicks sin premium) que puede tener cada admin.
const MAX_CHARACTERS = 12;

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
    // Búsqueda de mods en CurseForge: función (ruta, parámetros) => JSON, o null si no hay clave.
    curseforge = null,
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
  // Clave con la que se guarda a cada jugador. Una cuenta de Microsoft es su
  // UUID (el nick puede cambiar); una sin premium es solo su nick, y va con
  // prefijo para que nunca se confunda con una cuenta verificada.
  const playerKey = (session) => (session.premium === true ? session.uuid : `offline:${String(session.name).toLowerCase()}`);

  function banError(ban) {
    const until = ban.until ? ` hasta el ${new Date(ban.until).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'long', timeStyle: 'short' })} (hora de Madrid)` : '';
    const reason = ban.reason ? ` Motivo: ${ban.reason}` : '';
    return new HttpError(403, `Tu acceso al launcher está suspendido${until}.${reason}`, {
      code: 'banned',
      until: ban.until,
      reason: ban.reason,
    });
  }

  // Toda petición del launcher pasa por aquí: se rechaza a quien tenga el
  // acceso suspendido y se apunta que el jugador ha usado el launcher.
  function trackPlayer(req, session) {
    const key = playerKey(session);
    const ban = store.activeBan(key);
    if (ban) throw banError(ban);
    const version = String(req.headers['x-launcher-version'] || '').slice(0, 20);
    store.touchPlayer(key, {
      name: session.name,
      uuid: session.uuid,
      premium: session.premium === true,
      launcherVersion: /^[\w.-]*$/.test(version) ? version : '',
    });
  }

  const requirePlayer = [
    requireSession('launcher'),
    (req, res, next) => {
      trackPlayer(req, req.session);
      next();
    },
  ];
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

  // Cuántos personajes (nicks sin premium para entrar al juego) puede tener
  // esa cuenta: los admins, el máximo; el resto, lo que le haya dado el dueño.
  function characterLimit(session) {
    return isAdmin(session) ? MAX_CHARACTERS : store.characterLimit(playerKey(session));
  }

  function playerInfo(session) {
    return {
      name: session.name,
      uuid: session.uuid,
      premium: session.premium === true,
      admin: isAdmin(session),
      characterLimit: characterLimit(session),
    };
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
    trackPlayer(req, session);
    res.json({ token: signToken(session, 'launcher', '30d'), player: playerInfo(session) });
  });

  app.post('/api/auth/offline', authLimiter, (req, res) => {
    const username = req.body && req.body.username;
    if (typeof username !== 'string' || !NICK_RE.test(username)) {
      throw new HttpError(400, 'El nick solo puede tener letras, números y _ (máximo 16).');
    }
    // Una cuenta offline nunca es admin: el nick no demuestra nada.
    const session = { uuid: null, name: username, premium: false };
    trackPlayer(req, session);
    res.json({ token: signToken(session, 'launcher', '30d'), player: playerInfo(session) });
  });

  app.get('/api/me', requirePlayer, (req, res) => res.json({ player: playerInfo(req.session) }));

  // Personajes de un admin (nicks sin premium para el modpack de admins). El
  // launcher manda la lista entera cada vez que cambia; aquí solo se guardan
  // los nicks, para que el dueño los vea en el panel y no pisen a nadie.
  app.put('/api/me/characters', requirePlayer, (req, res) => {
    const limit = characterLimit(req.session);
    if (limit === 0) throw new HttpError(403, 'Tu cuenta no tiene permiso para usar personajes.');
    const list = req.body && req.body.characters;
    if (!Array.isArray(list) || list.length > limit) {
      throw new HttpError(400, limit === 1 ? 'Puedes tener 1 personaje.' : `Puedes tener hasta ${limit} personajes.`);
    }
    const nicks = [];
    for (const nick of list) {
      if (typeof nick !== 'string' || !/^\w{3,16}$/.test(nick)) {
        throw new HttpError(400, 'Un nick tiene de 3 a 16 letras, números o guiones bajos.');
      }
      if (nicks.some((known) => known.toLowerCase() === nick.toLowerCase())) {
        throw new HttpError(400, `El nick ${nick} está repetido.`);
      }
      nicks.push(nick);
    }
    const refused = store.setCharacters(playerKey(req.session), nicks);
    if (refused && refused.code === 'blocked') {
      throw new HttpError(409, `El dueño del servidor ha quitado el personaje ${refused.nick}.`, {
        code: 'nick-blocked',
        nick: refused.nick,
      });
    }
    if (refused) {
      throw new HttpError(409, `El nick ${refused.nick} ya lo usa otro jugador.`, { code: 'nick-taken', nick: refused.nick });
    }
    res.json({ characters: nicks });
  });

  app.get('/api/modpacks', requirePlayer, (req, res) => {
    const ids = isAdmin(req.session) ? MODPACK_IDS : ['normal'];
    res.json({
      player: playerInfo(req.session),
      modpacks: ids.map((id) => store.publicModpack(store.getModpack(id))),
      ...store.getAnnouncements(),
      // Personajes que el dueño le ha quitado a este admin desde el panel.
      blockedCharacters: store.blockedCharacters(playerKey(req.session)),
      curseforge: Boolean(curseforge),
    });
  });

  // «disabled»: mods opcionales que el jugador tiene desactivados (lo manda
  // el launcher al ir a jugar). Solo alimenta las estadísticas del panel.
  app.get('/api/modpacks/:id/manifest', requirePlayer, (req, res) => {
    const modpack = accessibleModpack(req);
    if (typeof req.query.disabled === 'string') {
      // Misma clave que usa el launcher: el modId, o el nombre del archivo, en minúsculas.
      const optional = new Set(modpack.mods.filter((m) => m.optional).map((m) => String(m.modId || m.filename).toLowerCase()));
      const keys = [...new Set(req.query.disabled.toLowerCase().split(',').filter((key) => optional.has(key)))];
      store.setDisabledMods(playerKey(req.session), modpack.id, keys);
    }
    // Con «maintenance» el launcher no deja jugar. A los admins no se les manda.
    const maintenance = store.getAnnouncements().maintenance;
    res.json({
      ...store.publicModpack(modpack, { withMods: true }),
      maintenance: maintenance && !isAdmin(req.session) ? maintenance.message : null,
    });
  });

  // El launcher avisa de que el juego se ha cerrado por error. Solo se cuenta
  // (cuántos al día y qué mods señala el informe), para que el dueño vea en el
  // panel si una actualización ha roto algo. No se guarda quién ni el informe.
  const crashReports = new Map(); // jugador -> { day, count }
  app.post('/api/me/crash', requirePlayer, (req, res) => {
    const key = playerKey(req.session);
    const day = new Date().toISOString().slice(0, 10);
    const seen = crashReports.get(key);
    const count = seen && seen.day === day ? seen.count + 1 : 1;
    crashReports.set(key, { day, count });
    // Un mismo jugador reintentando una y otra vez no debe inflar la cuenta.
    if (count <= MAX_CRASHES_PER_PLAYER_DAY) {
      const raw = req.body && Array.isArray(req.body.suspects) ? req.body.suspects : [];
      const suspects = [
        ...new Set(
          raw
            .filter((name) => typeof name === 'string')
            .map((name) => name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60))
            .filter(Boolean),
        ),
      ].slice(0, 5);
      store.recordCrash(suspects);
    }
    res.json({ ok: true });
  });

  // ---------- CurseForge (la clave de su API se queda en el servidor) ----------

  const CF_MINECRAFT = 432;
  const CF_MODS_CLASS = 6;
  const CF_FORGE = 1;
  const CF_SHA1 = 1;

  function requireCurseforge(req, res, next) {
    if (!curseforge) throw new HttpError(503, 'La búsqueda en CurseForge no está configurada en el servidor.');
    next();
  }

  async function askCurseforge(pathname, params) {
    try {
      return await curseforge(pathname, params);
    } catch {
      throw new HttpError(502, 'CurseForge no responde ahora mismo.');
    }
  }

  app.get('/api/curseforge/search', requirePlayer, requireCurseforge, async (req, res) => {
    const query = String(req.query.q || '').trim().slice(0, 80);
    const mcVersion = String(req.query.mc || '');
    if (!VERSION_RE.test(mcVersion)) throw new HttpError(400, 'Versión de Minecraft no válida.');
    const data = await askCurseforge('/v1/mods/search', {
      gameId: CF_MINECRAFT,
      classId: CF_MODS_CLASS,
      searchFilter: query,
      gameVersion: mcVersion,
      modLoaderType: CF_FORGE,
      sortField: 2, // popularidad
      sortOrder: 'desc',
      pageSize: 20,
    });
    const list = data && Array.isArray(data.data) ? data.data : [];
    res.json({
      hits: list.map((mod) => ({
        id: String(mod.id),
        title: String(mod.name || ''),
        description: String(mod.summary || ''),
        downloads: Number(mod.downloadCount) || 0,
        icon: (mod.logo && mod.logo.thumbnailUrl) || null,
        // El autor puede prohibir que se descargue desde fuera de la app de CurseForge.
        allowed: mod.allowModDistribution !== false,
      })),
    });
  });

  // El archivo más reciente de ese mod para esta versión de Minecraft y Forge.
  app.get('/api/curseforge/mods/:modId/file', requirePlayer, requireCurseforge, async (req, res) => {
    const { modId } = req.params;
    const mcVersion = String(req.query.mc || '');
    if (!/^\d{1,10}$/.test(modId) || !VERSION_RE.test(mcVersion)) throw new HttpError(400, 'Petición no válida.');
    const data = await askCurseforge(`/v1/mods/${modId}/files`, {
      gameVersion: mcVersion,
      modLoaderType: CF_FORGE,
      pageSize: 20,
    });
    const files = (data && Array.isArray(data.data) ? data.data : [])
      .filter((file) => file.isAvailable !== false && /\.jar$/i.test(String(file.fileName || '')))
      .sort((a, b) => String(b.fileDate || '').localeCompare(String(a.fileDate || '')));
    if (files.length === 0) throw new HttpError(404, 'Ese mod no tiene versión para este modpack.');
    const file = files.find((candidate) => candidate.downloadUrl) || null;
    if (!file) throw new HttpError(409, 'El autor no permite descargar este mod desde fuera de CurseForge.', { code: 'no-distribution' });
    const sha1 = (file.hashes || []).find((hash) => hash.algo === CF_SHA1);
    res.json({
      filename: String(file.fileName),
      url: String(file.downloadUrl),
      size: Number(file.fileLength) || 0,
      sha1: sha1 ? String(sha1.value).toLowerCase() : null,
    });
  });

  app.get('/api/modpacks/:id/files/:sha1', requirePlayer, (req, res) => {
    const modpack = accessibleModpack(req);
    const { sha1 } = req.params;
    // En mantenimiento no se reparte nada a los jugadores (los admins sí, para probar).
    const maintenance = store.getAnnouncements().maintenance;
    if (maintenance && !isAdmin(req.session)) throw new HttpError(503, maintenance.message, { code: 'maintenance' });
    const known = SHA1_RE.test(sha1) && [...modpack.mods, ...modpack.files].some((item) => item.sha1 === sha1);
    if (!known) throw new HttpError(404, 'Ese archivo no forma parte del modpack.');
    const isMod = modpack.mods.some((m) => m.sha1 === sha1);
    res.setHeader('Content-Type', isMod ? 'application/java-archive' : 'application/octet-stream');
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
      players: store.listPlayers().map(({ disabled, ...player }) => ({
        ...player,
        admin: player.premium && store.isAdminUuid(player.uuid),
      })),
      history: Object.fromEntries(MODPACK_IDS.map((id) => [id, store.listHistory(id)])),
      stats: store.stats(),
      storage: store.storage(),
      extraRoots: EXTRA_ROOTS,
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
      const count = (req.files || []).length;
      if (count > 0) store.snapshot(req.params.id, count === 1 ? 'Antes de subir 1 mod' : `Antes de subir ${count} mods`);
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
    const target = panelModpack(req).mods.find((m) => m.id === req.params.modId);
    if (!target) throw new HttpError(404, 'Ese mod ya no está.');
    store.snapshot(req.params.id, `Antes de cambiar ${target.filename}`);
    if (!store.updateMod(req.params.id, req.params.modId, fields)) throw new HttpError(404, 'Ese mod ya no está.');
    res.json(panelState());
  });

  app.delete('/api/panel/modpacks/:id/mods/:modId', requireOwner, (req, res) => {
    const target = panelModpack(req).mods.find((m) => m.id === req.params.modId);
    if (!target) throw new HttpError(404, 'Ese mod ya no está.');
    store.snapshot(req.params.id, `Antes de quitar ${target.filename}`);
    store.removeMods(req.params.id, [req.params.modId]);
    res.json(panelState());
  });

  app.delete('/api/panel/modpacks/:id/mods', requireOwner, (req, res) => {
    const modpack = panelModpack(req);
    if (modpack.mods.length > 0) store.snapshot(modpack.id, 'Antes de quitar todos los mods');
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
    store.snapshot(to.id, `Antes de copiar los mods de ${from.name}`);
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
    if (fields.mcVersion !== undefined || fields.loaderVersion !== undefined) {
      store.snapshot(modpack.id, 'Antes de cambiar la versión de Minecraft o Forge');
    }
    store.updateModpack(modpack.id, fields);
    res.json(panelState());
  });

  // ---------- Archivos sueltos: config, recursos y shaders ----------

  const uploadExtra = multer({
    storage: multer.diskStorage({
      destination: store.tmpDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
    }),
    limits: { fileSize: MAX_MOD_SIZE, files: 1 },
  }).single('file');

  // target = 'zip': un .zip con las carpetas config/, resourcepacks/... dentro.
  // target = una carpeta permitida: el archivo va tal cual a esa carpeta (un
  // paquete de recursos o de shaders, que ya son un .zip).
  app.post(
    '/api/panel/modpacks/:id/files',
    requireOwner,
    (req, res, next) => {
      panelModpack(req);
      uploadExtra(req, res, (err) => {
        if (!err) return next();
        if (req.file) fs.rmSync(req.file.path, { force: true });
        if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'El archivo pasa de 300 MB.'));
        next(new HttpError(400, 'No se pudo leer la subida.'));
      });
    },
    async (req, res) => {
      const file = req.file;
      if (!file) throw new HttpError(400, 'No has enviado ningún archivo.');
      const target = String((req.body && req.body.target) || 'zip');
      let entries;
      let skipped = 0;
      try {
        if (target === 'zip') {
          ({ entries, skipped } = await extractExtras(file.path, store.tmpDir));
          if (entries.length === 0) {
            throw new ExtrasError(`El .zip no lleva ninguna de estas carpetas: ${EXTRA_ROOTS.join(', ')}.`);
          }
        } else {
          const name = Buffer.from(String(file.originalname || ''), 'latin1').toString('utf8').split(/[\\/]/).pop();
          const cleaned = EXTRA_ROOTS.includes(target) ? cleanExtraPath(`${target}/${name}`) : null;
          if (!cleaned || file.size === 0) throw new ExtrasError('El nombre del archivo o la carpeta de destino no valen.');
          entries = [{ tmpPath: file.path, path: cleaned, sha1: await sha1OfFile(file.path), size: file.size }];
        }
      } catch (err) {
        fs.rmSync(file.path, { force: true });
        if (err instanceof ExtrasError) throw new HttpError(400, err.message);
        throw err;
      }
      if (target === 'zip') fs.rmSync(file.path, { force: true });
      store.snapshot(req.params.id, entries.length === 1 ? `Antes de subir ${entries[0].path}` : `Antes de subir ${entries.length} archivos`);
      store.addFiles(req.params.id, entries);
      res.json({ added: entries.length, skipped, ...panelState() });
    },
  );

  // paths: rutas o carpetas a quitar («config/create» quita toda la carpeta).
  app.post('/api/panel/modpacks/:id/files/remove', requireOwner, (req, res) => {
    const modpack = panelModpack(req);
    const paths = req.body && req.body.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || !p)) {
      throw new HttpError(400, 'Falta indicar qué archivos quitar.');
    }
    const affected = modpack.files.filter((f) => paths.some((p) => f.path === p || f.path.startsWith(`${p}/`))).length;
    if (affected === 0) throw new HttpError(404, 'Esos archivos ya no están.');
    store.snapshot(modpack.id, affected === 1 ? 'Antes de quitar 1 archivo' : `Antes de quitar ${affected} archivos`);
    store.removeFiles(modpack.id, paths);
    res.json(panelState());
  });

  // ---------- Historial: volver a una versión anterior del modpack ----------

  app.post('/api/panel/modpacks/:id/history/:snapshotId/restore', requireOwner, (req, res) => {
    const modpack = panelModpack(req);
    if (!store.restoreSnapshot(modpack.id, req.params.snapshotId)) throw new HttpError(404, 'Esa versión ya no está guardada.');
    res.json(panelState());
  });

  // ---------- Personajes de los admins ----------

  // Permiso de personajes para un jugador que no es admin: cuántos puede
  // tener (0 se lo quita). Los admins ya tienen el máximo.
  app.put('/api/panel/players/:key/character-limit', requireOwner, (req, res) => {
    const limit = Number(req.body && req.body.limit);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_CHARACTERS) {
      throw new HttpError(400, `El número de personajes va de 0 a ${MAX_CHARACTERS}.`);
    }
    if (!store.setCharacterLimit(req.params.key, limit)) throw new HttpError(404, 'Ese jugador no está en la lista.');
    res.json(panelState());
  });

  // Quita un personaje a un admin y no le deja volver a ponerlo.
  app.delete('/api/panel/players/:key/characters/:nick', requireOwner, (req, res) => {
    if (!store.blockCharacter(req.params.key, req.params.nick)) throw new HttpError(404, 'Ese jugador no está en la lista.');
    res.json(panelState());
  });

  // Le vuelve a permitir un personaje que se le había quitado.
  app.delete('/api/panel/players/:key/blocked-characters/:nick', requireOwner, (req, res) => {
    if (!store.unblockCharacter(req.params.key, req.params.nick)) throw new HttpError(404, 'Ese personaje no estaba quitado.');
    res.json(panelState());
  });

  // Suspende el acceso de un jugador al launcher. hours: duración en horas,
  // o null para que no tenga fin.
  app.put('/api/panel/players/:key/ban', requireOwner, (req, res) => {
    const { key } = req.params;
    if (!store.hasPlayer(key)) throw new HttpError(404, 'Ese jugador no está en la lista.');
    const body = req.body || {};
    let until = null;
    if (body.hours !== null && body.hours !== undefined) {
      const hours = Number(body.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_BAN_HOURS) {
        throw new HttpError(400, 'La duración debe ser de entre 1 hora y 1 año.');
      }
      until = new Date(Date.now() + hours * 3_600_000).toISOString();
    }
    store.setBan(key, { until, reason: String(body.reason || '').trim().slice(0, MAX_BAN_REASON) });
    res.json(panelState());
  });

  // Quita a un jugador de la lista (limpieza). No es una suspensión.
  app.delete('/api/panel/players/:key', requireOwner, (req, res) => {
    // A un suspendido no se le quita: dejaría de verse en la lista y no habría
    // forma de levantarle la suspensión desde el panel.
    if (store.activeBan(req.params.key)) throw new HttpError(409, 'Quítale antes la suspensión.');
    if (!store.removePlayer(req.params.key)) throw new HttpError(404, 'Ese jugador no está en la lista.');
    res.json(panelState());
  });

  app.delete('/api/panel/players/:key/ban', requireOwner, (req, res) => {
    if (!store.removeBan(req.params.key)) throw new HttpError(404, 'Ese jugador no tiene el acceso suspendido.');
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

  // Frases que el launcher enseña al azar junto al título (bromas del
  // servidor, citas del lore...). Una por línea.
  app.put('/api/panel/phrases', requireOwner, (req, res) => {
    const text = req.body && req.body.text;
    if (typeof text !== 'string') throw new HttpError(400, 'Faltan las frases.');
    const phrases = text
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, MAX_PHRASE_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_PHRASES);
    store.setPhrases(phrases);
    res.json(panelState());
  });

  // ---------- Copia de seguridad ----------

  // La descarga la hace el navegador navegando a una dirección, y ahí no se
  // puede mandar la cabecera de sesión: se pide antes un enlace que vale dos
  // minutos y solo para esto.
  app.post('/api/panel/backup-link', requireOwner, (req, res) => {
    res.json({ url: `/api/panel/backup?t=${encodeURIComponent(signToken({ email: owner }, 'backup', '2m'))}` });
  });

  app.get('/api/panel/backup', async (req, res) => {
    let session;
    try {
      session = jwt.verify(String(req.query.t || ''), jwtSecret, { algorithms: ['HS256'], audience: 'backup' });
    } catch {
      throw new HttpError(401, 'El enlace de descarga ha caducado. Vuelve a pulsar «Descargar copia».');
    }
    if (session.email !== owner) throw new HttpError(403, 'Esta cuenta no puede usar el panel.');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="nova-panel-copia-${stamp}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      await writeBackup(store, res);
    } catch (err) {
      // Lo normal es que el navegador haya cancelado la descarga.
      console.warn('[AVISO] La copia de seguridad no se terminó de enviar:', err.message);
      res.destroy();
    }
  });

  const uploadBackup = multer({
    storage: multer.diskStorage({
      destination: store.tmpDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.backup`),
    }),
    limits: { fileSize: MAX_BACKUP_SIZE, files: 1 },
  }).single('backup');

  app.post(
    '/api/panel/restore',
    requireOwner,
    (req, res, next) => {
      uploadBackup(req, res, (err) => {
        if (!err) return next();
        if (req.file) fs.rmSync(req.file.path, { force: true });
        next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'No se pudo leer la copia subida.'));
      });
    },
    async (req, res) => {
      if (!req.file) throw new HttpError(400, 'No has enviado ninguna copia.');
      try {
        const result = await restoreBackup(store, req.file.path);
        res.json({ restored: result, ...panelState() });
      } catch (err) {
        if (err instanceof BackupError) throw new HttpError(400, err.message);
        throw err;
      } finally {
        fs.rmSync(req.file.path, { force: true });
      }
    },
  );

  // Invitación al Discord: el botón «Abrir Discord» de la ayuda del launcher.
  // Modo mantenimiento: { message } lo pone; { message: null } lo quita.
  app.put('/api/panel/maintenance', requireOwner, (req, res) => {
    const raw = req.body ? req.body.message : undefined;
    if (raw === null) {
      store.setMaintenance(null);
      return res.json(panelState());
    }
    const message = String(raw || '').replace(/\s+/g, ' ').trim();
    if (message.length < 3 || message.length > 200) throw new HttpError(400, 'El aviso debe tener entre 3 y 200 letras.');
    store.setMaintenance(message);
    res.json(panelState());
  });

  // Vacía el historial de los modpacks para recuperar espacio.
  app.delete('/api/panel/history', requireOwner, (req, res) => {
    store.clearHistory();
    res.json(panelState());
  });

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
  // Sin caché de tiempo fijo: el navegador comprueba en cada visita si el
  // panel ha cambiado (con ETag), para que tras un despliegue no siga
  // enseñando la versión anterior. Las fuentes no cambian y sí se guardan.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      extensions: ['html'],
      setHeaders: (res, file) => {
        res.setHeader('Cache-Control', /\.woff2$/.test(file) ? 'public, max-age=2592000' : 'no-cache');
      },
    }),
  );

  // biome-ignore lint/correctness/noUnusedVariables: Express reconoce el manejador de errores por sus 4 argumentos
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[ERROR]', err);
    const message =
      err instanceof HttpError ? err.message : status < 500 ? 'Petición no válida.' : 'Error interno del servidor.';
    res.status(status).json({ error: message, ...(err instanceof HttpError && err.extra ? err.extra : {}) });
  });

  return app;
}

module.exports = { createApp };
