// ======================================================
// Interfaz del Nova Launcher
// ======================================================

const $ = (id) => document.getElementById(id);
const bridge = window.nova;

const PACK_TAGS = { normal: 'MODPACK DEL SERVIDOR', admin: 'SOLO ADMINS' };
const STATUS_TEXT = {
  ready: 'AL DÍA · LISTO PARA JUGAR',
  update: 'HAY UNA ACTUALIZACIÓN · SE DESCARGA AL PULSAR JUGAR',
  'not-installed': 'SIN INSTALAR · SE DESCARGA AL PULSAR JUGAR',
};
const SERVER_REFRESH_MS = 60_000;
const MAX_LOG_LINES = 600;

let state = null; // respuesta de get-state
let modpacks = [];
let selectedId = 'normal';
let phase = 'idle'; // idle | preparing | running
const logLines = [];

// ---------- Utilidades ----------

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.type = type;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 9000 : 4500);
}

function formatSize(bytes) {
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Los errores que cruzan desde el proceso principal llegan con un prefijo
// técnico ("Error invoking remote method..."): nos quedamos con el mensaje.
function errorText(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function setView(view) {
  document.body.dataset.view = view;
}

// ---------- Cuenta ----------

function renderAccount() {
  const account = state.account;
  if (!account) return;
  $('accountName').textContent = account.username;
  $('accountType').textContent = account.type === 'microsoft' ? 'Cuenta Microsoft' : 'Sin premium';
  $('adminBadge').hidden = !account.admin;

  const avatar = $('avatar');
  avatar.textContent = account.username[0].toUpperCase();
  if (account.type === 'microsoft' && account.uuid) {
    const img = new Image();
    img.alt = '';
    img.onload = () => avatar.replaceChildren(img);
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
  button.textContent = 'ABRIENDO MICROSOFT...';
  try {
    await handleLogin(await bridge.loginMicrosoft());
  } catch (err) {
    showLoginError(errorText(err));
  } finally {
    button.disabled = false;
    button.textContent = 'ENTRAR CON MICROSOFT';
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
    toast('Cierra antes el juego.', 'error');
    return;
  }
  await bridge.logout();
  state.account = null;
  modpacks = [];
  setView('login');
});

// ---------- Servidor ----------

async function refreshServerStatus() {
  const status = await bridge.serverStatus().catch(() => null);
  const box = $('serverBox');
  if (!status) {
    box.dataset.state = 'unknown';
    $('serverText').textContent = 'Sin datos';
  } else if (status.online) {
    box.dataset.state = 'online';
    $('serverText').textContent = status.players === null ? 'Online' : `Online · ${status.players}/${status.max}`;
  } else {
    box.dataset.state = 'offline';
    $('serverText').textContent = 'Offline';
  }
}
setInterval(() => {
  if (document.body.dataset.view === 'main' && !document.hidden) refreshServerStatus();
}, SERVER_REFRESH_MS);

$('copyIpBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.serverAddress);
    toast('IP copiada.');
  } catch {
    toast(state.serverAddress);
  }
});

$('webBtn').addEventListener('click', () => bridge.openWeb());

// ---------- Modpacks ----------

