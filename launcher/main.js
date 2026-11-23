const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { autoUpdater } = require('electron-updater');
const { Auth } = require('msmc');

const { loadConfig, saveConfig } = require('./main/config');
const { GAME_ROOT, RUNTIME_DIR, instanceDir } = require('./main/paths');
const { DEFAULT_BACKEND_URL, SERVER_ADDRESS, WEB_URL } = require('./main/constants');
const api = require('./main/api');
const { syncMods, loadMeta, META_FILE } = require('./main/sync');
const { ensureForge } = require('./main/forge');
const { ensureJava } = require('./main/java');
const { launchGame } = require('./main/launch');

const ICON_PATH = path.join(__dirname, 'build', 'icon.png');
// El token de Minecraft dura 24 h; pasado este tiempo se renueva antes de jugar.
const MS_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let mainWindow = null;
let gameProcess = null;
let busy = false; // hay una preparación/lanzamiento en marcha

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function backendUrl() {
  return api.cleanBaseUrl(loadConfig().backendUrl || DEFAULT_BACKEND_URL);
}

function settings() {
  const cfg = loadConfig();
  const totalGb = Math.floor(os.totalmem() / 1024 ** 3);
  const maxGb = Math.max(2, Math.min(16, totalGb - 2));
  return {
    memoryGb: Math.min(maxGb, Math.max(2, Number(cfg.memoryGb) || Math.min(6, maxGb))),
    maxMemoryGb: maxGb,
    javaPath: cfg.javaPath || '',
    joinServer: cfg.joinServer !== false,
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
  if (!account.msRefreshToken) throw new Error('La sesión de Microsoft ha caducado. Cierra sesión y vuelve a entrar.');
  let tokens;
  try {
    tokens = await microsoftTokens(await new Auth('select_account').refresh(account.msRefreshToken));
  } catch (err) {
    console.warn('[AVISO] No se pudo renovar la sesión de Microsoft:', err);
    throw new Error('La sesión de Microsoft ha caducado. Cierra sesión y vuelve a entrar.', { cause: err });
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
  if (!account) throw new Error('No has iniciado sesión.');
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
      message: noGame
        ? 'Esa cuenta de Microsoft no tiene Minecraft Java comprado.'
        : 'No se pudo completar el inicio de sesión con Microsoft.',
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
    return { ok: false, message: 'El nick debe tener entre 3 y 16 caracteres: letras, números y _.' };
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
  gameRunning: Boolean(gameProcess),
}));

// Lista de modpacks a los que tiene acceso la cuenta, con su estado local
// (sin instalar / hay actualización / al día).
ipcMain.handle('get-modpacks', async () => {
  const data = await withSession((token) => api.listModpacks(backendUrl(), token));
  const cfg = loadConfig();
  if (cfg.account) saveConfig({ account: { ...cfg.account, player: data.player } });
  return {
    account: publicAccount(loadConfig().account),
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
    return {
      online: Boolean(data.online),
      players: data.players && Number.isFinite(data.players.online) ? data.players.online : null,
      max: data.players && Number.isFinite(data.players.max) ? data.players.max : null,
    };
  } catch {
    return null;
  }
});

// ============================================================================
// JUGAR
// ============================================================================

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

async function play(modpackId) {
  const progress = (label, percent = null) => send('play-progress', { label, percent });
  const cfg = settings();
  const dir = instanceDir(modpackId);

  progress('Comprobando el modpack');
  const manifest = await withSession((token) => api.getManifest(backendUrl(), token, modpackId));
  if (manifest.loader !== 'forge') throw new Error('Este launcher solo sabe lanzar modpacks de Forge.');

  const java = await ensureJava({
    runtimeDir: RUNTIME_DIR,
    mcVersion: manifest.mcVersion,
    customPath: cfg.javaPath,
    onProgress: (p) => progress(p.label, p.percent),
  });
  if (java.warning) {
    send('game-log', `[AVISO] Minecraft ${manifest.mcVersion} pide Java ${java.warning.wanted} y el de Ajustes es Java ${java.warning.found}. Puede que no arranque.`);
  }

  const versionId = await ensureForge({
    root: GAME_ROOT,
    mcVersion: manifest.mcVersion,
    forgeVersion: manifest.loaderVersion,
    javaPath: java.javaPath,
    onProgress: (p) => progress(p.label, p.percent),
  });

  progress('Sincronizando mods');
  const result = await syncMods({
    instanceDir: dir,
    manifest,
    download: (mod, dest) =>
      withSession((token) => api.downloadMod(backendUrl(), token, modpackId, mod.sha1, dest)),
    onProgress: ({ doneFiles, totalFiles, doneBytes, totalBytes }) => {
      if (totalFiles === 0) return;
      progress(
        `Descargando mods ${doneFiles}/${totalFiles} · ${formatMb(doneBytes)} de ${formatMb(totalBytes)}`,
        totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : Math.round((doneFiles / totalFiles) * 100),
      );
    },
  });
  send('modpack-synced', { id: modpackId, ...result });

  progress('Iniciando sesión en Minecraft');
  const account = await refreshMicrosoft(loadConfig().account);
  progress('Arrancando Minecraft');
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
      serverAddress: cfg.joinServer ? SERVER_ADDRESS : null,
    },
    {
      onLog: (line) => send('game-log', line),
      onClose: (code) => {
        gameProcess = null;
        send('game-closed', { code });
      },
    },
  );
  send('game-started', { id: modpackId });
}

ipcMain.handle('play', async (event, modpackId) => {
  if (busy || gameProcess) return { ok: false, message: 'El juego ya está abierto o preparándose.' };
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
  if (gameProcess) gameProcess.kill();
  return true;
});

// ============================================================================
// AJUSTES
// ============================================================================

ipcMain.handle('save-settings', (event, partial = {}) => {
  const next = {};
  if (partial.memoryGb !== undefined) next.memoryGb = Math.round(Number(partial.memoryGb)) || 4;
  if (partial.javaPath !== undefined) next.javaPath = String(partial.javaPath).trim();
  if (partial.joinServer !== undefined) next.joinServer = Boolean(partial.joinServer);
  if (partial.backendUrl !== undefined) {
    const url = api.cleanBaseUrl(partial.backendUrl);
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('La dirección del servidor debe empezar por https://');
    next.backendUrl = url;
    // Otra dirección = otro servidor: la sesión anterior no vale.
    const cfg = loadConfig();
    if (cfg.account && url !== (cfg.backendUrl || '')) {
      next.account = { ...cfg.account, sessionToken: null, player: null };
    }
  }
  saveConfig(next);
  return settings();
});

ipcMain.handle('pick-java', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Elige el ejecutable de Java',
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 900,
    minHeight: 600,
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
    Menu.setApplicationMenu(null);
    createWindow();
    setupAutoUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
