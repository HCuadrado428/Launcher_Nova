const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { forgeJar, makeZip } = require('../testlib/zip');

// Tests de la API contra un servidor real en un puerto libre, con Google,
// Mojang y Microsoft sustituidos por versiones falsas.

const OWNER = 'noovaasmp@gmail.com';
const UUID_ADMIN = 'a'.repeat(32);
const UUID_PLAYER = 'b'.repeat(32);

let server;
let base;
let dataDir;

function startApp(dir, extra = {}) {
  const app = createApp({
    ...extra,
    dataDir: dir,
    jwtSecret: 'x'.repeat(48),
    ownerEmail: OWNER,
    googleClientId: 'test-client',
    rateLimitMax: 1000,
    verifyGoogleCredential: async (credential) => {
      if (credential === 'google-owner') return { email: OWNER };
      if (credential === 'google-otro') return { email: 'otro@gmail.com' };
      throw new Error('credencial falsa');
    },
    fetchMinecraftProfile: async (token) => {
      if (token === 'ms-token-admin-000000000000') return { uuid: UUID_ADMIN, name: 'AdminNova' };
      if (token === 'ms-token-player-00000000000') return { uuid: UUID_PLAYER, name: 'Jugadora' };
      return null;
    },
    lookupMojangProfile: async (nick) => {
      if (nick.toLowerCase() === 'adminnova') return { uuid: UUID_ADMIN, name: 'AdminNova' };
      return null;
    },
  });
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), '.nova-server-'));
  server = await startApp(dataDir);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(pathname, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers, body: payload });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}

function fakeJar(content) {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(content)]);
}

function uploadForm(files) {
  const form = new FormData();
  for (const [name, buffer] of files) form.append('mods', new Blob([buffer]), name);
  return form;
}

const sha1 = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex');

async function login() {
  const owner = (await api('/api/panel/login', { method: 'POST', body: { credential: 'google-owner' } })).data.token;
  const admin = (await api('/api/auth/microsoft', { method: 'POST', body: { accessToken: 'ms-token-admin-000000000000' } }))
    .data.token;
  const player = (
    await api('/api/auth/microsoft', { method: 'POST', body: { accessToken: 'ms-token-player-00000000000' } })
  ).data.token;
  const offline = (await api('/api/auth/offline', { method: 'POST', body: { username: 'AdminNova' } })).data.token;
  return { owner, admin, player, offline };
}

test('el panel solo deja entrar al correo del dueño', async () => {
  const other = await api('/api/panel/login', { method: 'POST', body: { credential: 'google-otro' } });
  assert.equal(other.status, 403);
  const bad = await api('/api/panel/login', { method: 'POST', body: { credential: 'inventada' } });
  assert.equal(bad.status, 401);
  const ok = await api('/api/panel/login', { method: 'POST', body: { credential: 'google-owner' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.email, OWNER);
});

test('las rutas del panel rechazan a quien no es el dueño', async () => {
  const { player } = await login();
  assert.equal((await api('/api/panel/state')).status, 401);
  // Un token del launcher no sirve para el panel aunque esté bien firmado.
  assert.equal((await api('/api/panel/state', { token: player })).status, 401);
  const upload = await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: player,
    form: uploadForm([['a.jar', fakeJar('a')]]),
  });
  assert.equal(upload.status, 401);
  assert.equal((await api('/api/panel/admins', { method: 'POST', token: player, body: { nick: 'AdminNova' } })).status, 401);
});

test('un token de Microsoft que Minecraft no reconoce no inicia sesión', async () => {
  const res = await api('/api/auth/microsoft', { method: 'POST', body: { accessToken: 'token-robado-o-caducado-000' } });
  assert.equal(res.status, 401);
});

