// ======================================================
// Interfaz del Nova Launcher
// ======================================================

const $ = (id) => document.getElementById(id);
const bridge = window.nova;
const i18n = window.NovaI18n;
const { t } = i18n;

const SERVER_REFRESH_MS = 60_000;
const MAX_LOG_LINES = 600;

let state = null; // respuesta de get-state
let modpacks = [];
let news = null;
let serverEvent = null;
let hasDiscord = false;
let serverStatus; // undefined = aún no se ha consultado
let selectedId = 'normal';
let phase = 'idle'; // idle | preparing | running
const logLines = [];

// ---------- Utilidades ----------

// Los avisos van en la capa superior del navegador (popover) para que se
// vean también con una ventana de diálogo abierta.
function toast(message, type = 'ok') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.type = type;
  el.textContent = message;
  box.append(el);
  if (box.matches(':popover-open')) box.hidePopover();
  box.showPopover();
  setTimeout(() => {
    el.remove();
    if (box.children.length === 0 && box.matches(':popover-open')) box.hidePopover();
  }, type === 'error' ? 9000 : 4500);
}

function locale() {
  return i18n.LOCALES[i18n.getLanguage()];
}

function formatSize(bytes) {
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

// Los errores que cruzan desde el proceso principal llegan con un prefijo
// técnico ("Error invoking remote method..."): nos quedamos con el mensaje.
function errorText(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function setView(view) {
  document.body.dataset.view = view;
}

// ---------- Idioma ----------

// Rellena los textos fijos del HTML (data-i18n / data-i18n-attr).
function applyStaticTexts() {
  document.documentElement.lang = i18n.getLanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split('|')) {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr, t(key));
    }
  }
}

// Repinta todo lo que depende del idioma.
function applyLanguage() {
  applyStaticTexts();
  if (state && state.account) renderAccount();
  renderServerStatus();
  if (modpacks.length > 0) renderModpacks();
  renderInfo();
  renderPlayButton();
  renderUpdate();
}

// ---------- Cuenta ----------

function renderAccount() {
  const account = state.account;
  if (!account) return;
  $('accountName').textContent = account.username;
  $('accountType').textContent = t(account.type === 'microsoft' ? 'account.microsoft' : 'account.offline');
  $('adminBadge').hidden = !account.admin;

  const avatar = $('avatar');
  if (avatar.dataset.user === account.username) return;
  avatar.dataset.user = account.username;
  avatar.textContent = account.username[0].toUpperCase();
  if (account.type === 'microsoft' && account.uuid) {
    const img = new Image();
    img.alt = '';
    img.onload = () => {
      if (avatar.dataset.user === account.username) avatar.replaceChildren(img);
    };
    img.src = `https://mc-heads.net/avatar/${encodeURIComponent(account.uuid)}/80`;
  }
}

async function enterMain() {
  setView('main');
  renderAccount();
  $('versionLabel').textContent = `v${state.version}`;
  $('copyIpBtn').textContent = state.serverAddress;
  refreshServerStatus();
  await loadModpacks();
}

function showLoginError(message) {
  $('loginError').textContent = message || '';
  $('loginError').hidden = !message;
}

async function handleLogin(result) {
  if (!result.ok) {
    if (!result.cancelled) showLoginError(result.message);
    return;
  }
  showLoginError('');
  state.account = result.account;
  await enterMain();
}

$('msLoginBtn').addEventListener('click', async () => {
  const button = $('msLoginBtn');
  button.disabled = true;
  button.textContent = t('login.microsoftOpening');
  try {
    await handleLogin(await bridge.loginMicrosoft());
  } catch (err) {
    showLoginError(errorText(err));
  } finally {
    button.disabled = false;
    button.textContent = t('login.microsoft');
  }
});

$('offlineForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('offlineLoginBtn');
  button.disabled = true;
  try {
    await handleLogin(await bridge.loginOffline($('offlineNick').value));
  } catch (err) {
    showLoginError(errorText(err));
  } finally {
    button.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  if (phase !== 'idle') {
    toast(t('play.closeFirst'), 'error');
    return;
  }
  await bridge.logout();
  state.account = null;
  modpacks = [];
  delete $('avatar').dataset.user;
  setView('login');
});

// ---------- Servidor ----------

function renderServerStatus() {
  const box = $('serverBox');
  if (serverStatus === undefined) {
    box.dataset.state = 'unknown';
    $('serverText').textContent = t('server.checking');
  } else if (!serverStatus) {
    box.dataset.state = 'unknown';
    $('serverText').textContent = t('server.noData');
  } else if (serverStatus.online) {
    box.dataset.state = 'online';
    $('serverText').textContent =
      serverStatus.players === null
        ? t('server.online')
        : t('server.onlineCount', { online: serverStatus.players, max: serverStatus.max });
  } else {
    box.dataset.state = 'offline';
    $('serverText').textContent = t('server.offline');
  }
}

