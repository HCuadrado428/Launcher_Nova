const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { forgeJar } = require('../testlib/zip');

// Tests de la API contra un servidor real en un puerto libre, con Google,
// Mojang y Microsoft sustituidos por versiones falsas.

const OWNER = 'noovaasmp@gmail.com';
const UUID_ADMIN = 'a'.repeat(32);
const UUID_PLAYER = 'b'.repeat(32);

let server;
let base;
let dataDir;

function startApp(dir) {
  const app = createApp({
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
  assert.ok(!fs.existsSync(path.join(dataDir, 'files', `${sha1(sodium)}.jar`)), 'el .jar viejo se borra del disco');

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