test('subir, sustituir y borrar mods actualiza el manifiesto', async () => {
  const { owner, player } = await login();
  const sodium = fakeJar('sodium v1');
  const jei = fakeJar('jei');

  const up = await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([
      ['sodium.jar', sodium],
      ['jei.jar', jei],
      ['leeme.txt', Buffer.from('hola')],
      ['falso.jar', Buffer.from('esto no es un zip')],
    ]),
  });
  assert.equal(up.status, 200);
  assert.deepEqual(
    up.data.results.map((r) => [r.filename, r.ok]),
    [
      ['sodium.jar', true],
      ['jei.jar', true],
      ['leeme.txt', false],
      ['falso.jar', false],
    ],
  );

  const first = await api('/api/modpacks/normal/manifest', { token: player });
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.data.mods.map((m) => m.filename),
    ['jei.jar', 'sodium.jar'],
  );
  assert.equal(first.data.mods[1].sha1, sha1(sodium));

  const file = await api(`/api/modpacks/normal/files/${sha1(sodium)}`, { token: player });
  assert.equal(file.status, 200);
  assert.ok(file.data.equals(sodium));

  // Mismo nombre, contenido nuevo: sustituye al anterior y cambia la huella.
  const sodium2 = fakeJar('sodium v2');
  const replace = await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([['sodium.jar', sodium2]]),
  });
  assert.equal(replace.data.results[0].replaced, true);
  const second = await api('/api/modpacks/normal/manifest', { token: player });
  assert.equal(second.data.mods.length, 2);
  assert.notEqual(second.data.versionHash, first.data.versionHash);
  assert.equal((await api(`/api/modpacks/normal/files/${sha1(sodium)}`, { token: player })).status, 404);
  // El .jar viejo deja de repartirse, pero se guarda mientras esté en el historial (para deshacer).
  assert.ok(fs.existsSync(path.join(dataDir, 'files', `${sha1(sodium)}.jar`)), 'el .jar viejo sigue para poder deshacer');

  const jeiMod = second.data.mods.find((m) => m.filename === 'jei.jar');
  const del = await api(`/api/panel/modpacks/normal/mods/${jeiMod.id}`, { method: 'DELETE', token: owner });
  assert.equal(del.status, 200);
  const third = await api('/api/modpacks/normal/manifest', { token: player });
  assert.deepEqual(
    third.data.mods.map((m) => m.filename),
    ['sodium.jar'],
  );
});

test('el modpack admin solo lo ven las cuentas Microsoft de la lista', async () => {
  const { owner, admin, player, offline } = await login();
  const tool = fakeJar('worldedit');
  await api('/api/panel/modpacks/admin/mods', { method: 'POST', token: owner, form: uploadForm([['worldedit.jar', tool]]) });

  // Antes de estar en la lista, ni siquiera la futura admin lo ve.
  assert.deepEqual(
    (await api('/api/modpacks', { token: admin })).data.modpacks.map((m) => m.id),
    ['normal'],
  );
  assert.equal((await api('/api/modpacks/admin/manifest', { token: admin })).status, 403);

  const missing = await api('/api/panel/admins', { method: 'POST', token: owner, body: { nick: 'NoExiste' } });
  assert.equal(missing.status, 404);
  const added = await api('/api/panel/admins', { method: 'POST', token: owner, body: { nick: 'adminnova' } });
  assert.equal(added.status, 200);
  assert.equal(added.data.admins[0].nick, 'AdminNova');

  const list = await api('/api/modpacks', { token: admin });
  assert.deepEqual(
    list.data.modpacks.map((m) => m.id),
    ['normal', 'admin'],
  );
  assert.equal(list.data.player.admin, true);
  assert.equal((await api(`/api/modpacks/admin/files/${sha1(tool)}`, { token: admin })).status, 200);

  // Otra cuenta premium, y una offline con el MISMO nick que la admin: nada.
  for (const token of [player, offline]) {
    assert.deepEqual(
      (await api('/api/modpacks', { token })).data.modpacks.map((m) => m.id),
      ['normal'],
    );
    assert.equal((await api('/api/modpacks/admin/manifest', { token })).status, 403);
    assert.equal((await api(`/api/modpacks/admin/files/${sha1(tool)}`, { token })).status, 403);
  }
  // El archivo del pack admin tampoco se puede pedir "a través" del normal.
  assert.equal((await api(`/api/modpacks/normal/files/${sha1(tool)}`, { token: player })).status, 404);

  // Quitar a la admin de la lista le corta el acceso con el mismo token.
  const adminId = added.data.admins[0].id;
  await api(`/api/panel/admins/${adminId}`, { method: 'DELETE', token: owner });
  assert.equal((await api('/api/modpacks/admin/manifest', { token: admin })).status, 403);
});

test('copiar los mods del modpack normal al de admins', async () => {
  const { owner } = await login();
  const res = await api('/api/panel/modpacks/admin/copy-from/normal', { method: 'POST', token: owner });
  assert.equal(res.status, 200);
  const [normal, admin] = res.data.modpacks;
  assert.deepEqual(
    admin.mods.map((m) => m.sha1),
    normal.mods.map((m) => m.sha1),
  );
});

test('los nombres con ruta no escapan de la carpeta de mods', async () => {
  const { owner, player } = await login();
  const up = await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([['../../fuera.jar', fakeJar('x')]]),
  });
  assert.equal(up.data.results[0].filename, 'fuera.jar');
  assert.equal((await api('/api/modpacks/normal/files/..%2F..%2Fdb.json', { token: player })).status, 404);
});