async function refreshServerStatus() {
  serverStatus = await bridge.serverStatus().catch(() => null);
  renderServerStatus();
}
setInterval(() => {
  if (document.body.dataset.view === 'main' && !document.hidden) refreshServerStatus();
}, SERVER_REFRESH_MS);

$('copyIpBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.serverAddress);
    toast(t('server.ipCopied'));
  } catch {
    toast(state.serverAddress);
  }
});

$('webBtn').addEventListener('click', () => bridge.openWeb());

// ---------- Novedades y evento ----------

// Cuenta atrás del próximo evento: "2 d 03 h 15 min" y, el último día, con
// segundos. Durante el evento dice que ya ha llegado la hora; después se quita.
function renderEvent() {
  const card = $('eventCard');
  if (!serverEvent) {
    card.hidden = true;
    return false;
  }
  const start = new Date(serverEvent.start).getTime();
  const end = start + (serverEvent.hours || 3) * 3_600_000;
  const now = Date.now();
  if (Number.isNaN(start) || now >= end) {
    card.hidden = true;
    return false;
  }
  $('eventName').textContent = serverEvent.name;
  if (now >= start) {
    $('eventCountdown').textContent = t('event.now');
  } else {
    const total = Math.floor((start - now) / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    $('eventCountdown').textContent =
      days > 0 ? `${days} d ${pad(hours)} h ${pad(minutes)} min` : `${pad(hours)} h ${pad(minutes)} min ${pad(total % 60)} s`;
  }
  $('eventLocal').textContent = t('event.local', {
    local: new Date(start).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  });
  card.hidden = false;
  return true;
}

function renderInfo() {
  const hasEvent = renderEvent();
  const hasNews = Boolean(news && news.text);
  $('newsCard').hidden = !hasNews;
  if (hasNews) {
    $('newsText').textContent = news.text;
    $('newsDate').textContent = formatDate(news.updatedAt) || '';
  }
  $('infoBox').hidden = !(hasEvent || hasNews) || !$('stageEmpty').hidden;
}
setInterval(() => {
  if (serverEvent && document.body.dataset.view === 'main' && !document.hidden) renderInfo();
}, 1000);

// ---------- Modpacks ----------

function showStageError(title, text) {
  $('hero').hidden = true;
  $('launchBox').hidden = true;
  $('infoBox').hidden = true;
  $('packTabs').replaceChildren();
  $('stageEmpty').hidden = false;
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

async function loadModpacks() {
  if (!state.settings.backendConfigured) {
    modpacks = [];
    showStageError(t('stage.noBackend.title'), t('stage.noBackend.text'));
    return;
  }
  try {
    const data = await bridge.getModpacks();
    if (data.banned) {
      modpacks = [];
      const until = data.banned.until
        ? t('ban.until', { date: new Date(data.banned.until).toLocaleString(locale(), { dateStyle: 'long', timeStyle: 'short' }) })
        : t('ban.forever');
      const reason = data.banned.reason ? ` ${t('ban.reason', { reason: data.banned.reason })}` : '';
      showStageError(t('ban.title'), `${until}${reason}`);
      return;
    }
    modpacks = data.modpacks;
    news = data.news;
    serverEvent = data.event;
    hasDiscord = Boolean(data.hasDiscord);
    $('helpDiscord').hidden = !hasDiscord;
    $('crashDiscord').hidden = !hasDiscord;
    state.account = data.account;
    renderAccount();
  } catch (err) {
    modpacks = [];
    showStageError(t('stage.lost.title'), errorText(err));
    return;
  }
  if (!modpacks.some((m) => m.id === selectedId)) selectedId = 'normal';
  $('stageEmpty').hidden = true;
  $('hero').hidden = false;
  $('launchBox').hidden = false;
  renderModpacks();
  renderInfo();
}

function renderModpacks() {
  // Las pestañas solo salen si hay más de un modpack (cuentas admin).
  const tabs = $('packTabs');
  if (modpacks.length > 1) {
    tabs.replaceChildren(
      ...modpacks.map((modpack) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab';
        tab.dataset.pack = modpack.id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(modpack.id === selectedId));
        const name = document.createElement('strong');
        name.textContent = modpack.name;
        const meta = document.createElement('span');
        meta.textContent = t('pack.mods', { n: modpack.modCount });
        tab.append(name, meta);
        return tab;
      }),
    );
  } else {
    tabs.replaceChildren();
  }

  const modpack = modpacks.find((m) => m.id === selectedId);
  if (!modpack) return;
  document.querySelector('.stage').dataset.pack = modpack.id;
  $('packTag').textContent = t(i18n.LANGUAGES.es[`pack.tag.${modpack.id}`] ? `pack.tag.${modpack.id}` : 'pack.tag.other');
  $('packTitle').textContent = modpack.name;
  $('packDesc').textContent = modpack.description;

  const chips = [
    `Minecraft ${modpack.mcVersion}`,
    `Forge${modpack.loaderVersion ? ` ${modpack.loaderVersion}` : ''}`,
    t('pack.mods', { n: modpack.modCount }),
  ];
  if (modpack.totalSize > 0) chips.push(formatSize(modpack.totalSize));
  const updated = formatDate(modpack.updatedAt);
  if (updated) chips.push(t('pack.updatedOn', { date: updated }));
  $('packChips').replaceChildren(
    ...chips.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );

  const stateEl = $('packState');
  if (modpack.modCount === 0) {
    stateEl.dataset.status = '';
    stateEl.textContent = t('pack.empty');
  } else {
    stateEl.dataset.status = modpack.status;
    stateEl.textContent = t(`pack.status.${modpack.status}`);
  }
  renderPlayButton();
}

