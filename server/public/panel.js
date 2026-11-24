// ======================================================
// Panel del launcher: login con Google, mods de cada modpack y lista de admins
// ======================================================

const TOKEN_KEY = 'nova-panel-token';
const PACK_TAGS = { normal: 'PARA TODOS', admin: 'SOLO ADMINS' };

const gate = document.getElementById('gate');
const gateStatus = document.getElementById('gateStatus');
const panel = document.getElementById('panel');
const toasts = document.getElementById('toasts');
const adminList = document.getElementById('adminList');

let token = null;
try {
  token = sessionStorage.getItem(TOKEN_KEY);
} catch {
  // Sin sessionStorage (modo privado estricto): habrá que entrar en cada visita.
}
let state = { modpacks: [], admins: [], players: [], news: null, event: null };
const filters = { normal: '', admin: '' };

// ---------- Utilidades ----------

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.type = type;
  el.textContent = message;
  toasts.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000);
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('No se pudo conectar con el servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    signOut();
    throw new Error('La sesión ha caducado. Vuelve a entrar.');
  }
  if (!res.ok) throw new Error(data.error || `El servidor respondió ${res.status}.`);
  return data;
}

// Envuelve una acción del panel: enseña el error si falla y repinta si va bien.
async function run(action, okMessage) {
  try {
    const data = await action();
    if (data && data.modpacks) {
      state = data;
      render();
    }
    if (okMessage) toast(okMessage);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

// Botón que pide un segundo clic antes de hacer algo que no se puede deshacer.
function confirmButton(button, action) {
  const original = button.textContent;
  let timer = null;
  button.addEventListener('click', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      button.textContent = original;
      action();
      return;
    }
    button.textContent = '¿Seguro? Pulsa otra vez';
    timer = setTimeout(() => {
      timer = null;
      button.textContent = original;
    }, 3500);
  });
}

// ---------- Sesión ----------

function setGateStatus(text, isError = false) {
  gateStatus.textContent = text;
  gateStatus.dataset.state = isError ? 'error' : '';
}

function signOut() {
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // nada que borrar
  }
  panel.hidden = true;
  gate.hidden = false;
  setGateStatus('IDENTIFÍCATE');
}

async function enterPanel(email) {
  state = await api('/api/panel/state');
  document.getElementById('sessionEmail').textContent = email || '';
  gate.hidden = true;
  panel.hidden = false;
  render();
}

async function onGoogleCredential(response) {
  setGateStatus('VERIFICANDO...');
  try {
    const data = await api('/api/panel/login', { method: 'POST', body: { credential: response.credential } });
    token = data.token;
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(`${TOKEN_KEY}-email`, data.email);
    } catch {
      // seguimos con el token en memoria
    }
    await enterPanel(data.email);
  } catch (err) {
    setGateStatus(`ACCESO DENEGADO · ${err.message}`, true);
  }
}

function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar el inicio de sesión de Google.'));
    document.head.append(script);
  });
}

async function init() {
  if (token) {
    try {
      let email = '';
      try {
        email = sessionStorage.getItem(`${TOKEN_KEY}-email`) || '';
      } catch {
        // sin correo guardado
      }
      await enterPanel(email);
    } catch {
      // token caducado: se enseña la entrada normal
    }
  }
  try {
    const { googleClientId } = await api('/api/panel/config');
    if (!googleClientId) {
      setGateStatus('FALTA CONFIGURAR GOOGLE_CLIENT_ID EN EL SERVIDOR', true);
      return;
    }
    await loadGoogleScript();
    window.google.accounts.id.initialize({ client_id: googleClientId, callback: onGoogleCredential });
    window.google.accounts.id.renderButton(document.getElementById('googleButton'), {
      theme: 'filled_black',
      size: 'large',
      shape: 'pill',
      text: 'signin_with',
      locale: 'es',
    });
    if (!token) setGateStatus('IDENTIFÍCATE');
  } catch (err) {
    setGateStatus(`SEÑAL PERDIDA · ${err.message}`, true);
  }
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  if (window.google) window.google.accounts.id.disableAutoSelect();
  signOut();
});

// ---------- Modpacks ----------

