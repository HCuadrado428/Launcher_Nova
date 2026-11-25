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
let phrases = [];
let playtime = {};
let page = 'home'; // home | mods | shots
let serverStatus; // undefined = aún no se ha consultado
let selectedId = 'normal';
// Puede haber un juego abierto por modpack a la vez (un admin con el normal y
// el de admins), pero solo se prepara uno cada vez.
let preparingId = null; // modpack que se está preparando ahora
let lastProgress = null; // último aviso de esa preparación
let firstInstall = false; // esa preparación es una primera instalación
const running = new Set(); // modpacks con el juego abierto
const logs = {}; // salida del juego, por modpack
const runningAs = {}; // personaje con el que está abierto cada modpack (si lo hay)
// Personajes del admin (nicks sin premium para el modpack de admins).
let chars = { available: false, characters: [], selected: null, models: [] };
let charDraft = []; // copia que se edita en el diálogo

// Estado de un modpack: running | preparing | waiting (se prepara otro) | idle.
function phaseOf(id = selectedId) {
  if (running.has(id)) return 'running';
  if (preparingId === id) return 'preparing';
  return preparingId ? 'waiting' : 'idle';
}
// ¿Se puede tocar la carpeta de ese modpack (mods, importar, reparar)?
const isBusy = (id = selectedId) => running.has(id) || preparingId === id;
const anyGame = () => preparingId !== null || running.size > 0;

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

// Minutos jugados en texto: «12 h 05 min» o «40 min».
function formatPlaytime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? t('home.hours', { h, m: String(m).padStart(2, '0') }) : t('home.minutes', { m });
}

// Color y efectos elegidos en Ajustes.
function applyAppearance() {
  document.body.dataset.theme = state.settings.theme;
  document.body.classList.toggle('calm', state.settings.calm);
}

// ---------- Secciones ----------

const stage = document.querySelector('.stage');