$('packTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || phase !== 'idle') return;
  selectedId = tab.dataset.pack;
  bridge.selectModpack(selectedId);
  renderModpacks();
});

$('retryBtn').addEventListener('click', loadModpacks);

// Al volver a la ventana se mira si el dueño ha actualizado algún modpack (o
// si la cuenta ha pasado a ser admin).
let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  if (document.body.dataset.view !== 'main' || phase !== 'idle' || !state.settings.backendConfigured) return;
  if (Date.now() - lastFocusRefresh < 20_000) return;
  lastFocusRefresh = Date.now();
  loadModpacks();
});

// ---------- Jugar ----------

function renderPlayButton() {
  const button = $('playBtn');
  const modpack = modpacks.find((m) => m.id === selectedId);
  if (phase === 'running') {
    button.textContent = t('play.close');
    button.disabled = false;
  } else if (phase === 'preparing') {
    button.textContent = t('play.preparing');
    button.disabled = true;
  } else {
    button.textContent = t(modpack && modpack.status === 'ready' ? 'play.play' : 'play.install');
    button.disabled = !modpack;
  }
}

// step/total: «Paso 2 de 5» delante del texto (se omite si no hay paso).
function setProgress(label, percent, step, total) {
  $('progressBox').hidden = false;
  $('progressStep').textContent = step ? `${t('prog.step', { n: step, total })} · ` : '';
  $('progressLabel').textContent = label;
  const bar = $('progressBar');
  const known = typeof percent === 'number';
  bar.classList.toggle('indeterminate', !known);
  $('progressFill').style.width = known ? `${percent}%` : '';
  if (known) bar.setAttribute('aria-valuenow', String(percent));
  else bar.removeAttribute('aria-valuenow');
}