// Sube los archivos de uno en uno: así hay progreso por archivo y un mod
// grande no arrastra a los demás si falla.
function uploadOne(packId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('mods', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/panel/modpacks/${packId}/mods`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const data = xhr.response || {};
      if (xhr.status === 401) {
        signOut();
        reject(new Error('La sesión ha caducado. Vuelve a entrar.'));
      } else if (xhr.status >= 400) reject(new Error(data.error || `El servidor respondió ${xhr.status}.`));
      else resolve(data);
    };
    xhr.onerror = () => reject(new Error('Se cortó la conexión durante la subida.'));
    xhr.send(form);
  });
}

async function uploadFiles(packId, section, fileList) {
  const files = [...fileList];
  const jars = files.filter((f) => /\.jar$/i.test(f.name));
  if (jars.length < files.length) toast(`Se ignoran ${files.length - jars.length} archivo(s) que no son .jar.`, 'error');
  if (jars.length === 0) return;

  const box = section.querySelector('.upload');
  const bar = section.querySelector('.upload-bar span');
  const text = section.querySelector('.upload-text');
  const drop = section.querySelector('.drop');
  box.hidden = false;
  drop.style.pointerEvents = 'none';

  const totalBytes = jars.reduce((sum, f) => sum + f.size, 0) || 1;
  let doneBytes = 0;
  let added = 0;
  let replaced = 0;
  const failed = [];

  for (const [index, file] of jars.entries()) {
    text.textContent = `Subiendo ${index + 1} de ${jars.length}: ${file.name}`;
    try {
      const data = await uploadOne(packId, file, (fraction) => {
        bar.style.width = `${((doneBytes + file.size * fraction) / totalBytes) * 100}%`;
      });
      const result = data.results[0];
      if (result.ok) {
        if (result.replaced) replaced++;
        else added++;
      } else failed.push(`${file.name}: ${result.error}`);
      state = data;
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
      if (!token) break;
    }
    doneBytes += file.size;
    bar.style.width = `${(doneBytes / totalBytes) * 100}%`;
  }

  box.hidden = true;
  bar.style.width = '0';
  drop.style.pointerEvents = '';
  render();
  if (added || replaced) {
    const parts = [];
    if (added) parts.push(`${added} añadido(s)`);
    if (replaced) parts.push(`${replaced} actualizado(s)`);
    toast(`Modpack actualizado: ${parts.join(', ')}. El launcher lo descargará la próxima vez que alguien pulse Jugar.`);
  }
  for (const message of failed) toast(message, 'error');
}

function buildPack(section) {
  const packId = section.dataset.pack;
  section.append(document.getElementById('packTemplate').content.cloneNode(true));
  section.querySelector('.pack-title').id = `pack-${packId}-title`;
  section.querySelector('.pack-tag').textContent = PACK_TAGS[packId];

  const drop = section.querySelector('.drop');
  const input = section.querySelector('.drop-input');
  input.addEventListener('change', () => {
    uploadFiles(packId, section, input.files);
    input.value = '';
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    });
  }
  drop.addEventListener('drop', (e) => uploadFiles(packId, section, e.dataTransfer.files));

  section.querySelector('.filter').addEventListener('input', (e) => {
    filters[packId] = e.target.value.trim().toLowerCase();
    renderPack(section);
  });

  confirmButton(section.querySelector('.clear-btn'), () =>
    run(() => api(`/api/panel/modpacks/${packId}/mods`, { method: 'DELETE' }), 'Modpack vaciado.'),
  );

  const copyBtn = section.querySelector('.copy-btn');
  if (packId === 'admin') {
    copyBtn.hidden = false;
    confirmButton(copyBtn, () =>
      run(
        () => api('/api/panel/modpacks/admin/copy-from/normal', { method: 'POST' }),
        'El modpack de admins tiene ahora los mismos mods que el normal. Sube encima los extra.',
      ),
    );
  }

  section.querySelector('.mod-list').addEventListener('click', (e) => {
    const toggle = e.target.closest('button[data-optional]');
    if (toggle) {
      toggle.disabled = true;
      run(() =>
        api(`/api/panel/modpacks/${packId}/mods/${toggle.dataset.optional}`, {
          method: 'PATCH',
          body: { optional: toggle.getAttribute('aria-pressed') !== 'true' },
        }),
      );
      return;
    }
    const button = e.target.closest('button[data-mod]');
    if (!button) return;
    button.disabled = true;
    run(() => api(`/api/panel/modpacks/${packId}/mods/${button.dataset.mod}`, { method: 'DELETE' }));
  });

  // Nombre y descripción de un opcional: se guardan al salir del campo.
  section.querySelector('.mod-list').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-mod-field]');
    if (!input) return;
    run(() =>
      api(`/api/panel/modpacks/${packId}/mods/${input.dataset.modId}`, {
        method: 'PATCH',
        body: { [input.dataset.modField]: input.value },
      }),
    );
  });

  section.querySelector('.version-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    run(
      () =>
        api(`/api/panel/modpacks/${packId}`, {
          method: 'PATCH',
          body: { mcVersion: form.get('mcVersion').trim(), loaderVersion: form.get('loaderVersion').trim() },
        }),
      'Versiones guardadas.',
    );
  });
}

function renderPack(section) {
  const modpack = state.modpacks.find((m) => m.id === section.dataset.pack);
  if (!modpack) return;
  section.querySelector('.pack-title').textContent = modpack.name;
  section.querySelector('.pack-meta').textContent =
    `${modpack.modCount} mods · ${formatSize(modpack.totalSize)} · actualizado: ${formatDate(modpack.updatedAt)}`;

  const list = section.querySelector('.mod-list');
  const filter = filters[modpack.id];
  const mods = filter ? modpack.mods.filter((m) => m.filename.toLowerCase().includes(filter)) : modpack.mods;
  list.replaceChildren(
    ...mods.map((mod) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'mod-name';
      name.textContent = mod.filename;
      const size = document.createElement('span');
      size.className = 'mod-size';
      size.textContent = formatSize(mod.size);
      const optional = document.createElement('button');
      optional.type = 'button';
      optional.className = 'pill-btn';
      optional.dataset.optional = mod.id;
      optional.setAttribute('aria-pressed', String(Boolean(mod.optional)));
      optional.textContent = 'Opcional';
      optional.title = mod.optional
        ? 'Cada jugador decide en el launcher si lo usa. Pulsa para hacerlo obligatorio.'
        : 'Lo tienen todos. Pulsa para que cada jugador pueda quitárselo en el launcher.';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.dataset.mod = mod.id;
      del.textContent = '✕';
      del.setAttribute('aria-label', `Quitar ${mod.filename}`);
      del.title = 'Quitar del modpack';
      li.append(name, size, optional, del);
      // Un opcional lleva además el nombre y la descripción que verá el jugador
      // en el launcher, en vez del nombre del archivo.
      if (mod.optional) {
        const extra = document.createElement('div');
        extra.className = 'mod-extra';
        for (const [field, placeholder, max] of [
          ['label', 'Nombre para los jugadores (p. ej. Minimapa)', 40],
          ['description', 'Para qué sirve, en una frase', 140],
        ]) {
          const input = document.createElement('input');
          input.value = mod[field] || '';
          input.maxLength = max;
          input.placeholder = placeholder;
          input.setAttribute('aria-label', `${placeholder}: ${mod.filename}`);
          input.dataset.modField = field;
          input.dataset.modId = mod.id;
          extra.append(input);
        }
        li.append(extra);
      }
      return li;
    }),
  );
  const empty = section.querySelector('.empty');
  empty.hidden = mods.length > 0;
  empty.textContent = modpack.mods.length === 0 ? 'Sin mods todavía.' : 'Ningún mod coincide con la búsqueda.';

  // No pisar lo que se esté escribiendo en el formulario de versiones.
  const form = section.querySelector('.version-form');
  if (!form.contains(document.activeElement)) {
    form.elements.mcVersion.value = modpack.mcVersion;
    form.elements.loaderVersion.value = modpack.loaderVersion;
  }
}

// ---------- Admins ----------

function renderAdmins() {
  if (state.admins.length === 0) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'Todavía no hay ninguna cuenta admin.';
    adminList.replaceChildren(li);
    return;
  }
  adminList.replaceChildren(
    ...state.admins.map((admin) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = admin.nick;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.dataset.admin = admin.id;
      del.textContent = '✕';
      del.setAttribute('aria-label', `Quitar a ${admin.nick} de admins`);
      li.append(name, del);
      return li;
    }),
  );
}

adminList.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-admin]');
  if (!button) return;
  button.disabled = true;
  run(() => api(`/api/panel/admins/${button.dataset.admin}`, { method: 'DELETE' }), 'Cuenta quitada de admins.');
});

document.getElementById('adminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('adminNick');
  const nick = input.value.trim();
  if (!nick) return;
  const ok = await run(() => api('/api/panel/admins', { method: 'POST', body: { nick } }), `${nick} ya es admin.`);
  if (ok) input.value = '';
});

// ---------- Jugadores ----------

const BAN_DURATIONS = [
  ['1', '1 hora'],
  ['24', '1 día'],
  ['72', '3 días'],
  ['168', '7 días'],
  ['720', '30 días'],
  ['', 'Sin fecha de fin'],
];
let playerFilter = '';

function playerUrl(player, suffix) {
  return `/api/panel/players/${encodeURIComponent(player.key)}${suffix}`;
}

function smallButton(text, className = 'btn btn-ghost btn-small') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  return button;
}

function playerRow(player) {
  const row = document.createElement('tr');
  const cell = (...children) => {
    const td = document.createElement('td');
    td.append(...children);
    row.append(td);
    return td;
  };

  const name = document.createElement('strong');
  name.textContent = player.name;
  const type = document.createElement('small');
  type.textContent = player.premium ? 'Cuenta Microsoft' : 'Sin premium';
  cell(name, type);
  cell(formatDate(player.lastSeen));
  cell(player.launcherVersion ? `v${player.launcherVersion}` : '—');

  const status = cell();
  if (player.admin) {
    const badge = document.createElement('span');
    badge.className = 'tag tag-admin';
    badge.textContent = 'Admin';
    status.append(badge);
  }
  if (player.ban) {
    const badge = document.createElement('span');
    badge.className = 'tag tag-ban';
    badge.textContent = player.ban.until ? `Suspendido hasta ${formatDate(player.ban.until)}` : 'Suspendido sin fecha de fin';
    status.append(badge);
    if (player.ban.reason) {
      const reason = document.createElement('small');
      reason.textContent = `Motivo: ${player.ban.reason}`;
      status.append(reason);
    }
  }
  if (!player.admin && !player.ban) status.append('—');

  const actions = cell();
  actions.className = 'player-actions';
  if (player.premium) {
    const admin = state.admins.find((a) => a.uuid === player.uuid);
    const toggle = smallButton(admin ? 'Quitar admin' : 'Hacer admin');
    toggle.addEventListener('click', () => {
      toggle.disabled = true;
      run(
        () =>
          admin
            ? api(`/api/panel/admins/${admin.id}`, { method: 'DELETE' })
            : api('/api/panel/admins', { method: 'POST', body: { nick: player.name } }),
        admin ? `${player.name} ya no es admin.` : `${player.name} ya es admin.`,
      );
    });
    actions.append(toggle);
  }
  if (player.ban) {
    const lift = smallButton('Quitar suspensión');
    lift.addEventListener('click', () => {
      lift.disabled = true;
      run(() => api(playerUrl(player, '/ban'), { method: 'DELETE' }), `${player.name} puede volver a usar el launcher.`);
    });
    actions.append(lift);
  } else {
    // Suspender pide duración y motivo: se despliega al pulsar.
    const box = document.createElement('details');
    box.className = 'ban-box';
    const summary = document.createElement('summary');
    summary.className = 'btn btn-ghost btn-small btn-danger';
    summary.textContent = 'Suspender';
    const form = document.createElement('form');
    const duration = document.createElement('select');
    duration.setAttribute('aria-label', `Duración de la suspensión de ${player.name}`);
    for (const [hours, label] of BAN_DURATIONS) duration.append(new Option(label, hours));
    duration.value = '24';
    const reason = document.createElement('input');
    reason.maxLength = 120;
    reason.placeholder = 'Motivo (lo verá el jugador)';
    reason.setAttribute('aria-label', `Motivo de la suspensión de ${player.name}`);
    const confirm = smallButton('Suspender', 'btn btn-small btn-ban');
    confirm.type = 'submit';
    form.append(duration, reason, confirm);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      confirm.disabled = true;
      // Se suelta el foco para que la tabla se repinte con el resultado.
      document.activeElement?.blur();
      run(
        () =>
          api(playerUrl(player, '/ban'), {
            method: 'PUT',
            body: { hours: duration.value ? Number(duration.value) : null, reason: reason.value },
          }),
        `${player.name} no puede usar el launcher.`,
      );
    });
    box.append(summary, form);
    actions.append(box);
  }
  return row;
}

function renderPlayers() {
  // No repintar la tabla mientras se rellena una suspensión.
  const rows = document.getElementById('playerRows');
  if (rows.contains(document.activeElement) && document.activeElement.closest('.ban-box')) return;
  const players = state.players || [];
  const shown = playerFilter ? players.filter((p) => p.name.toLowerCase().includes(playerFilter)) : players;
  rows.replaceChildren(...shown.map(playerRow));
  document.getElementById('playersEmpty').hidden = players.length > 0;
  document.querySelector('.players-scroll').hidden = players.length === 0;
  const admins = players.filter((p) => p.admin).length;
  const banned = players.filter((p) => p.ban).length;
  document.getElementById('playerCount').textContent =
    `${players.length} jugadores · ${admins} admin · ${banned} suspendidos`;
}

document.getElementById('playerFilter').addEventListener('input', (e) => {
  playerFilter = e.target.value.trim().toLowerCase();
  renderPlayers();
});

// ---------- Novedades y evento ----------

// Fecha ISO (UTC) -> valor de un <input type="datetime-local"> en hora local.
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderAnnouncements() {
  const active = document.activeElement;
  if (!document.getElementById('newsForm').contains(active)) {
    document.getElementById('newsText').value = (state.news && state.news.text) || '';
  }
  document.getElementById('newsDate').textContent =
    state.news && state.news.updatedAt ? `Publicado: ${formatDate(state.news.updatedAt)}` : 'Sin novedades publicadas.';
  if (!document.getElementById('eventForm').contains(active)) {
    document.getElementById('eventName').value = state.event ? state.event.name : '';
    document.getElementById('eventStart').value = state.event ? toLocalInput(state.event.start) : '';
    document.getElementById('eventHours').value = state.event ? state.event.hours : 3;
  }
  document.getElementById('eventClear').hidden = !state.event;
  if (document.activeElement !== document.getElementById('discordUrl')) {
    document.getElementById('discordUrl').value = state.discordUrl || '';
  }
}

document.getElementById('newsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = document.getElementById('newsText').value;
  run(() => api('/api/panel/news', { method: 'PUT', body: { text } }), text.trim() ? 'Novedades publicadas.' : 'Novedades quitadas.');
});

document.getElementById('eventForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('eventName').value.trim();
  const startValue = document.getElementById('eventStart').value;
  if (!name || !startValue) {
    toast('Pon el nombre del evento y cuándo empieza.', 'error');
    return;
  }
  // El campo da la hora local de quien lo rellena; se guarda en UTC.
  const start = new Date(startValue).toISOString();
  const hours = Number(document.getElementById('eventHours').value) || 3;
  run(() => api('/api/panel/event', { method: 'PUT', body: { event: { name, start, hours } } }), 'Evento guardado.');
});

document.getElementById('discordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = document.getElementById('discordUrl').value.trim();
  run(() => api('/api/panel/discord', { method: 'PUT', body: { url } }), url ? 'Enlace de Discord guardado.' : 'Enlace de Discord quitado.');
});

document.getElementById('eventClear').addEventListener('click', () => {
  run(() => api('/api/panel/event', { method: 'PUT', body: { event: null } }), 'Evento quitado.');
});

// ---------- Arranque ----------

function render() {
  for (const section of document.querySelectorAll('.pack')) renderPack(section);
  renderAdmins();
  renderPlayers();
  renderAnnouncements();
}

for (const section of document.querySelectorAll('.pack')) buildPack(section);
// Soltar un archivo fuera de la zona no debe hacer que el navegador lo abra.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
init();
