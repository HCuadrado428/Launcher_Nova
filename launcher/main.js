const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, protocol, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { autoUpdater } = require('electron-updater');
const { Auth } = require('msmc');

const { loadConfig, saveConfig } = require('./main/config');
const { GAME_ROOT, RUNTIME_DIR, instanceDir } = require('./main/paths');
const { DEFAULT_BACKEND_URL, SERVER_ADDRESS, WEB_URL } = require('./main/constants');
const api = require('./main/api');
const { syncMods, loadMeta, saveMeta, safeModFilename, modKey, META_FILE } = require('./main/sync');
const { ensureForge } = require('./main/forge');
const { ensureJava } = require('./main/java');
const { launchGame } = require('./main/launch');
const { analyzeCrash } = require('./main/crash');
const { memoryPlan } = require('./main/memory');
const { listScreenshots, shotPath, screenshotsDir, addPlaytime } = require('./main/screenshots');
const { writeLogsZip, collectLogFiles } = require('./main/logs');
const i18n = require('./i18n');

const { t } = i18n;

const ICON_PATH = path.join(__dirname, 'build', 'icon.png');
// El token de Minecraft dura 24 h; pasado este tiempo se renueva antes de jugar.
const MS_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let mainWindow = null;
let gameProcess = null;
let busy = false; // hay una preparación/lanzamiento en marcha
// Invitación al Discord que da el backend (se comprueba antes de abrirla).
const DISCORD_URL_RE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]{2,40}$/;
let discordUrl = '';
let stoppedByUser = false; // el jugador ha pulsado «Cerrar juego»
let gameStartedAt = 0;
// Salida del juego de la sesión actual, para incluirla al guardar registros.
const MAX_GAME_LOG_LINES = 4000;
let gameLog = [];

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function backendUrl() {
  return api.cleanBaseUrl(loadConfig().backendUrl || DEFAULT_BACKEND_URL);
}

// Colores de la interfaz que puede elegir el jugador (el primero es el de serie).
const THEMES = ['emerald', 'end', 'nether', 'ocean', 'gold'];

// Tamaños de texto de Ajustes: multiplican la ampliación de la interfaz.
const TEXT_SCALES = { 1: 1, 2: 1.15, 3: 1.3 };

function textSize() {
  const size = Number(loadConfig().textSize);
  return TEXT_SCALES[size] ? size : 1;
}

function settings() {
  const cfg = loadConfig();
  return {
    ...memoryPlan(os.totalmem(), cfg),
    javaPath: cfg.javaPath || '',
    joinServer: cfg.joinServer === true,
    language: i18n.getLanguage(),
    textSize: textSize(),
    theme: THEMES.includes(cfg.theme) ? cfg.theme : THEMES[0],
    calm: cfg.calm === true,
    backendUrl: backendUrl(),
    backendConfigured: !backendUrl().includes('CAMBIA-ESTO'),
  };
}

// Lo que ve la interfaz de la cuenta: nunca los tokens.
function publicAccount(account) {
  if (!account) return null;
  return {
    type: account.type,
    username: account.username,
    uuid: account.uuid || null,
    admin: Boolean(account.player && account.player.admin),
  };
}

// ============================================================================
// SESIÓN
// ============================================================================

async function microsoftTokens(xbox) {
  const minecraft = await xbox.getMinecraft();
  return { mclcAuth: minecraft.mclc(), msRefreshToken: xbox.save(), msTokenAt: Date.now() };
}

// Renueva el token de Minecraft con el refresh token guardado, sin volver a
// abrir la ventana de Microsoft.
async function refreshMicrosoft(account, { force = false } = {}) {
  if (account.type !== 'microsoft') return account;
  if (!force && Date.now() - (account.msTokenAt || 0) < MS_TOKEN_MAX_AGE_MS) return account;
  if (!account.msRefreshToken) throw new Error(t('err.msExpired'));
  let tokens;
  try {
    tokens = await microsoftTokens(await new Auth('select_account').refresh(account.msRefreshToken));
  } catch (err) {
    console.warn('[AVISO] No se pudo renovar la sesión de Microsoft:', err);
    throw new Error(t('err.msExpired'), { cause: err });
  }
  const updated = { ...account, ...tokens, username: tokens.mclcAuth.name };
  saveConfig({ account: updated });
  return updated;
}