test('los datos sobreviven a un reinicio', async () => {
  const { player } = await login();
  const before = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  const second = await startApp(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${second.address().port}/api/modpacks/normal/manifest`, {
      headers: { Authorization: `Bearer ${player}` },
    });
    const afterRestart = await res.json();
    assert.equal(afterRestart.versionHash, before.versionHash);
    assert.equal(afterRestart.mods.length, before.mods.length);
  } finally {
    second.close();
  }
});

test('cambiar la versión de Forge valida el formato', async () => {
  const { owner } = await login();
  const bad = await api('/api/panel/modpacks/normal', { method: 'PATCH', token: owner, body: { loaderVersion: '47; rm -rf' } });
  assert.equal(bad.status, 400);
  const ok = await api('/api/panel/modpacks/normal', { method: 'PATCH', token: owner, body: { loaderVersion: '47.4.0' } });
  assert.equal(ok.data.modpacks[0].loaderVersion, '47.4.0');
});

test('otra versión del mismo mod sustituye a la anterior aunque cambie el nombre', async () => {
  const { owner, player } = await login();
  await api('/api/panel/modpacks/normal/mods', { method: 'DELETE', token: owner });
  await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([
      ['journeymap-5.10.3.jar', forgeJar('journeymap', 'v1')],
      ['create-0.5.1.jar', forgeJar('create')],
    ]),
  });
  const up = await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([['journeymap-5.10.4.jar', forgeJar('journeymap', 'v2')]]),
  });
  assert.deepEqual(up.data.results[0].replacedFiles, ['journeymap-5.10.3.jar']);
  const manifest = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  assert.deepEqual(
    manifest.mods.map((m) => [m.filename, m.modId]),
    [
      ['create-0.5.1.jar', 'create'],
      ['journeymap-5.10.4.jar', 'journeymap'],
    ],
  );
});

test('marcar un mod como opcional llega al manifiesto y se conserva al actualizarlo', async () => {
  const { owner, player } = await login();
  const before = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  const map = before.mods.find((m) => m.modId === 'journeymap');
  assert.ok(!map.optional);

  assert.equal((await api(`/api/panel/modpacks/normal/mods/${map.id}`, { method: 'PATCH', token: player, body: { optional: true } })).status, 401);
  assert.equal((await api(`/api/panel/modpacks/normal/mods/${map.id}`, { method: 'PATCH', token: owner, body: {} })).status, 400);
  const ok = await api(`/api/panel/modpacks/normal/mods/${map.id}`, {
    method: 'PATCH',
    token: owner,
    body: { optional: true, label: '  Minimapa ', description: 'Muestra el mapa en una esquina.' },
  });
  assert.equal(ok.status, 200);

  const after = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  assert.equal(after.mods.find((m) => m.modId === 'journeymap').optional, true);
  assert.notEqual(after.versionHash, before.versionHash);

  await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([['journeymap-5.10.5.jar', forgeJar('journeymap', 'v3')]]),
  });
  const updated = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  const newest = updated.mods.find((m) => m.modId === 'journeymap');
  assert.equal(newest.filename, 'journeymap-5.10.5.jar');
  assert.equal(newest.optional, true);
  assert.equal(newest.label, 'Minimapa', 'el nombre que ve el jugador se conserva');
  assert.equal(newest.description, 'Muestra el mapa en una esquina.');
});

test('al arrancar se rellena el modId de los mods que no lo tenían', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-backfill-'));
  const jar = forgeJar('farmersdelight');
  const hash = sha1(jar);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'files', `${hash}.jar`), jar);
  fs.writeFileSync(
    path.join(dir, 'db.json'),
    JSON.stringify({ modpacks: { normal: { mods: [{ id: 'm1', filename: 'farmers.jar', sha1: hash, size: jar.length }] } } }),
  );
  const s = await startApp(dir);
  try {
    const { token } = await (
      await fetch(`http://127.0.0.1:${s.address().port}/api/auth/offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Probando' }),
      })
    ).json();
    let mod;
    for (let i = 0; i < 40 && !(mod && mod.modId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/modpacks/normal/manifest`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      mod = (await res.json()).mods[0];
    }
    assert.equal(mod.modId, 'farmersdelight');
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('novedades y evento: los escribe el dueño y los ve cualquier jugador', async () => {
  const { owner, player, offline } = await login();
  assert.equal((await api('/api/panel/news', { method: 'PUT', token: player, body: { text: 'hola' } })).status, 401);
  assert.equal((await api('/api/panel/news', { method: 'PUT', token: owner, body: { text: 'x'.repeat(2000) } })).status, 400);
  assert.equal((await api('/api/panel/event', { method: 'PUT', token: owner, body: { event: { name: 'Raid', start: 'mañana' } } })).status, 400);

  await api('/api/panel/news', { method: 'PUT', token: owner, body: { text: '  Mods actualizados.\nEsta noche, evento.  ' } });
  const saved = await api('/api/panel/event', {
    method: 'PUT',
    token: owner,
    body: { event: { name: 'Be The Boss', start: '2027-01-10T22:00:00+01:00', hours: 4 } },
  });
  assert.equal(saved.status, 200);

  for (const token of [player, offline]) {
    const seen = (await api('/api/modpacks', { token })).data;
    assert.equal(seen.news.text, 'Mods actualizados.\nEsta noche, evento.');
    assert.ok(seen.news.updatedAt);
    assert.deepEqual(seen.event, { name: 'Be The Boss', start: '2027-01-10T21:00:00.000Z', hours: 4 });
  }

  assert.equal((await api('/api/panel/discord', { method: 'PUT', token: owner, body: { url: 'https://malo.example/x' } })).status, 400);
  assert.equal((await api('/api/panel/discord', { method: 'PUT', token: player, body: { url: 'https://discord.gg/nova' } })).status, 401);
  await api('/api/panel/discord', { method: 'PUT', token: owner, body: { url: 'https://discord.gg/nova2smp' } });
  assert.equal((await api('/api/modpacks', { token: player })).data.discordUrl, 'https://discord.gg/nova2smp');

  await api('/api/panel/event', { method: 'PUT', token: owner, body: { event: null } });
  await api('/api/panel/news', { method: 'PUT', token: owner, body: { text: '' } });
  const cleared = (await api('/api/modpacks', { token: player })).data;
  assert.equal(cleared.event, null);
  assert.deepEqual(cleared.news, { text: '', updatedAt: null });
});

test('el panel ve quién usa el launcher, con su versión y si es admin', async () => {
  const { owner, player } = await login();
  await fetch(`${base}/api/modpacks`, { headers: { Authorization: `Bearer ${player}`, 'X-Launcher-Version': '1.3.0' } });
  await api('/api/panel/admins', { method: 'POST', token: owner, body: { nick: 'AdminNova' } });

  assert.equal((await api('/api/panel/state', { token: player })).status, 401);
  const { players } = (await api('/api/panel/state', { token: owner })).data;
  const byKey = Object.fromEntries(players.map((p) => [p.key, p]));

  assert.equal(byKey[UUID_PLAYER].name, 'Jugadora');
  assert.equal(byKey[UUID_PLAYER].premium, true);
  assert.equal(byKey[UUID_PLAYER].launcherVersion, '1.3.0');
  assert.equal(byKey[UUID_PLAYER].admin, false);
  assert.equal(byKey[UUID_ADMIN].admin, true);
  // La cuenta sin premium con el mismo nick que la admin es otra persona.
  assert.equal(byKey['offline:adminnova'].premium, false);
  assert.equal(byKey['offline:adminnova'].admin, false);
  assert.ok(byKey[UUID_PLAYER].lastSeen >= byKey[UUID_PLAYER].firstSeen);
});

test('suspender a un jugador le corta el launcher hasta que caduca o se le quita', async () => {
  const { owner, player, admin } = await login();
  const banUrl = `/api/panel/players/${UUID_PLAYER}/ban`;

  assert.equal((await api(banUrl, { method: 'PUT', token: player, body: { hours: 1 } })).status, 401);
  assert.equal((await api('/api/panel/players/no-existe/ban', { method: 'PUT', token: owner, body: { hours: 1 } })).status, 404);
  assert.equal((await api(banUrl, { method: 'PUT', token: owner, body: { hours: -3 } })).status, 400);

  const banned = await api(banUrl, { method: 'PUT', token: owner, body: { hours: 24, reason: 'Romper la norma 3' } });
  assert.equal(banned.status, 200);
  const entry = banned.data.players.find((p) => p.key === UUID_PLAYER);
  assert.equal(entry.ban.reason, 'Romper la norma 3');
  assert.ok(new Date(entry.ban.until).getTime() > Date.now() + 23 * 3_600_000);

  // Ni con la sesión que ya tenía, ni abriendo una nueva.
  const list = await api('/api/modpacks', { token: player });
  assert.equal(list.status, 403);
  assert.equal(list.data.code, 'banned');
  assert.equal(list.data.reason, 'Romper la norma 3');
  assert.match(list.data.error, /suspendido hasta el .*Motivo: Romper la norma 3/);
  assert.equal((await api('/api/modpacks/normal/manifest', { token: player })).status, 403);
  const relogin = await api('/api/auth/microsoft', { method: 'POST', body: { accessToken: 'ms-token-player-00000000000' } });
  assert.equal(relogin.status, 403);
  // A los demás no les afecta.
  assert.equal((await api('/api/modpacks', { token: admin })).status, 200);

  assert.equal((await api(banUrl, { method: 'DELETE', token: owner })).status, 200);
  assert.equal((await api('/api/modpacks', { token: player })).status, 200);
  assert.equal((await api(banUrl, { method: 'DELETE', token: owner })).status, 404);

  // Sin duración no tiene fin; a una cuenta sin premium se la suspende por su nick.
  const offlineUrl = `/api/panel/players/${encodeURIComponent('offline:adminnova')}/ban`;
  const forever = await api(offlineUrl, { method: 'PUT', token: owner, body: { hours: null } });
  assert.equal(forever.data.players.find((p) => p.key === 'offline:adminnova').ban.until, null);
  const blocked = await api('/api/auth/offline', { method: 'POST', body: { username: 'ADMINNOVA' } });
  assert.equal(blocked.status, 403);
  await api(offlineUrl, { method: 'DELETE', token: owner });
});

test('una suspensión caducada deja de aplicarse sola', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ban-'));
  fs.writeFileSync(
    path.join(dir, 'db.json'),
    JSON.stringify({
      players: { 'offline:tardona': { name: 'Tardona', uuid: null, premium: false, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', launcherVersion: '' } },
      bans: { 'offline:tardona': { until: new Date(Date.now() - 60_000).toISOString(), reason: 'ya pasó', createdAt: '2026-01-01T00:00:00.000Z' } },
    }),
  );
  const s = await startApp(dir);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/auth/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Tardona' }),
    });
    assert.equal(res.status, 200);
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('la copia de seguridad se descarga y, restaurada, deja el panel como estaba', async () => {
  const { owner, player } = await login();
  await api('/api/panel/modpacks/normal/mods', { method: 'DELETE', token: owner });
  await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([
      ['create.jar', forgeJar('create', 'copia')],
      ['jei.jar', forgeJar('jei', 'copia')],
    ]),
  });
  await api('/api/panel/phrases', { method: 'PUT', token: owner, body: { text: ' Señal recuperada \n\nNo mires al Nova\n' } });
  const before = (await api('/api/panel/state', { token: owner })).data;
  assert.deepEqual(before.phrases, ['Señal recuperada', 'No mires al Nova']);

  // El enlace de descarga solo lo consigue el dueño y no vale un token cualquiera.
  assert.equal((await api('/api/panel/backup-link', { method: 'POST', token: player })).status, 401);
  assert.equal((await api(`/api/panel/backup?t=${player}`)).status, 401);
  const link = (await api('/api/panel/backup-link', { method: 'POST', token: owner })).data.url;
  const download = await fetch(base + link);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /nova-panel-copia-.*\.zip/);
  const zip = Buffer.from(await download.arrayBuffer());

  // Se estropea todo: mods fuera, frases fuera, un admin de más.
  await api('/api/panel/modpacks/normal/mods', { method: 'DELETE', token: owner });
  await api('/api/panel/phrases', { method: 'PUT', token: owner, body: { text: '' } });
  const createSha = before.modpacks[0].mods.find((m) => m.filename === 'create.jar').sha1;
  // ...y hasta se pierde el archivo del disco.
  fs.rmSync(path.join(dataDir, 'files', `${createSha}.jar`), { force: true });

  const restoreForm = () => {
    const form = new FormData();
    form.append('backup', new Blob([zip]), 'copia.zip');
    return form;
  };
  assert.equal((await api('/api/panel/restore', { method: 'POST', token: player, form: restoreForm() })).status, 401);
  const restored = await api('/api/panel/restore', { method: 'POST', token: owner, form: restoreForm() });
  assert.equal(restored.status, 200);

  const after = (await api('/api/panel/state', { token: owner })).data;
  assert.deepEqual(after.modpacks, before.modpacks);
  assert.deepEqual(after.admins, before.admins);
  assert.deepEqual(after.phrases, before.phrases);
  assert.deepEqual(
    after.players.map((p) => p.key).sort(),
    before.players.map((p) => p.key).sort(),
  );
  // Y los mods vuelven a poder descargarse.
  const file = await api(`/api/modpacks/normal/files/${createSha}`, { token: player });
  assert.equal(file.status, 200);
  assert.ok(file.data.equals(forgeJar('create', 'copia')));
});

test('una copia rota o ajena no cambia nada', async () => {
  const { owner } = await login();
  const before = (await api('/api/panel/state', { token: owner })).data;
  const send = async (buffer) => {
    const form = new FormData();
    form.append('backup', new Blob([buffer]), 'copia.zip');
    return api('/api/panel/restore', { method: 'POST', token: owner, form });
  };
  const sha = 'a'.repeat(40);
  const cases = [
    Buffer.from('esto no es un zip'),
    makeZip({ 'otra-cosa.txt': 'hola' }),
    makeZip({ 'db.json': '{ roto' }),
    // Nombra un mod que no viene en la copia ni está en el servidor.
    makeZip({ 'db.json': JSON.stringify({ modpacks: { normal: { mods: [{ id: 'x', filename: 'x.jar', sha1: sha, size: 1 }] } } }) }),
    // Trae el .jar, pero su contenido no coincide con su nombre.
    makeZip({
      'db.json': JSON.stringify({ modpacks: { normal: { mods: [{ id: 'x', filename: 'x.jar', sha1: sha, size: 1 }] } } }),
      [`files/${sha}.jar`]: 'contenido cambiado',
    }),
  ];
  for (const buffer of cases) {
    const res = await send(buffer);
    assert.equal(res.status, 400, res.data.error);
  }
  const after = (await api('/api/panel/state', { token: owner })).data;
  assert.deepEqual(after.modpacks, before.modpacks);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'tmp')), [], 'no quedan restos en tmp/');
});

test('los personajes son solo para admins y no pisan el nick de otro jugador', async () => {
  const { owner, admin, player } = await login();
  const put = (token, characters) => api('/api/me/characters', { method: 'PUT', token, body: { characters } });

  // Sin estar en la lista de admins, ni una cuenta premium puede tenerlos.
  await api('/api/panel/admins', { method: 'POST', token: owner, body: { nick: 'AdminNova' } });
  assert.equal((await put(player, ['Herrera_Nik'])).status, 403);

  const saved = await put(admin, ['Herrera_Nik', 'Maga_Nik']);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.characters, ['Herrera_Nik', 'Maga_Nik']);

  // Nicks mal escritos, repetidos o demasiados.
  assert.equal((await put(admin, ['a'])).status, 400);
  assert.equal((await put(admin, ['con espacio'])).status, 400);
  assert.equal((await put(admin, ['Maga_Nik', 'maga_nik'])).status, 400);
  assert.equal((await put(admin, Array.from({ length: 13 }, (_, i) => `Nick_${i}`))).status, 400);

  // El nick de otro jugador que ya usa el launcher no se puede coger.
  const other = (await api('/api/me', { token: player })).data.player.name;
  const clash = await put(admin, ['Herrera_Nik', other.toUpperCase()]);
  assert.equal(clash.status, 409);
  assert.equal(clash.data.code, 'nick-taken');

  // El dueño los ve en el panel junto a la admin, y siguen ahí tras otra visita.
  await api('/api/modpacks', { token: admin });
  const state = (await api('/api/panel/state', { token: owner })).data;
  const row = state.players.find((p) => p.admin);
  assert.deepEqual(row.characters, ['Herrera_Nik', 'Maga_Nik']);

  assert.equal((await put(admin, [])).status, 200);
  const after = (await api('/api/panel/state', { token: owner })).data;
  assert.equal(after.players.find((p) => p.admin).characters, undefined);
});

test('archivos de config y recursos: se suben en un zip, llegan al manifiesto y se pueden quitar', async () => {
  const { owner, player } = await login();
  const upload = (buffer, target, name = 'extras.zip') => {
    const form = new FormData();
    form.append('target', target);
    form.append('file', new Blob([buffer]), name);
    return api('/api/panel/modpacks/normal/files', { method: 'POST', token: owner, form });
  };
  const zip = await makeZip({
    'config/create/common.toml': 'velocidad = 2',
    'config/jei.toml': 'modo = "trampa"',
    'resourcepacks/Nova.zip': 'paquete',
    'mods/troyano.jar': 'no debe entrar',
    'leeme.txt': 'ni esto',
  });
  const before = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  const added = await upload(zip, 'zip');
  assert.equal(added.status, 200);
  assert.equal(added.data.added, 3);
  assert.equal(added.data.skipped, 2);

  const manifest = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  assert.deepEqual(
    manifest.files.map((f) => f.path),
    ['config/create/common.toml', 'config/jei.toml', 'resourcepacks/Nova.zip'],
  );
  assert.notEqual(manifest.versionHash, before.versionHash);
  const common = manifest.files[0];
  const file = await api(`/api/modpacks/normal/files/${common.sha1}`, { token: player });
  assert.equal(file.status, 200);
  assert.equal(file.data.toString(), 'velocidad = 2');

  // Un paquete de shaders suelto va tal cual a su carpeta; un destino inventado, no.
  assert.equal((await upload(Buffer.from('shaders'), 'shaderpacks', 'Complementary.zip')).status, 200);
  assert.equal((await upload(Buffer.from('x'), 'mods', 'malo.jar')).status, 400);
  assert.equal((await upload(Buffer.from('no soy un zip'), 'zip')).status, 400);
  assert.equal((await upload(await makeZip({ 'otra/cosa.txt': 'x' }), 'zip')).status, 400);
  // Un zip con rutas que intentan salir de la carpeta se rechaza entero.
  assert.equal((await upload(await makeZip({ 'config/a.toml': 'x', '../fuera.txt': 'x' }), 'zip')).status, 400);

  // Quitar una carpeta entera y un archivo suelto.
  const removed = await api('/api/panel/modpacks/normal/files/remove', {
    method: 'POST',
    token: owner,
    body: { paths: ['config/create', 'shaderpacks/Complementary.zip'] },
  });
  assert.equal(removed.status, 200);
  const after = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  assert.deepEqual(
    after.files.map((f) => f.path),
    ['config/jei.toml', 'resourcepacks/Nova.zip'],
  );
  assert.equal((await api(`/api/modpacks/normal/files/${common.sha1}`, { token: player })).status, 404);
  await api('/api/panel/modpacks/normal/files/remove', { method: 'POST', token: owner, body: { paths: ['config', 'resourcepacks'] } });
});

test('historial: cada cambio se guarda y se puede volver atrás', async () => {
  const { owner, player } = await login();
  await api('/api/panel/modpacks/normal/mods', { method: 'DELETE', token: owner });
  const good = fakeJar('mod bueno');
  await api('/api/panel/modpacks/normal/mods', { method: 'POST', token: owner, form: uploadForm([['bueno.jar', good]]) });
  const stable = (await api('/api/modpacks/normal/manifest', { token: player })).data;

  // Una actualización que lo rompe todo: se cambia el mod y se sube otro.
  const bad = fakeJar('mod roto');
  await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([
      ['bueno.jar', bad],
      ['extra.jar', fakeJar('extra')],
    ]),
  });
  const broken = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  assert.equal(broken.mods.length, 2);
  assert.equal((await api(`/api/modpacks/normal/files/${sha1(good)}`, { token: player })).status, 404);

  const state = (await api('/api/panel/state', { token: owner })).data;
  const entry = state.history.normal[0];
  assert.equal(entry.label, 'Antes de subir 2 mods');
  assert.equal(entry.modCount, 1);
  assert.ok(state.history.normal.length <= 15);

  const back = await api(`/api/panel/modpacks/normal/history/${entry.id}/restore`, { method: 'POST', token: owner });
  assert.equal(back.status, 200);
  const restored = (await api('/api/modpacks/normal/manifest', { token: player })).data;
  assert.equal(restored.versionHash, stable.versionHash);
  assert.equal((await api(`/api/modpacks/normal/files/${sha1(good)}`, { token: player })).status, 200);
  // Volver atrás también se puede deshacer.
  assert.equal(back.data.history.normal[0].modCount, 2);
  assert.equal((await api('/api/panel/modpacks/normal/history/no-existe/restore', { method: 'POST', token: owner })).status, 404);
});

test('el dueño puede quitar un personaje a un admin y no vuelve a ponerlo', async () => {
  const { owner, admin } = await login();
  await api('/api/panel/admins', { method: 'POST', token: owner, body: { nick: 'AdminNova' } });
  const put = (characters) => api('/api/me/characters', { method: 'PUT', token: admin, body: { characters } });
  assert.equal((await put(['Herrera_Nik', 'Maga_Nik'])).status, 200);
  const row = (await api('/api/panel/state', { token: owner })).data.players.find((p) => p.admin);
  const url = `/api/panel/players/${encodeURIComponent(row.key)}`;

  const blocked = await api(`${url}/characters/maga_nik`, { method: 'DELETE', token: owner });
  const after = blocked.data.players.find((p) => p.admin);
  assert.deepEqual(after.characters, ['Herrera_Nik']);
  assert.deepEqual(after.blockedCharacters, ['maga_nik']);

  // El launcher se entera al pedir los modpacks, y el servidor no acepta el nick.
  assert.deepEqual((await api('/api/modpacks', { token: admin })).data.blockedCharacters, ['maga_nik']);
  const again = await put(['Herrera_Nik', 'Maga_Nik']);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'nick-blocked');

  await api(`${url}/blocked-characters/Maga_Nik`, { method: 'DELETE', token: owner });
  assert.equal((await put(['Herrera_Nik', 'Maga_Nik'])).status, 200);
  await put([]);
});

test('estadísticas: actividad por día, versiones y mods opcionales desactivados', async () => {
  const { owner, player, offline } = await login();
  await api('/api/panel/modpacks/normal/mods', { method: 'DELETE', token: owner });
  await api('/api/panel/modpacks/normal/mods', {
    method: 'POST',
    token: owner,
    form: uploadForm([
      ['minimapa.jar', await forgeJar('minimapa')],
      ['base.jar', await forgeJar('base')],
    ]),
  });
  const mods = (await api('/api/panel/state', { token: owner })).data.modpacks[0].mods;
  const map = mods.find((m) => m.filename === 'minimapa.jar');
  await api(`/api/panel/modpacks/normal/mods/${map.id}`, { method: 'PATCH', token: owner, body: { optional: true, label: 'Minimapa' } });

  // Un jugador lo tiene desactivado (y cuela un mod que no es opcional); el otro, no.
  await api('/api/modpacks/normal/manifest?disabled=minimapa,base,inventado', { token: player });
  await api('/api/modpacks/normal/manifest?disabled=', { token: offline });

  const { stats } = (await api('/api/panel/state', { token: owner })).data;
  assert.equal(stats.days.length, 30);
  const today = stats.days[stats.days.length - 1];
  assert.equal(today.date, new Date().toISOString().slice(0, 10));
  assert.ok(today.players >= 2);
  assert.ok(stats.versions.reduce((sum, v) => sum + v.players, 0) >= 2);
  assert.deepEqual(stats.optional.normal, { players: 2, mods: [{ name: 'Minimapa', disabled: 1 }] });
});

test('CurseForge: sin clave no hay búsqueda; con clave se devuelve lo justo', async () => {
  const { player } = await login();
  assert.equal((await api('/api/modpacks', { token: player })).data.curseforge, false);
  assert.equal((await api('/api/curseforge/search?q=mapa&mc=1.20.1', { token: player })).status, 503);

  // Otro servidor, con una API de CurseForge falsa.
  const asked = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '.nova-cf-'));
  const other = await startApp(dir, {
    curseforge: async (pathname, params) => {
      asked.push({ pathname, params });
      if (pathname === '/v1/mods/search') {
        return {
          data: [
            { id: 238222, name: 'JEI', summary: 'Recetas', downloadCount: 9, logo: { thumbnailUrl: 'https://cdn/jei.png' } },
            { id: 5, name: 'Cerrado', summary: '', downloadCount: 1, allowModDistribution: false, secreto: 'no sale' },
          ],
        };
      }
      if (pathname === '/v1/mods/238222/files') {
        return {
          data: [
            { fileName: 'jei-viejo.jar', fileDate: '2024-01-01T00:00:00Z', downloadUrl: 'https://edge/viejo.jar', fileLength: 1 },
            {
              fileName: 'jei-nuevo.jar',
              fileDate: '2025-01-01T00:00:00Z',
              downloadUrl: 'https://edge/nuevo.jar',
              fileLength: 77,
              hashes: [
                { value: 'ABCDEF', algo: 2 },
                { value: 'A'.repeat(40), algo: 1 },
              ],
            },
            { fileName: 'fuentes.zip', fileDate: '2026-01-01T00:00:00Z', downloadUrl: 'https://edge/fuentes.zip' },
          ],
        };
      }
      if (pathname === '/v1/mods/5/files') return { data: [{ fileName: 'cerrado.jar', fileDate: '2025', downloadUrl: null }] };
      if (pathname === '/v1/mods/6/files') return { data: [] };
      throw new Error('caída');
    },
  });
  const mainBase = base;
  base = `http://127.0.0.1:${other.address().port}`;
  try {
    const token = (await api('/api/auth/offline', { method: 'POST', body: { username: 'Buscadora' } })).data.token;
    assert.equal((await api('/api/modpacks', { token })).data.curseforge, true);
    assert.equal((await api('/api/curseforge/search?q=jei&mc=1.20.1')).status, 401);

    const search = await api('/api/curseforge/search?q=jei&mc=1.20.1', { token });
    assert.deepEqual(search.data.hits, [
      { id: '238222', title: 'JEI', description: 'Recetas', downloads: 9, icon: 'https://cdn/jei.png', allowed: true },
      { id: '5', title: 'Cerrado', description: '', downloads: 1, icon: null, allowed: false },
    ]);
    assert.equal(asked[0].params.gameVersion, '1.20.1');
    assert.equal(asked[0].params.searchFilter, 'jei');

    const file = await api('/api/curseforge/mods/238222/file?mc=1.20.1', { token });
    assert.deepEqual(file.data, { filename: 'jei-nuevo.jar', url: 'https://edge/nuevo.jar', size: 77, sha1: 'a'.repeat(40) });
    const closed = await api('/api/curseforge/mods/5/file?mc=1.20.1', { token });
    assert.equal(closed.status, 409);
    assert.equal(closed.data.code, 'no-distribution');
    assert.equal((await api('/api/curseforge/mods/6/file?mc=1.20.1', { token })).status, 404);
    assert.equal((await api('/api/curseforge/mods/7/file?mc=1.20.1', { token })).status, 502);
    assert.equal((await api('/api/curseforge/mods/..%2Fgames/file?mc=1.20.1', { token })).status, 400);
  } finally {
    base = mainBase;
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