function addLog(line) {
  logLines.push(line.replace(/\s+$/, ''));
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  const pre = $('consoleLog');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = logLines.join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

$('playBtn').addEventListener('click', async () => {
  if (phase === 'running') {
    bridge.stopGame();
    return;
  }
  if (phase !== 'idle') return;
  phase = 'preparing';
  // La primera instalación es larga: se avisa para que nadie piense que se ha colgado.
  const current = modpacks.find((m) => m.id === selectedId);
  $('progressHint').hidden = !(current && current.status === 'not-installed');
  logLines.length = 0;
  $('consoleLog').textContent = '';
  renderPlayButton();
  setProgress(t('play.preparingLabel'), null);

  let result;
  try {
    result = await bridge.play(selectedId);
  } catch (err) {
    result = { ok: false, message: errorText(err) };
  }
  if (!result.ok) {
    phase = 'idle';
    $('progressBox').hidden = true;
    toast(result.message, 'error');
    // Recargar la lista: si se ha perdido el acceso al modpack, desaparece.
    await loadModpacks();
    renderPlayButton();
  }
});

bridge.onPlayProgress(({ label, percent, step, total }) => {
  if (phase === 'preparing') setProgress(label, percent, step, total);
});

bridge.onGameStarted(() => {
  phase = 'running';
  $('progressHint').hidden = true;
  setProgress(t('play.running'), 100);
  renderPlayButton();
  loadModpacks();
});

bridge.onGameClosed(({ code, crash, modpackId }) => {
  phase = 'idle';
  $('progressBox').hidden = true;
  renderPlayButton();
  if (crash) showCrash(code, crash, modpackId);
});

bridge.onGameLog(addLog);

// ---------- Registros ----------

// Guarda el .zip de registros. Devuelve el texto del error, o '' si ha ido
// bien o se ha cancelado.
async function saveLogs(modpackId) {
  try {
    const result = await bridge.exportLogs(modpackId);
    if (result.ok) toast(t('logs.saved'));
    else if (result.reason === 'none') return t('logs.none');
    return '';
  } catch (err) {
    return errorText(err);
  }
}

// ---------- Ayuda ----------

const helpDialog = $('helpDialog');
$('helpBtn').addEventListener('click', () => {
  $('helpError').hidden = true;
  helpDialog.showModal();
});
$('helpClose').addEventListener('click', () => helpDialog.close());
$('helpSave').addEventListener('click', async () => {
  const error = await saveLogs(selectedId);
  $('helpError').textContent = error;
  $('helpError').hidden = !error;
});
for (const id of ['helpDiscord', 'crashDiscord']) $(id).addEventListener('click', () => bridge.openDiscord());

// ---------- Cierre por error ----------

const crashDialog = $('crashDialog');
let crashModpackId = null;

function showCrash(code, crash, modpackId) {
  crashModpackId = modpackId || selectedId;
  $('crashCode').textContent = t('crash.code', { code: code === null ? '—' : code });
  $('crashWhat').textContent = crash.description || t('crash.noReport');
  $('crashException').textContent = crash.exception || '';
  $('crashException').hidden = !crash.exception;
  $('crashSuspects').replaceChildren(
    ...crash.suspects.map((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      return li;
    }),
  );
  $('crashSuspectsBox').hidden = crash.suspects.length === 0;
  $('crashOom').hidden = !crash.outOfMemory;
  $('crashError').hidden = true;
  $('consoleBox').open = true;
  if (!crashDialog.open) crashDialog.showModal();
}

$('crashClose').addEventListener('click', () => crashDialog.close());
$('crashSave').addEventListener('click', async () => {
  const error = await saveLogs(crashModpackId);
  $('crashError').textContent = error;
  $('crashError').hidden = !error;
});

// ---------- Ajustes ----------

const dialog = $('settingsDialog');

$('languageSelect').replaceChildren(
  ...Object.entries(i18n.NAMES).map(([code, name]) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    return option;
  }),
);

function showSettingsError(message) {
  $('settingsError').textContent = message;
  $('settingsError').hidden = !message;
}

function openSettings() {
  const s = state.settings;
  $('memoryRange').max = String(s.maxMemoryGb);
  $('memoryAutoCheck').checked = s.memoryAuto;
  $('memoryLow').hidden = !s.lowMemory;
  $('textSizeSelect').value = String(s.textSize);
  syncMemoryControls(s.memoryGb);
  $('joinServerCheck').checked = s.joinServer;
  $('javaPath').value = s.javaPath;
  $('languageSelect').value = i18n.getLanguage();
  $('backendUrl').value = s.backendConfigured ? s.backendUrl : '';
  $('packActions').hidden = document.body.dataset.view !== 'main' || modpacks.length === 0;
  showSettingsError('');
  dialog.showModal();
}

for (const button of document.querySelectorAll('[data-open-settings]')) button.addEventListener('click', openSettings);
$('settingsCancel').addEventListener('click', () => dialog.close());
// En automático el deslizador enseña lo que ha elegido el launcher y no se
// puede mover; al desmarcar la casilla se queda en ese valor para ajustarlo.
function syncMemoryControls(valueGb) {
  const auto = $('memoryAutoCheck').checked;
  const value = auto ? state.settings.recommendedMemoryGb : valueGb;
  $('memoryRange').disabled = auto;
  $('memoryRange').value = String(value);
  $('memoryOut').textContent = `${value} GB`;
}
$('memoryAutoCheck').addEventListener('change', () => syncMemoryControls(Number($('memoryRange').value)));
$('memoryRange').addEventListener('input', (e) => {
  $('memoryOut').textContent = `${e.target.value} GB`;
});
$('pickJavaBtn').addEventListener('click', async () => {
  const picked = await bridge.pickJava();
  if (picked) $('javaPath').value = picked;
});
$('openFolderBtn').addEventListener('click', () => bridge.openFolder(selectedId));
$('repairBtn').addEventListener('click', async () => {
  if (phase !== 'idle') {
    showSettingsError(t('play.closeFirst'));
    return;
  }
  await bridge.repair(selectedId);
  dialog.close();
  toast(t('settings.repairDone'));
  loadModpacks();
});
$('logsBtn').addEventListener('click', async () => showSettingsError(await saveLogs(selectedId)));

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const previousUrl = state.settings.backendUrl;
  try {
    state.settings = await bridge.saveSettings({
      memoryAuto: $('memoryAutoCheck').checked,
      memoryGb: Number($('memoryRange').value),
      textSize: Number($('textSizeSelect').value),
      joinServer: $('joinServerCheck').checked,
      javaPath: $('javaPath').value,
      language: $('languageSelect').value,
      backendUrl: $('backendUrl').value,
    });
  } catch (err) {
    showSettingsError(errorText(err));
    return;
  }
  dialog.close();
  if (state.settings.language !== i18n.getLanguage()) {
    i18n.setLanguage(state.settings.language);
    applyLanguage();
  }
  if (state.settings.backendUrl !== previousUrl && document.body.dataset.view === 'main') loadModpacks();
});