// Abre sesión en el backend con la cuenta guardada y la deja en la config.
async function backendLogin(account) {
  let result;
  if (account.type === 'microsoft') {
    result = await api.loginMicrosoft(backendUrl(), account.mclcAuth.access_token);
  } else {
    result = await api.loginOffline(backendUrl(), account.username);
  }
  const updated = { ...account, sessionToken: result.token, player: result.player };
  saveConfig({ account: updated });
  return updated;
}

// Ejecuta una llamada autenticada al backend. Si la sesión ha caducado (401)
// se vuelve a abrir sola una vez, renovando antes el token de Microsoft.
async function withSession(call) {
  let account = loadConfig().account;
  if (!account) throw new Error(t('err.notLogged'));
  if (!account.sessionToken) account = await backendLogin(await refreshMicrosoft(account));
  try {
    return await call(account.sessionToken);
  } catch (err) {
    if (err.status !== 401) throw err;
    try {
      account = await backendLogin(await refreshMicrosoft(account));
    } catch (loginErr) {
      if (loginErr.status === 401) account = await backendLogin(await refreshMicrosoft(account, { force: true }));
      else throw loginErr;
    }
    return call(account.sessionToken);
  }
}

ipcMain.handle('login-microsoft', async () => {
  let tokens;
  try {
    tokens = await microsoftTokens(await new Auth('select_account').launch('electron'));
  } catch (err) {
    // msmc lanza un código tipo "error.gui.closed" si se cierra la ventana.
    // (unas veces como texto y otras como objeto { ts }).
    const code = String((err && (err.ts || err.message)) || err || '');
    if (code.includes('gui.closed')) return { ok: false, cancelled: true };
    console.error('[ERROR] Login con Microsoft:', err);
    const noGame = code.includes('profile') || code.includes('ownership');
    return {
      ok: false,
      message: t(noGame ? 'err.noGame' : 'err.msFailed'),
    };
  }
  let account = {
    type: 'microsoft',
    username: tokens.mclcAuth.name,
    uuid: tokens.mclcAuth.uuid,
    ...tokens,
  };
  saveConfig({ account });
  let warning = null;
  try {
    account = await backendLogin(account);
  } catch (err) {
    warning = err.message;
  }
  return { ok: true, account: publicAccount(account), warning };
});

ipcMain.handle('login-offline', async (event, username) => {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    return { ok: false, message: t('err.nick') };
  }
  let account = { type: 'offline', username: name, uuid: null };
  saveConfig({ account });
  let warning = null;
  try {
    account = await backendLogin(account);
  } catch (err) {
    warning = err.message;
  }
  return { ok: true, account: publicAccount(account), warning };
});

ipcMain.handle('logout', () => {
  saveConfig({ account: null });
  return true;
});

// ============================================================================
// ESTADO Y MODPACKS
// ============================================================================

ipcMain.handle('get-state', () => ({
  account: publicAccount(loadConfig().account),
  settings: settings(),
  version: app.getVersion(),
  serverAddress: SERVER_ADDRESS,
  selectedModpack: loadConfig().selectedModpack || 'normal',
  playtime: loadConfig().playtime || {},
  gameRunning: Boolean(gameProcess),
}));