function setPage(name) {
  page = name;
  stage.dataset.page = name;
  for (const button of document.querySelectorAll('.nav-btn')) {
    if (button.dataset.page === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (name === 'mods') {
    refreshMods();
    // La primera vez se enseñan los más descargados; luego se conserva lo buscado.
    if (!searchShown) runModSearch('');
  }
  if (name === 'shots') refreshShots();
}
$('pagesNav').addEventListener('click', (e) => {
  const button = e.target.closest('.nav-btn');
  if (button) setPage(button.dataset.page);
});

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
  if (page === 'mods') refreshMods();
  if (page === 'shots') refreshShots();
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
  if (anyGame()) {
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

// Cabezas de quienes están jugando ahora, si el servidor da sus nombres.
const MAX_ONLINE_SHOWN = 8;
function renderOnline() {
  const names = (serverStatus && serverStatus.online && serverStatus.names) || [];
  const list = $('onlineList');
  list.replaceChildren(
    ...names.slice(0, MAX_ONLINE_SHOWN).map((name) => {
      const li = document.createElement('li');
      const img = new Image(20, 20);
      img.alt = '';
      img.loading = 'lazy';
      // Si la cabeza no carga, se queda solo el nombre.
      img.onerror = () => img.remove();
      img.src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/40`;
      li.append(img, name);
      return li;
    }),
  );
  if (names.length > MAX_ONLINE_SHOWN) {
    const more = document.createElement('li');
    more.className = 'online-more';
    more.textContent = t('online.more', { n: names.length - MAX_ONLINE_SHOWN });
    list.append(more);
  }
  return names.length > 0;
}

async function refreshServerStatus() {
  serverStatus = await bridge.serverStatus().catch(() => null);
  renderServerStatus();
  renderInfo();
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
  const hasOnline = renderOnline();
  $('onlineCard').hidden = !hasOnline;
  const hasNews = Boolean(news && news.text);
  $('newsCard').hidden = !hasNews;
  if (hasNews) {
    $('newsText').textContent = news.text;
    $('newsDate').textContent = formatDate(news.updatedAt) || '';
  }
  $('infoBox').hidden = !(hasEvent || hasNews || hasOnline);
}
setInterval(() => {
  if (serverEvent && document.body.dataset.view === 'main' && !document.hidden) renderEvent();
}, 1000);

// ---------- Frase del servidor ----------

// Una frase al azar de las que el dueño escribe en el panel, al lado del
// título como las amarillas de Minecraft. Al pulsarla sale otra distinta.
let phraseIndex = -1;
function renderSplash(next = false) {
  const splash = $('splash');
  if (phrases.length === 0) {
    splash.hidden = true;
    return;
  }
  if (next || phraseIndex < 0 || phraseIndex >= phrases.length) {
    let pick = Math.floor(Math.random() * phrases.length);
    if (phrases.length > 1 && pick === phraseIndex) pick = (pick + 1) % phrases.length;
    phraseIndex = pick;
  }
  splash.textContent = phrases[phraseIndex];
  splash.hidden = false;
}
$('splash').addEventListener('click', () => renderSplash(true));

// ---------- Modpacks ----------

function showStageError(title, text) {
  stage.dataset.error = 'true';
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
    phrases = data.phrases || [];
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
  delete stage.dataset.error;
  renderModpacks();
  renderInfo();
  renderSplash();
  loadCharacters();
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
        meta.textContent = running.has(modpack.id) ? t('pack.running') : t('pack.mods', { n: modpack.modCount });
        tab.classList.toggle('is-running', running.has(modpack.id));
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
  renderCharBox();
  $('packTag').textContent = t(i18n.LANGUAGES.es[`pack.tag.${modpack.id}`] ? `pack.tag.${modpack.id}` : 'pack.tag.other');
  $('packTitle').textContent = modpack.name;
  $('packDesc').textContent = modpack.description;
  $('modsPack').textContent = modpack.name;

  const played = playtime[modpack.id];
  if (played && played.seconds >= 60) {
    const last = formatDate(played.lastPlayed);
    $('playtime').textContent =
      t('home.playtime', { time: formatPlaytime(played.seconds) }) + (last ? ` · ${t('home.lastPlayed', { date: last })}` : '');
  } else {
    $('playtime').textContent = t('home.neverPlayed');
  }

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
  if (!tab) return;
  selectedId = tab.dataset.pack;
  bridge.selectModpack(selectedId);
  renderModpacks();
  // Los resultados dependen del modpack (qué trae y qué tiene instalado).
  searchShown = false;
  $('modSearchResults').replaceChildren();
  if (page === 'mods') setPage('mods');
  if (page === 'shots') refreshShots();
});

$('retryBtn').addEventListener('click', loadModpacks);

// Al volver a la ventana se mira si el dueño ha actualizado algún modpack (o
// si la cuenta ha pasado a ser admin).
let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  if (document.body.dataset.view !== 'main' || preparingId || !state.settings.backendConfigured) return;
  if (Date.now() - lastFocusRefresh < 20_000) return;
  lastFocusRefresh = Date.now();
  loadModpacks();
});

// ---------- Jugar ----------

// Pinta el botón, el progreso y la consola del modpack seleccionado.
function renderPlayButton() {
  const button = $('playBtn');
  const modpack = modpacks.find((m) => m.id === selectedId);
  const phase = phaseOf();
  if (phase === 'running') {
    button.textContent = t('play.close');
    button.disabled = false;
  } else if (phase === 'preparing') {
    button.textContent = t('play.preparing');
    button.disabled = true;
  } else {
    button.textContent = t(modpack && modpack.status === 'ready' ? 'play.play' : 'play.install');
    // Mientras se prepara el otro modpack, este espera su turno.
    button.disabled = !modpack || phase === 'waiting';
  }

  $('progressHint').hidden = !(phase === 'preparing' && firstInstall);
  if (phase === 'running') {
    const as = runningAs[selectedId];
    setProgress(as ? `${t('char.runningAs', { name: as })} ${t('play.running')}` : t('play.running'), 100);
  } else if (phase === 'preparing') {
    if (lastProgress) setProgress(lastProgress.label, lastProgress.percent, lastProgress.step, lastProgress.total);
    else setProgress(t('play.preparingLabel'), null);
  } else {
    $('progressBox').hidden = true;
  }
  renderCharBox();
  renderConsole(true);
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

function renderConsole(toBottom = false) {
  const pre = $('consoleLog');
  const atBottom = toBottom || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = (logs[selectedId] || []).join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function addLog({ modpackId, line }) {
  const lines = logs[modpackId] || (logs[modpackId] = []);
  lines.push(line.replace(/\s+$/, ''));
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
  if (modpackId === selectedId) renderConsole();
}

$('playBtn').addEventListener('click', async () => {
  const id = selectedId;
  if (phaseOf(id) === 'running') {
    bridge.stopGame(id);
    return;
  }
  if (phaseOf(id) !== 'idle') return;
  preparingId = id;
  lastProgress = null;
  // La primera instalación es larga: se avisa para que nadie piense que se ha colgado.
  const current = modpacks.find((m) => m.id === id);
  firstInstall = Boolean(current && current.status === 'not-installed');
  logs[id] = [];
  renderPlayButton();

  let result;
  try {
    result = await bridge.play(id);
  } catch (err) {
    result = { ok: false, message: errorText(err) };
  }
  // Si ha ido bien, «game-started» ya ha dejado el modpack como abierto.
  if (preparingId === id) preparingId = null;
  if (!result.ok) {
    toast(result.message, 'error');
    // Recargar la lista: si se ha perdido el acceso al modpack, desaparece.
    await loadModpacks();
  }
  renderPlayButton();
});

bridge.onPlayProgress((progress) => {
  if (progress.modpackId !== preparingId) return;
  lastProgress = progress;
  if (progress.modpackId === selectedId) setProgress(progress.label, progress.percent, progress.step, progress.total);
});

bridge.onGameStarted(({ id, character }) => {
  running.add(id);
  runningAs[id] = character ? charName(character) : null;
  if (preparingId === id) preparingId = null;
  renderPlayButton();
  loadModpacks();
});

bridge.onGameClosed(({ code, crash, modpackId, playtime: updated }) => {
  running.delete(modpackId);
  delete runningAs[modpackId];
  if (updated) playtime = updated;
  if (modpacks.length > 0) renderModpacks();
  if (page === 'shots') refreshShots();
  renderPlayButton();
  if (crash) showCrash(code, crash, modpackId);
});

bridge.onGameLog(addLog);

// ---------- Personajes (modpack de admins) ----------

// Nicks sin premium de un admin. Se elige uno en «Jugar como» y el juego se
// abre con ese nick y con su modelo de CPM ya puesto.
const charDialog = $('charDialog');

function charName(nick) {
  const character = chars.characters.find((c) => c.nick === nick);
  return character && character.label ? `${character.label} (${nick})` : nick;
}

async function loadCharacters() {
  try {
    chars = await bridge.getCharacters();
  } catch {
    chars = { available: false, characters: [], selected: null, models: [] };
  }
  renderCharBox();
}

function renderCharBox() {
  const box = $('charBox');
  box.hidden = !(chars.available && selectedId === 'admin');
  if (box.hidden) return;
  const select = $('charSelect');
  const option = (value, text) => {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = text;
    return el;
  };
  select.replaceChildren(
    option('', t('char.me', { name: state.account ? state.account.username : '' })),
    ...chars.characters.map((c) => option(c.nick, charName(c.nick))),
  );
  select.value = chars.selected || '';
  // Con el juego abierto o preparándose ya no se cambia con quién se entra.
  select.disabled = isBusy('admin');
  $('charManage').disabled = isBusy('admin');
}

$('charSelect').addEventListener('change', async (event) => {
  try {
    chars = await bridge.selectCharacter(event.target.value || null);
  } catch (err) {
    toast(errorText(err), 'error');
  }
  renderCharBox();
});

function charMessage(text) {
  $('charError').textContent = text;
  $('charError').hidden = !text;
}

function renderCharRows() {
  $('charEmpty').hidden = charDraft.length > 0;
  $('charRows').replaceChildren(
    ...charDraft.map((character, index) => {
      const li = document.createElement('li');
      const field = (key, labelKey, attrs) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.spellcheck = false;
        input.value = character[key] || '';
        input.placeholder = t(labelKey);
        input.setAttribute('aria-label', t(labelKey));
        Object.assign(input, attrs);
        input.addEventListener('input', () => {
          character[key] = input.value;
        });
        return input;
      };
      const model = document.createElement('select');
      model.setAttribute('aria-label', t('char.model'));
      const option = (value, text) => {
        const el = document.createElement('option');
        el.value = value;
        el.textContent = text;
        model.append(el);
      };
      option('', t('char.noModel'));
      for (const name of chars.models) option(name, name.replace(/\.cpmmodel$/, ''));
      // Un modelo guardado que ya no está en la carpeta se sigue enseñando, avisando.
      if (character.model && !chars.models.includes(character.model)) {
        option(character.model, t('char.modelGone', { model: character.model.replace(/\.cpmmodel$/, '') }));
      }
      model.value = character.model || '';
      model.addEventListener('change', () => {
        character.model = model.value || null;
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn';
      remove.textContent = t('char.remove');
      remove.addEventListener('click', () => {
        charDraft.splice(index, 1);
        renderCharRows();
      });
      li.append(field('label', 'char.label', { maxLength: 40 }), field('nick', 'char.nick', { maxLength: 16 }), model, remove);
      return li;
    }),
  );
}

$('charManage').addEventListener('click', async () => {
  if (isBusy('admin')) {
    toast(t('char.closeFirst'), 'error');
    return;
  }
  await loadCharacters(); // por si han cambiado los modelos de la carpeta
  charDraft = chars.characters.map((c) => ({ ...c }));
  charMessage('');
  renderCharRows();
  charDialog.showModal();
});

$('charAdd').addEventListener('click', () => {
  charDraft.push({ nick: '', label: '', model: null });
  renderCharRows();
  const inputs = $('charRows').querySelectorAll('li:last-child input');
  if (inputs[0]) inputs[0].focus();
});

$('charClose').addEventListener('click', () => charDialog.close());

$('charSave').addEventListener('click', async () => {
  charMessage('');
  $('charSave').disabled = true;
  try {
    chars = await bridge.saveCharacters(charDraft);
    charDialog.close();
    toast(t('char.saved'));
  } catch (err) {
    charMessage(errorText(err));
  } finally {
    $('charSave').disabled = false;
    renderCharBox();
  }
});

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

// ---------- Traer cosas de otro launcher ----------

const importDialog = $('importDialog');
let importList = []; // instalaciones ofrecidas
let importFrom = null; // la elegida

function importMessage(error, result = '') {
  $('importError').textContent = error;
  $('importError').hidden = !error;
  $('importResult').textContent = result;
  $('importResult').hidden = !result;
}

function renderImportCategories() {
  const cats = importFrom ? importFrom.categories : [];
  $('importWhatBox').hidden = cats.length === 0;
  $('importCats').replaceChildren(
    ...cats.map((cat) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = cat.id;
      // Los mundos pueden ocupar mucho: se dejan sin marcar para que sea una decisión.
      box.checked = cat.id !== 'worlds';
      box.addEventListener('change', updateImportButton);
      const text = document.createElement('span');
      text.textContent = `${t(`import.cat.${cat.id}`)} (${cat.count})`;
      label.append(box, text);
      li.append(label);
      return li;
    }),
  );
  $('importWorldsNote').hidden = !(selectedId === 'normal' && cats.some((c) => c.id === 'worlds'));
  updateImportButton();
}

function updateImportButton() {
  $('importRun').disabled = !importFrom || $('importCats').querySelectorAll('input:checked').length === 0;
}

// El buscador sale cuando hay varias instalaciones entre las que elegir
// (quien usa CurseForge o Modrinth suele tener muchas).
function renderImportSources() {
  $('importNone').hidden = importList.length > 0;
  $('importFilter').hidden = importList.length < 2;
  const words = $('importFilter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = importList.filter((source) => {
    const text = `${source.launcher} ${source.name} ${source.path}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  $('importNoMatch').hidden = importList.length === 0 || shown.length > 0;
  $('importSources').replaceChildren(
    ...shown.map((source) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'importSource';
      radio.checked = source === importFrom;
      radio.addEventListener('change', () => {
        importFrom = source;
        importMessage('');
        renderImportCategories();
      });
      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent =
        source.launcher === 'Minecraft' && !source.name
          ? t('import.official')
          : [source.launcher, source.name].filter(Boolean).join(' · ');
      const where = document.createElement('small');
      where.textContent = source.path;
      text.append(title, where);
      label.append(radio, text);
      li.append(label);
      return li;
    }),
  );
}

async function openImport() {
  if (isBusy()) {
    toast(t('play.closeFirst'), 'error');
    return;
  }
  const modpack = modpacks.find((m) => m.id === selectedId);
  $('importTarget').textContent = modpack ? `→ ${modpack.name}` : '';
  importList = [];
  importFrom = null;
  $('importFilter').value = '';
  importMessage('');
  renderImportSources();
  renderImportCategories();
  if (dialog.open) dialog.close();
  importDialog.showModal();
  try {
    importList = await bridge.importSources(selectedId);
  } catch (err) {
    importMessage(errorText(err));
  }
  // Con una sola instalación encontrada, se da por elegida.
  if (importList.length === 1) importFrom = importList[0];
  renderImportSources();
  renderImportCategories();
}

$('importFilter').addEventListener('input', renderImportSources);
for (const button of document.querySelectorAll('[data-open-import]')) button.addEventListener('click', openImport);
$('settingsImportBtn').addEventListener('click', openImport);
$('importClose').addEventListener('click', () => importDialog.close());

$('importPick').addEventListener('click', async () => {
  let picked;
  try {
    picked = await bridge.importPick(selectedId);
  } catch (err) {
    importMessage(errorText(err));
    return;
  }
  if (!picked) return;
  if (picked.error) {
    importMessage(picked.error);
    return;
  }
  importList = [...importList.filter((s) => s.path !== picked.source.path), picked.source];
  importFrom = picked.source;
  importMessage('');
  renderImportSources();
  renderImportCategories();
});

$('importRun').addEventListener('click', async () => {
  const categories = [...$('importCats').querySelectorAll('input:checked')].map((box) => box.value);
  const button = $('importRun');
  button.disabled = true;
  button.textContent = t('import.running');
  importMessage('');
  try {
    const report = await bridge.importRun(selectedId, importFrom.path, categories);
    const totals = Object.values(report).reduce(
      (sum, r) => ({ copied: sum.copied + r.copied, skipped: sum.skipped + r.skipped }),
      { copied: 0, skipped: 0 },
    );
    const key = totals.copied === 0 ? 'import.nothing' : totals.skipped > 0 ? 'import.doneSkipped' : 'import.done';
    importMessage('', t(key, totals));
    if (page === 'shots') refreshShots();
  } catch (err) {
    importMessage(errorText(err));
  }
  button.textContent = t('import.run');
  updateImportButton();
});

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
  $('themeSelect').value = s.theme;
  $('calmCheck').checked = s.calm;
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
  if (isBusy()) {
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
      theme: $('themeSelect').value,
      calm: $('calmCheck').checked,
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
  applyAppearance();
  if (state.settings.language !== i18n.getLanguage()) {
    i18n.setLanguage(state.settings.language);
    applyLanguage();
  }
  if (state.settings.backendUrl !== previousUrl && document.body.dataset.view === 'main') loadModpacks();
});

// ---------- Mods del jugador ----------

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
        if (isBusy()) {
          box.checked = !box.checked;
          showModsError(t('mods.closeFirst'));
          return;
        }
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
      const { li, name, sizeEl } = modRow(mod.title || mod.filename, mod.size, mod.title ? mod.filename : '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-btn';
      remove.textContent = t('mods.remove');
      remove.setAttribute('aria-label', t('mods.removeLabel', { name: mod.title || mod.filename }));
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
        else if (searchShown) runModSearch(searchQuery);
      });
      li.append(name, sizeEl, remove);
      return li;
    }),
  );
  $('ownEmpty').hidden = view.own.length > 0;
}

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