// ---------- Mods del jugador ----------

const modsDialog = $('modsDialog');

function showModsError(message) {
  $('modsError').textContent = message;
  $('modsError').hidden = !message;
}

// title: lo que se lee como nombre. detail: línea pequeña debajo (opcional).
function modRow(title, size, detail = '') {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'mod-name';
  name.textContent = title;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    name.append(small);
  }
  const sizeEl = document.createElement('span');
  sizeEl.className = 'mod-size';
  sizeEl.textContent = formatSize(size);
  return { li, name, sizeEl };
}

async function refreshMods() {
  let view;
  try {
    view = await bridge.getMods(selectedId);
  } catch (err) {
    showModsError(errorText(err));
    return;
  }
  showModsError('');

  $('optionalList').replaceChildren(
    ...view.optional.map((mod) => {
      // Con nombre puesto por el dueño se enseña ese y su descripción; si no,
      // el nombre del archivo.
      const { li, name, sizeEl } = modRow(mod.label || mod.filename, mod.size, mod.label ? mod.description : '');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = mod.enabled;
      box.addEventListener('change', async () => {
        await bridge.setModEnabled(selectedId, mod.key, box.checked);
        loadModpacks();
      });
      label.append(box, name);
      li.append(label, sizeEl);
      return li;
    }),
  );
  $('optionalEmpty').hidden = view.optional.length > 0;

  $('ownList').replaceChildren(
    ...view.own.map((mod) => {
      const { li, name, sizeEl } = modRow(mod.filename, mod.size);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-btn';
      remove.textContent = t('mods.remove');
      remove.setAttribute('aria-label', t('mods.removeLabel', { name: mod.filename }));
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        let error = '';
        try {
          await bridge.removeOwnMod(selectedId, mod.filename);
        } catch (err) {
          error = errorText(err);
        }
        await refreshMods();
        if (error) showModsError(error);
      });
      li.append(name, sizeEl, remove);
      return li;
    }),
  );
  $('ownEmpty').hidden = view.own.length > 0;
}

$('modsBtn').addEventListener('click', () => {
  if (phase !== 'idle') {
    toast(t('mods.closeFirst'), 'error');
    return;
  }
  $('optionalList').replaceChildren();
  $('ownList').replaceChildren();
  modsDialog.showModal();
  refreshMods();
});
$('modsClose').addEventListener('click', () => modsDialog.close());
$('modsFolderBtn').addEventListener('click', () => bridge.openFolder(selectedId));
$('addModsBtn').addEventListener('click', async () => {
  let message = '';
  try {
    const result = await bridge.addOwnMods(selectedId);
    if (result.skipped.length > 0) message = t('mods.skipped', { names: result.skipped.join(', ') });
  } catch (err) {
    message = errorText(err);
  }
  await refreshMods();
  if (message) showModsError(message);
});

// ---------- Actualización del launcher ----------

let updateVersion = null;
function renderUpdate() {
  if (updateVersion) $('updateText').textContent = t('update.text', { version: updateVersion });
  $('updateBanner').hidden = !updateVersion;
}
bridge.onUpdateReady(({ version }) => {
  updateVersion = version;
  renderUpdate();
});
$('updateBtn').addEventListener('click', () => {
  if (phase !== 'idle') toast(t('play.closeFirst'), 'error');
  else bridge.installUpdate();
});

// ---------- Arranque ----------

(async () => {
  state = await bridge.getState();
  i18n.setLanguage(state.settings.language);
  applyStaticTexts();
  renderServerStatus();
  renderPlayButton();
  selectedId = state.selectedModpack;
  if (state.account) await enterMain();
  else setView('login');
})();