// Lista de modpacks a los que tiene acceso la cuenta, con su estado local
// (sin instalar / hay actualización / al día).
ipcMain.handle('get-modpacks', async () => {
  let data;
  try {
    data = await withSession((token) => api.listModpacks(backendUrl(), token));
  } catch (err) {
    // Acceso suspendido desde el panel: la interfaz lo explica con su fecha y motivo.
    if (err.data && err.data.code === 'banned') {
      return { banned: { until: err.data.until || null, reason: err.data.reason || '' } };
    }
    throw err;
  }
  discordUrl = DISCORD_URL_RE.test(data.discordUrl || '') ? data.discordUrl : '';
  const cfg = loadConfig();
  if (cfg.account) saveConfig({ account: { ...cfg.account, player: data.player } });
  return {
    account: publicAccount(loadConfig().account),
    news: data.news || null,
    event: data.event || null,
    hasDiscord: Boolean(discordUrl),
    phrases: Array.isArray(data.phrases) ? data.phrases.filter((p) => typeof p === 'string').slice(0, 60) : [],
    modpacks: data.modpacks.map((modpack) => {
      const meta = loadMeta(instanceDir(modpack.id));
      let status = 'update';
      if (!meta.versionHash && meta.mods.length === 0) status = 'not-installed';
      else if (meta.versionHash === modpack.versionHash) status = 'ready';
      return { ...modpack, status };
    }),
  };
});

ipcMain.handle('select-modpack', (event, id) => {
  saveConfig({ selectedModpack: String(id) });
  return true;
});

ipcMain.handle('server-status', async () => {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(SERVER_ADDRESS)}`, {
      headers: { 'User-Agent': `NovaLauncher/${app.getVersion()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Algunos servidores no dan la lista de nombres: entonces solo hay número.
    const list = data.players && Array.isArray(data.players.list) ? data.players.list : [];
    return {
      online: Boolean(data.online),
      players: data.players && Number.isFinite(data.players.online) ? data.players.online : null,
      max: data.players && Number.isFinite(data.players.max) ? data.players.max : null,
      names: list
        .map((player) => (player && typeof player.name === 'string' ? player.name : ''))
        .filter((name) => /^[A-Za-z0-9_]{1,16}$/.test(name))
        .slice(0, 24),
    };
  } catch {
    return null;
  }
});

// ============================================================================
// MODS DEL JUGADOR
// ============================================================================

// Mods opcionales que este jugador ha desactivado, por modpack.
function disabledMods(modpackId) {
  const all = loadConfig().disabledMods || {};
  return Array.isArray(all[modpackId]) ? all[modpackId] : [];
}

// Hace que el modpack figure como pendiente de sincronizar, para que la
// interfaz avise de que el cambio se aplica al pulsar Jugar.
function markPendingSync(modpackId) {
  const dir = instanceDir(modpackId);
  const meta = loadMeta(dir);
  if (meta.versionHash) saveMeta(dir, { ...meta, versionHash: null });
}

async function fetchManifest(modpackId) {
  return withSession((token) => api.getManifest(backendUrl(), token, modpackId));
}

function ownModFiles(modpackId, manifest) {
  const modsDir = path.join(instanceDir(modpackId), 'mods');
  const packFiles = new Set(manifest.mods.map((m) => m.filename.toLowerCase()));
  let names = [];
  try {
    names = fs.readdirSync(modsDir);
  } catch {
    // La carpeta aún no existe: no hay mods propios.
  }
  return names
    .filter((name) => safeModFilename(name) && !packFiles.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({ filename, size: fs.statSync(path.join(modsDir, filename)).size }));
}

// Lo que enseña la ventana «Mods»: los opcionales del modpack (con si están
// activados) y los que el jugador ha añadido por su cuenta.
async function modsView(modpackId) {
  const manifest = await fetchManifest(modpackId);
  const off = new Set(disabledMods(modpackId));
  return {
    optional: manifest.mods
      .filter((m) => m.optional)
      .map((m) => ({
        key: modKey(m),
        filename: m.filename,
        label: m.label || '',
        description: m.description || '',
        size: m.size,
        enabled: !off.has(modKey(m)),
      })),
    own: ownModFiles(modpackId, manifest),
  };
}