function showStageError(title, text) {
  $('hero').hidden = true;
  $('launchBox').hidden = true;
  $('packTabs').replaceChildren();
  $('stageEmpty').hidden = false;
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

async function loadModpacks() {
  if (!state.settings.backendConfigured) {
    showStageError(
      'SIN SEÑAL',
      'Este launcher todavía no sabe dónde está su servidor. Pon la dirección en Ajustes > Avanzado.',
    );
    return;
  }
  try {
    const data = await bridge.getModpacks();
    modpacks = data.modpacks;
    state.account = data.account;
    renderAccount();
  } catch (err) {
    showStageError('SEÑAL PERDIDA', errorText(err));
    return;
  }
  if (!modpacks.some((m) => m.id === selectedId)) selectedId = 'normal';
  $('stageEmpty').hidden = true;
  $('hero').hidden = false;
  $('launchBox').hidden = false;
  renderModpacks();
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
        meta.textContent = `${modpack.modCount} mods`;
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
  $('packTag').textContent = PACK_TAGS[modpack.id] || 'MODPACK';
  $('packTitle').textContent = modpack.name;
  $('packDesc').textContent = modpack.description;

  const chips = [
    `Minecraft ${modpack.mcVersion}`,
    `Forge${modpack.loaderVersion ? ` ${modpack.loaderVersion}` : ''}`,
    `${modpack.modCount} mods`,
  ];
  if (modpack.totalSize > 0) chips.push(formatSize(modpack.totalSize));
  const updated = formatDate(modpack.updatedAt);
  if (updated) chips.push(`Actualizado el ${updated}`);
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
    stateEl.textContent = 'ESTE MODPACK TODAVÍA NO TIENE MODS';
  } else {
    stateEl.dataset.status = modpack.status;
    stateEl.textContent = STATUS_TEXT[modpack.status] || '';
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
    button.textContent = 'CERRAR JUEGO';
    button.disabled = false;
  } else if (phase === 'preparing') {
    button.textContent = 'PREPARANDO';
    button.disabled = true;
  } else {
    button.textContent = modpack && modpack.status === 'ready' ? 'JUGAR' : 'INSTALAR Y JUGAR';
    button.disabled = !modpack;
  }
}

function setProgress(label, percent) {
  $('progressBox').hidden = false;
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
  logLines.length = 0;
  $('consoleLog').textContent = '';
  renderPlayButton();
  setProgress('Preparando...', null);

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

bridge.onPlayProgress(({ label, percent }) => {
  if (phase === 'preparing') setProgress(label, percent);
});

bridge.onGameStarted(() => {
  phase = 'running';
  setProgress('Minecraft está abierto. ¡Buen viaje!', 100);
  renderPlayButton();
  loadModpacks();
});

bridge.onGameClosed(({ code }) => {
  phase = 'idle';
  $('progressBox').hidden = true;
  renderPlayButton();
  if (code !== 0 && code !== null) {
    $('consoleBox').open = true;
    toast(`Minecraft se ha cerrado con un error (código ${code}). Mira la consola del juego.`, 'error');
  }
});

bridge.onGameLog(addLog);

// ---------- Ajustes ----------

const dialog = $('settingsDialog');

function openSettings() {
  const s = state.settings;
  $('memoryRange').max = String(s.maxMemoryGb);
  $('memoryRange').value = String(s.memoryGb);
  $('memoryOut').textContent = `${s.memoryGb} GB`;
  $('joinServerCheck').checked = s.joinServer;
  $('javaPath').value = s.javaPath;
  $('backendUrl').value = s.backendConfigured ? s.backendUrl : '';
  $('packActions').hidden = document.body.dataset.view !== 'main' || modpacks.length === 0;
  $('settingsError').hidden = true;
  dialog.showModal();
}

for (const button of document.querySelectorAll('[data-open-settings]')) button.addEventListener('click', openSettings);
$('settingsCancel').addEventListener('click', () => dialog.close());
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
    toast('Cierra antes el juego.', 'error');
    return;
  }
  await bridge.repair(selectedId);
  dialog.close();
  toast('Hecho. La próxima vez que pulses Jugar se volverán a comprobar y descargar los mods.');
  loadModpacks();
});

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const previousUrl = state.settings.backendUrl;
  try {
    state.settings = await bridge.saveSettings({
      memoryGb: Number($('memoryRange').value),
      joinServer: $('joinServerCheck').checked,
      javaPath: $('javaPath').value,
      backendUrl: $('backendUrl').value,
    });
  } catch (err) {
    $('settingsError').textContent = errorText(err);
    $('settingsError').hidden = false;
    return;
  }
  dialog.close();
  if (state.settings.backendUrl !== previousUrl && document.body.dataset.view === 'main') loadModpacks();
});

// ---------- Actualización del launcher ----------

bridge.onUpdateReady(({ version }) => {
  $('updateText').textContent = `Hay una versión nueva del launcher (v${version}) lista para instalar.`;
  $('updateBanner').hidden = false;
});
$('updateBtn').addEventListener('click', () => {
  if (phase !== 'idle') toast('Cierra antes el juego.', 'error');
  else bridge.installUpdate();
});

// ---------- Arranque ----------

(async () => {
  state = await bridge.getState();
  selectedId = state.selectedModpack;
  if (state.account) await enterMain();
  else setView('login');
})();