// ---------- Buscar mods en Modrinth ----------

let searchShown = false; // ya hay resultados pintados para este modpack
let searchQuery = '';
let searchToken = 0;

async function runModSearch(query) {
  const packId = selectedId;
  const token = ++searchToken;
  searchQuery = query;
  $('modSearchStatus').textContent = t('mods.search.searching');
  let results;
  try {
    results = await bridge.searchMods(packId, query);
  } catch (err) {
    if (token !== searchToken) return;
    $('modSearchStatus').textContent = errorText(err);
    $('modSearchResults').replaceChildren();
    return;
  }
  if (token !== searchToken || packId !== selectedId) return; // llegó una búsqueda más nueva
  searchShown = true;
  $('modSearchStatus').textContent = results.length === 0 ? t('mods.search.empty') : query ? '' : t('mods.search.popular');
  $('modSearchResults').replaceChildren(
    ...results.map((mod) => {
      const li = document.createElement('li');
      const icon = document.createElement('div');
      icon.className = 'result-icon';
      if (mod.iconUrl) {
        const img = new Image(40, 40);
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => img.remove();
        img.src = mod.iconUrl;
        icon.append(img);
      }
      const text = document.createElement('div');
      text.className = 'result-text';
      const title = document.createElement('strong');
      title.textContent = mod.title;
      const description = document.createElement('span');
      description.textContent = mod.description;
      const downloads = document.createElement('small');
      downloads.textContent = t('mods.search.downloads', { n: mod.downloads.toLocaleString(locale()) });
      text.append(title, description, downloads);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      if (mod.inPack || mod.installed) {
        button.disabled = true;
        button.textContent = t(mod.inPack ? 'mods.search.inPack' : 'mods.search.installed');
      } else {
        button.textContent = t('mods.search.install');
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = t('mods.search.installing');
          try {
            const installed = await bridge.installMod(packId, mod.id);
            button.textContent = t('mods.search.installed');
            toast(
              installed.length > 1
                ? t('mods.search.doneDeps', { title: mod.title, n: installed.length - 1 })
                : t('mods.search.done', { title: mod.title }),
            );
            refreshMods();
          } catch (err) {
            button.disabled = false;
            button.textContent = t('mods.search.install');
            toast(errorText(err), 'error');
          }
        });
      }
      li.append(icon, text, button);
      return li;
    }),
  );
}