ipcMain.handle('get-mods', (event, modpackId) => modsView(String(modpackId)));

ipcMain.handle('set-mod-enabled', (event, { modpackId, key, enabled }) => {
  const id = String(modpackId);
  instanceDir(id); // valida el id
  const next = new Set(disabledMods(id));
  if (enabled) next.delete(String(key));
  else next.add(String(key));
  saveConfig({ disabledMods: { ...(loadConfig().disabledMods || {}), [id]: [...next] } });
  markPendingSync(id);
  return true;
});

// Copia a la carpeta de mods los .jar que elija el jugador. No deja pisar un
// mod del modpack: la sincronización lo trataría como suyo.
ipcMain.handle('add-own-mods', async (event, modpackId) => {
  const id = String(modpackId);
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.pickMods'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Mods', extensions: ['jar'] }],
  });
  if (picked.canceled) return { added: [], skipped: [] };
  const manifest = await fetchManifest(id);
  const packFiles = new Set(manifest.mods.map((m) => m.filename.toLowerCase()));
  const modsDir = path.join(instanceDir(id), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const added = [];
  const skipped = [];
  for (const source of picked.filePaths) {
    const filename = path.basename(source);
    if (!safeModFilename(filename) || packFiles.has(filename.toLowerCase())) {
      skipped.push(filename);
      continue;
    }
    fs.copyFileSync(source, path.join(modsDir, filename));
    added.push(filename);
  }
  return { added, skipped };
});

ipcMain.handle('remove-own-mod', async (event, { modpackId, filename }) => {
  const id = String(modpackId);
  const name = String(filename);
  const manifest = await fetchManifest(id);
  // Solo se pueden borrar desde aquí los mods que NO son del modpack.
  if (!ownModFiles(id, manifest).some((m) => m.filename === name)) throw new Error(t('err.notYourMod'));
  fs.rmSync(path.join(instanceDir(id), 'mods', name), { force: true });
  return true;
});

// ============================================================================
// CAPTURAS DE PANTALLA
// ============================================================================

// Las miniaturas se sirven a la ventana por un protocolo propio
// (nova-shot://thumb/<modpack>/<archivo>): la ventana no puede leer el disco,
// y así tampoco puede pedir nada que no sea una captura.
protocol.registerSchemesAsPrivileged([{ scheme: 'nova-shot', privileges: { standard: true, secure: true } }]);

const THUMB_WIDTH = 480;
const thumbCache = new Map();

function thumbnail(file) {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (!thumbCache.has(key)) {
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) return null;
    const { width } = image.getSize();
    const small = width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image;
    if (thumbCache.size > 300) thumbCache.clear();
    thumbCache.set(key, small.toJPEG(82));
  }
  return thumbCache.get(key);
}

function registerShotProtocol() {
  protocol.handle('nova-shot', (request) => {
    try {
      const url = new URL(request.url);
      const [modpackId, name] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const file = url.hostname === 'thumb' ? shotPath(instanceDir(modpackId), name) : null;
      const jpeg = file ? thumbnail(file) : null;
      if (!jpeg) return new Response(null, { status: 404 });
      return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

function shotOrThrow(modpackId, name) {
  const file = shotPath(instanceDir(String(modpackId)), name);
  if (!file) throw new Error(t('err.shotGone'));
  return file;
}

ipcMain.handle('list-screenshots', (event, modpackId) => listScreenshots(instanceDir(String(modpackId))));
ipcMain.handle('open-screenshot', (event, { modpackId, name }) => shell.openPath(shotOrThrow(modpackId, name)));
ipcMain.handle('copy-screenshot', (event, { modpackId, name }) => {
  clipboard.writeImage(nativeImage.createFromPath(shotOrThrow(modpackId, name)));
  return true;
});
// Borrar manda la captura a la papelera: se puede recuperar.
ipcMain.handle('delete-screenshot', async (event, { modpackId, name }) => {
  await shell.trashItem(shotOrThrow(modpackId, name));
  return true;
});
ipcMain.handle('open-screenshots-folder', (event, modpackId) => {
  const dir = screenshotsDir(instanceDir(String(modpackId)));
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// ============================================================================
// JUGAR
// ============================================================================

// La preparación se cuenta al jugador en cinco pasos fijos, para que sepa por
// dónde va aunque alguno (Java, el juego) ya esté hecho y pase al instante.
const PLAY_STEPS = 5;

async function play(modpackId) {
  const progress = (step, label, percent = null) =>
    send('play-progress', { step, total: PLAY_STEPS, label, percent });
  const cfg = settings();
  const dir = instanceDir(modpackId);

  progress(1, t('prog.checkPack'));
  const manifest = await withSession((token) => api.getManifest(backendUrl(), token, modpackId));
  if (manifest.loader !== 'forge') throw new Error(t('err.onlyForge'));

  progress(2, t('prog.javaReady'));
  const java = await ensureJava({
    runtimeDir: RUNTIME_DIR,
    mcVersion: manifest.mcVersion,
    customPath: cfg.javaPath,
    onProgress: (p) => progress(2, p.label, p.percent),
  });
  if (java.warning) {
    send('game-log', t('warn.java', { mc: manifest.mcVersion, wanted: java.warning.wanted, found: java.warning.found }));
  }

  progress(3, t('prog.gameReady'));
  const versionId = await ensureForge({
    root: GAME_ROOT,
    mcVersion: manifest.mcVersion,
    forgeVersion: manifest.loaderVersion,
    javaPath: java.javaPath,
    onProgress: (p) => progress(3, p.label, p.percent),
  });

  progress(4, t('prog.syncMods'));
  const result = await syncMods({
    instanceDir: dir,
    manifest,
    disabled: disabledMods(modpackId),
    download: (mod, dest) =>
      withSession((token) => api.downloadMod(backendUrl(), token, modpackId, mod.sha1, dest)),
    onProgress: ({ doneFiles, totalFiles, doneBytes, totalBytes }) => {
      if (totalFiles === 0) return;
      progress(
        4,
        t('prog.mods', { done: doneFiles, total: totalFiles }),
        totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : Math.round((doneFiles / totalFiles) * 100),
      );
    },
  });
  send('modpack-synced', { id: modpackId, ...result });

  progress(5, t('prog.msLogin'));
  const account = await refreshMicrosoft(loadConfig().account);
  progress(5, t('prog.starting'));
  gameLog = [];
  stoppedByUser = false;
  gameStartedAt = Date.now();
  gameProcess = await launchGame(
    {
      account,
      gameRoot: GAME_ROOT,
      // Cada modpack tiene su propia carpeta de juego (mods, mundos, opciones),
      // pero comparten versiones, librerías y assets.
      instanceDir: dir,
      versionId,
      javaPath: java.javaPath,
      memoryGb: cfg.memoryGb,
      serverAddress: SERVER_ADDRESS,
      // El modpack admin abre siempre en el menú normal de Minecraft: ahí está
      // el mod para cambiar de cuenta. El normal abre en el menú de NOVA 2.
      joinOnStart: cfg.joinServer && modpackId !== 'admin',
      freeMenu: modpackId === 'admin',
    },
    {
      onLog: (line) => {
        gameLog.push(line);
        if (gameLog.length > MAX_GAME_LOG_LINES) gameLog.splice(0, gameLog.length - MAX_GAME_LOG_LINES);
        send('game-log', line);
      },
      onClose: (code) => {
        gameProcess = null;
        // Cierre con error (y no porque el jugador lo haya cerrado desde el
        // launcher): se mira si el juego ha dejado un informe.
        const failed = code !== 0 && !stoppedByUser;
        const crash = failed ? analyzeCrash({ instanceDir: dir, since: gameStartedAt - 5000, logLines: gameLog }) : null;
        const playtime = addPlaytime(loadConfig().playtime, modpackId, gameStartedAt, Date.now());
        saveConfig({ playtime });
        send('game-closed', { code, crash, modpackId, playtime });
      },
    },
  );
  send('game-started', { id: modpackId });
}

ipcMain.handle('play', async (event, modpackId) => {
  if (busy || gameProcess) return { ok: false, message: t('err.busy') };
  busy = true;
  try {
    await play(String(modpackId));
    return { ok: true };
  } catch (err) {
    console.error('[ERROR] No se pudo lanzar el juego:', err);
    // 403 = la cuenta ya no tiene acceso a ese modpack (p.ej. dejó de ser admin).
    return { ok: false, message: err.message || String(err), accessLost: err.status === 403 };
  } finally {
    busy = false;
  }
});

ipcMain.handle('stop-game', () => {
  if (gameProcess) {
    stoppedByUser = true;
    gameProcess.kill();
  }
  return true;
});

// ============================================================================
// AJUSTES
// ============================================================================

ipcMain.handle('save-settings', (event, partial = {}) => {
  const next = {};
  const previousTextSize = textSize();
  if (partial.memoryAuto !== undefined) next.memoryAuto = Boolean(partial.memoryAuto);
  if (partial.memoryGb !== undefined) next.memoryGb = Math.round(Number(partial.memoryGb)) || 4;
  if (partial.theme !== undefined) next.theme = THEMES.includes(partial.theme) ? partial.theme : THEMES[0];
  if (partial.calm !== undefined) next.calm = Boolean(partial.calm);
  if (partial.textSize !== undefined) next.textSize = TEXT_SCALES[Number(partial.textSize)] ? Number(partial.textSize) : 1;
  if (partial.javaPath !== undefined) next.javaPath = String(partial.javaPath).trim();
  if (partial.joinServer !== undefined) next.joinServer = Boolean(partial.joinServer);
  if (partial.language !== undefined) next.language = i18n.setLanguage(partial.language);
  if (partial.backendUrl !== undefined) {
    const url = api.cleanBaseUrl(partial.backendUrl);
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error(t('err.backendUrl'));
    next.backendUrl = url;
    // Otra dirección = otro servidor: la sesión anterior no vale.
    const cfg = loadConfig();
    if (cfg.account && url !== (cfg.backendUrl || '')) {
      next.account = { ...cfg.account, sessionToken: null, player: null };
    }
  }
  saveConfig(next);
  if (partial.textSize !== undefined && next.textSize !== previousTextSize) applyTextSize({ resize: true });
  return settings();
});

ipcMain.handle('pick-java', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.pickJava'),
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('open-folder', (event, modpackId) => {
  const dir = instanceDir(String(modpackId));
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// Reparar: olvida qué mods hay bajados para que el siguiente "Jugar" los
// compruebe y vuelva a bajar todos. No toca mundos ni opciones.
ipcMain.handle('repair', (event, modpackId) => {
  fs.rmSync(path.join(instanceDir(String(modpackId)), META_FILE), { force: true });
  return true;
});

ipcMain.handle('open-web', () => shell.openExternal(WEB_URL));
ipcMain.handle('open-discord', () => (discordUrl ? shell.openExternal(discordUrl) : false));

// Guarda en un .zip los registros del modpack, listos para mandar por Discord.
ipcMain.handle('export-logs', async (event, modpackId) => {
  const id = String(modpackId);
  const dir = instanceDir(id);
  if (collectLogFiles(dir).length === 0 && gameLog.length === 0) return { ok: false, reason: 'none' };

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: t('logs.dialog'),
    defaultPath: path.join(app.getPath('desktop'), `nova-registros-${id}-${stamp}.zip`),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, reason: 'cancelled' };

  const cfg = settings();
  const account = loadConfig().account;
  await writeLogsZip({
    dest: picked.filePath,
    instanceDir: dir,
    consoleLines: gameLog,
    info: {
      Launcher: app.getVersion(),
      Modpack: id,
      Fecha: new Date().toISOString(),
      Sistema: `${os.type()} ${os.release()} ${os.arch()}`,
      'Memoria del equipo': `${Math.round(os.totalmem() / 1024 ** 3)} GB`,
      'Memoria para el juego': `${cfg.memoryGb} GB`,
      Java: cfg.javaPath || 'automático',
      Cuenta: account ? `${account.username} (${account.type})` : 'sin sesión',
      'Opcionales desactivados': disabledMods(id).join(', ') || 'ninguno',
    },
  });
  shell.showItemInFolder(picked.filePath);
  return { ok: true };
});

// ============================================================================
// ACTUALIZACIONES DEL PROPIO LAUNCHER
// ============================================================================

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => send('update-ready', { version: info.version }));
  autoUpdater.on('error', (err) => console.warn('[AVISO] Actualizaciones:', err && err.message));
  autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.handle('install-update', () => {
  if (!gameProcess) autoUpdater.quitAndInstall();
});

// ============================================================================
// VENTANA
// ============================================================================

// Tamaño para el que está dibujada la interfaz. Con la ventana más grande
// (maximizada, pantalla completa) se amplía todo en proporción, en vez de
// dejar el contenido pequeño en una esquina.
const BASE_WIDTH = 1040;
const BASE_HEIGHT = 680;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const MAX_ZOOM = 3;

// "scale" es el tamaño de texto elegido en Ajustes: la interfaz se dibuja
// como si la ventana fuera más pequeña y luego se amplía.
function zoomFor(width, height, scale = 1) {
  const fit = Math.max(1, Math.min(width / (BASE_WIDTH * scale), height / (BASE_HEIGHT * scale)));
  return Math.min(MAX_ZOOM, fit * scale);
}

function fitZoom() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  mainWindow.webContents.setZoomFactor(zoomFor(width, height, TEXT_SCALES[textSize()]));
}

// Con el texto más grande hace falta más ventana para que quepa lo mismo: se
// sube el tamaño mínimo y, si la ventana se queda corta, se agranda (sin
// pasarse de la pantalla). Al cambiar el ajuste ("resize") la ventana se pone
// en el tamaño de ese texto, también hacia abajo: si no, al volver a un texto
// más pequeño la ventana grande lo ampliaría y no se notaría el cambio.
function applyTextSize({ resize = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = TEXT_SCALES[textSize()];
  const { workAreaSize } = screen.getDisplayMatching(mainWindow.getBounds());
  const fitScreen = (value, limit) => Math.min(Math.round(value * scale), limit);
  mainWindow.setMinimumSize(fitScreen(MIN_WIDTH, workAreaSize.width), fitScreen(MIN_HEIGHT, workAreaSize.height));
  if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
    const [width, height] = mainWindow.getContentSize();
    const wantWidth = fitScreen(BASE_WIDTH, workAreaSize.width);
    const wantHeight = fitScreen(BASE_HEIGHT, workAreaSize.height - 40);
    if (resize) mainWindow.setContentSize(wantWidth, wantHeight);
    else if (width < wantWidth || height < wantHeight) {
      mainWindow.setContentSize(Math.max(width, wantWidth), Math.max(height, wantHeight));
    }
  }
  fitZoom();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#17150f',
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => applyTextSize());
  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(event, fitZoom);
  }

  // La interfaz es local: ningún enlace debe navegar dentro de la ventana.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    // Idioma guardado o, la primera vez, el del sistema.
    i18n.setLanguage(loadConfig().language || app.getLocale());
    api.setClientVersion(app.getVersion());
    registerShotProtocol();
    Menu.setApplicationMenu(null);
    createWindow();
    setupAutoUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