$('modSearchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runModSearch($('modSearchInput').value.trim());
});

// ---------- Capturas ----------

async function refreshShots() {
  const packId = selectedId;
  let shots = [];
  try {
    shots = await bridge.listScreenshots(packId);
  } catch (err) {
    toast(errorText(err), 'error');
  }
  if (packId !== selectedId) return; // se cambió de modpack mientras cargaba
  $('shotsCount').textContent = shots.length > 0 ? t('shots.count', { n: shots.length }) : '';
  $('shotsEmpty').hidden = shots.length > 0;
  $('shotsGrid').replaceChildren(
    ...shots.map((shot) => {
      const li = document.createElement('li');
      li.className = 'shot';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'shot-open';
      open.setAttribute('aria-label', t('shots.open', { name: shot.name }));
      const img = new Image();
      img.alt = '';
      img.loading = 'lazy';
      // La fecha de modificación va en la dirección para no enseñar una miniatura antigua.
      img.src = `nova-shot://thumb/${encodeURIComponent(packId)}/${encodeURIComponent(shot.name)}?v=${shot.mtimeMs}`;
      open.append(img);
      open.addEventListener('click', () => bridge.openScreenshot(packId, shot.name).catch(() => refreshShots()));

      const bar = document.createElement('div');
      bar.className = 'shot-bar';
      const date = document.createElement('span');
      date.textContent = new Date(shot.mtimeMs).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = t('shots.copy');
      copy.addEventListener('click', async () => {
        try {
          await bridge.copyScreenshot(packId, shot.name);
          toast(t('shots.copied'));
        } catch (err) {
          toast(errorText(err), 'error');
          refreshShots();
        }
      });

      // Borrar pide un segundo clic; la captura va a la papelera.
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'shot-delete';
      remove.textContent = t('shots.delete');
      let armed = null;
      remove.addEventListener('click', async () => {
        if (!armed) {
          remove.textContent = t('shots.confirm');
          armed = setTimeout(() => {
            armed = null;
            remove.textContent = t('shots.delete');
          }, 3000);
          return;
        }
        clearTimeout(armed);
        try {
          await bridge.deleteScreenshot(packId, shot.name);
          toast(t('shots.deleted'));
        } catch (err) {
          toast(errorText(err), 'error');
        }
        refreshShots();
      });

      bar.append(date, copy, remove);
      li.append(open, bar);
      return li;
    }),
  );
}

$('shotsRefresh').addEventListener('click', refreshShots);
$('shotsFolder').addEventListener('click', () => bridge.openScreenshotsFolder(selectedId));

// ---------- Teclado ----------

// Intro en Inicio = Jugar, salvo que se esté escribiendo o haya una ventana abierta.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.repeat || document.body.dataset.view !== 'main' || page !== 'home') return;
  if (document.querySelector('dialog[open]') || stage.dataset.error) return;
  if (e.target.closest('input, textarea, select, button, summary, a')) return;
  if (phaseOf() === 'idle') $('playBtn').click();
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
  if (anyGame()) toast(t('play.closeFirst'), 'error');
  else bridge.installUpdate();
});

// ---------- Arranque ----------

(async () => {
  state = await bridge.getState();
  i18n.setLanguage(state.settings.language);
  playtime = state.playtime || {};
  for (const id of state.runningModpacks || []) running.add(id);
  applyAppearance();
  applyStaticTexts();
  setPage('home');
  renderServerStatus();
  renderPlayButton();
  selectedId = state.selectedModpack;
  if (state.account) await enterMain();
  else setView('login');
})();
