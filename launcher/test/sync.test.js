const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server/src/app');
const { makeZip } = require('../../server/testlib/zip');
const api = require('../main/api');
const { syncMods, planSync, loadMeta, safeModFilename, modKey, saveMeta } = require('../main/sync');
const { forgeJar } = require('../../server/testlib/zip');

// La sincronización del launcher contra el backend de verdad (carpeta
// server/), arrancado en un puerto libre con Google/Mojang/Microsoft falsos.

const ADMIN_UUID = 'c'.repeat(32);
let server;
let base;
let tmp;
let ownerToken;

function jar(text) {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(text)]);
}

async function panel(pathname, { method = 'POST', files, body } = {}) {
  const headers = { Authorization: `Bearer ${ownerToken}` };
  let payload;
  if (files) {
    payload = new FormData();
    for (const [name, buffer] of files) payload.append('mods', new Blob([buffer]), name);
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers, body: payload });
  assert.ok(res.ok, `${method} ${pathname} -> ${res.status}`);
  return res.json();
}

async function sync(token, modpackId, instanceDir, disabled = []) {
  const manifest = await api.getManifest(base, token, modpackId);
  const progress = [];
  const result = await syncMods({
    instanceDir,
    manifest,
    disabled,
    download: (mod, dest) => api.downloadMod(base, token, modpackId, mod.sha1, dest),
    onProgress: (p) => progress.push(p),
  });
  return { ...result, manifest, progress };
}

const modsIn = (dir) => fs.readdirSync(path.join(dir, 'mods')).sort();

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-launcher-'));
  const app = createApp({
    dataDir: path.join(tmp, 'server'),
    jwtSecret: 'y'.repeat(48),
    ownerEmail: 'noovaasmp@gmail.com',
    rateLimitMax: 1000,
    verifyGoogleCredential: async () => ({ email: 'noovaasmp@gmail.com' }),
    fetchMinecraftProfile: async (token) =>
      token.startsWith('admin') ? { uuid: ADMIN_UUID, name: 'Hugo' } : { uuid: 'd'.repeat(32), name: 'Amiga' },
    lookupMojangProfile: async () => ({ uuid: ADMIN_UUID, name: 'Hugo' }),
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/panel/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: 'x' }),
  });
  ownerToken = (await login.json()).token;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('instala, actualiza y limpia los mods siguiendo al panel', async () => {
  const { token } = await api.loginOffline(base, 'Jugador_1');
  const dir = path.join(tmp, 'inst-normal');

  await panel('/api/panel/modpacks/normal/mods', {
    files: [
      ['create.jar', jar('create 1')],
      ['jei.jar', jar('jei 1')],
    ],
  });
  const first = await sync(token, 'normal', dir);
  assert.equal(first.downloaded, 2);
  assert.deepEqual(modsIn(dir), ['create.jar', 'jei.jar']);
  assert.ok(fs.readFileSync(path.join(dir, 'mods', 'create.jar')).equals(jar('create 1')));
  assert.equal(loadMeta(dir).versionHash, first.manifest.versionHash);

  // Sin cambios en el panel: no se baja nada.
  const again = await sync(token, 'normal', dir);
  assert.deepEqual([again.downloaded, again.deleted], [0, 0]);

  // El jugador mete un mod suyo; el dueño actualiza uno, quita otro y añade otro.
  fs.writeFileSync(path.join(dir, 'mods', 'mi-minimapa.jar'), 'mío');
  const state = await panel('/api/panel/modpacks/normal/mods', {
    files: [
      ['create.jar', jar('create 2')],
      ['farmers.jar', jar('farmers')],
    ],
  });
  const jei = state.modpacks[0].mods.find((m) => m.filename === 'jei.jar');
  await panel(`/api/panel/modpacks/normal/mods/${jei.id}`, { method: 'DELETE' });

  const update = await sync(token, 'normal', dir);
  assert.deepEqual([update.downloaded, update.deleted], [2, 1]);
  assert.deepEqual(modsIn(dir), ['create.jar', 'farmers.jar', 'mi-minimapa.jar']);
  assert.ok(fs.readFileSync(path.join(dir, 'mods', 'create.jar')).equals(jar('create 2')));
  const last = update.progress.at(-1);
  assert.equal(last.doneFiles, 2);
  assert.equal(last.doneBytes, last.totalBytes);

  // Si se borra un mod a mano, la siguiente sincronización lo repone.
  fs.rmSync(path.join(dir, 'mods', 'farmers.jar'));
  const repair = await sync(token, 'normal', dir);
  assert.equal(repair.downloaded, 1);
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'farmers.jar')));
});

test('el modpack admin solo se puede sincronizar con una cuenta admin', async () => {
  await panel('/api/panel/modpacks/admin/mods', { files: [['worldedit.jar', jar('we')]] });
  await panel('/api/panel/admins', { body: { nick: 'Hugo' } });

  const admin = await api.loginMicrosoft(base, 'admin-token-000000000000000');
  assert.equal(admin.player.admin, true);
  const list = await api.listModpacks(base, admin.token);
  assert.deepEqual(
    list.modpacks.map((m) => m.id),
    ['normal', 'admin'],
  );
  const dir = path.join(tmp, 'inst-admin');
  await sync(admin.token, 'admin', dir);
  assert.deepEqual(modsIn(dir), ['worldedit.jar']);

  const friend = await api.loginMicrosoft(base, 'amiga-token-000000000000000');
  assert.equal(friend.player.admin, false);
  await assert.rejects(sync(friend.token, 'admin', path.join(tmp, 'inst-x')), (err) => err.status === 403);
  // Un nick offline igual al de la admin tampoco cuela.
  const fake = await api.loginOffline(base, 'Hugo');
  await assert.rejects(api.getManifest(base, fake.token, 'admin'), (err) => err.status === 403);
});

test('una descarga dañada no se queda en la carpeta de mods', async () => {
  const dir = path.join(tmp, 'inst-roto');
  const manifest = { versionHash: 'h', mods: [{ filename: 'roto.jar', sha1: 'a'.repeat(40), size: 4 }] };
  await assert.rejects(
    syncMods({ instanceDir: dir, manifest, download: async (mod, dest) => fs.writeFileSync(dest, 'otro') }),
    /dañado/,
  );
  assert.deepEqual(modsIn(dir), []);
  assert.equal(loadMeta(dir).versionHash, null);
});

test('un manifiesto con rutas raras se rechaza entero', async () => {
  const dir = path.join(tmp, 'inst-rutas');
  for (const filename of ['../fuera.jar', '..\\fuera.jar', 'sub/mod.jar', 'script.exe', '.oculto.jar']) {
    assert.equal(safeModFilename(filename), false, filename);
    const manifest = { versionHash: 'h', mods: [{ filename, sha1: 'a'.repeat(40), size: 1 }] };
    await assert.rejects(syncMods({ instanceDir: dir, manifest, download: async () => assert.fail('no debe descargar') }));
  }
  assert.ok(!fs.existsSync(path.join(tmp, 'fuera.jar')));
});

test('planSync solo toca los mods que puso el launcher', () => {
  const local = [
    { filename: 'a.jar', sha1: '1' },
    { filename: 'b.jar', sha1: '2' },
  ];
  const remote = [
    { filename: 'A.jar', sha1: '1' },
    { filename: 'c.jar', sha1: '3' },
  ];
  const plan = planSync(local, remote, ['a.jar', 'b.jar', 'propio.jar']);
  assert.deepEqual(
    plan.toDelete.map((m) => m.filename),
    ['b.jar'],
  );
  assert.deepEqual(
    plan.toDownload.map((m) => m.filename),
    ['c.jar'],
  );
});

test('un opcional desactivado no se baja, ni vuelve cuando el dueño lo actualiza', async () => {
  const { token } = await api.loginOffline(base, 'Jugador_2');
  const dir = path.join(tmp, 'inst-opcional');
  await panel('/api/panel/modpacks/normal/mods', { method: 'DELETE' });
  const state = await panel('/api/panel/modpacks/normal/mods', {
    files: [
      ['create-0.5.1.jar', forgeJar('create')],
      ['journeymap-5.10.3.jar', forgeJar('journeymap', 'v1')],
    ],
  });
  const map = state.modpacks[0].mods.find((m) => m.modId === 'journeymap');
  await panel(`/api/panel/modpacks/normal/mods/${map.id}`, { method: 'PATCH', body: { optional: true } });

  // Por defecto los opcionales vienen puestos.
  await sync(token, 'normal', dir);
  assert.deepEqual(modsIn(dir), ['create-0.5.1.jar', 'journeymap-5.10.3.jar']);

  // El jugador lo desactiva: se borra y no se repone.
  const disabled = [modKey({ modId: 'journeymap', filename: 'journeymap-5.10.3.jar' })];
  const off = await sync(token, 'normal', dir, disabled);
  assert.deepEqual([off.downloaded, off.deleted], [0, 1]);
  assert.deepEqual(modsIn(dir), ['create-0.5.1.jar']);
  assert.equal(loadMeta(dir).versionHash, off.manifest.versionHash, 'queda al día aunque le falte el opcional');
  assert.equal((await sync(token, 'normal', dir, disabled)).downloaded, 0);

  // El dueño sube una versión nueva con otro nombre: sigue desactivado.
  await panel('/api/panel/modpacks/normal/mods', { files: [['journeymap-5.10.4.jar', forgeJar('journeymap', 'v2')]] });
  await sync(token, 'normal', dir, disabled);
  assert.deepEqual(modsIn(dir), ['create-0.5.1.jar']);

  // Un mod obligatorio no se puede quitar aunque esté en la lista de desactivados.
  await sync(token, 'normal', dir, [...disabled, 'create']);
  assert.deepEqual(modsIn(dir), ['create-0.5.1.jar']);

  // Al volver a activarlo se baja la versión actual.
  const on = await sync(token, 'normal', dir, []);
  assert.equal(on.downloaded, 1);
  assert.deepEqual(modsIn(dir), ['create-0.5.1.jar', 'journeymap-5.10.4.jar']);
});

async function uploadExtras(files) {
  const form = new FormData();
  form.append('target', 'zip');
  form.append('file', new Blob([await makeZip(files)]), 'extras.zip');
  const res = await fetch(`${base}/api/panel/modpacks/normal/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: form,
  });
  assert.ok(res.ok, `subida de archivos -> ${res.status}`);
}

test('config y recursos: se reparten, y lo que retoca el jugador se respeta hasta que el dueño lo cambia', async () => {
  const { token } = await api.loginOffline(base, 'Jugador_cfg');
  const dir = path.join(tmp, 'inst-config');
  const read = (name) => fs.readFileSync(path.join(dir, ...name.split('/')), 'utf8');
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, ...name.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(dir, ...name.split('/')), text);
  };

  // El mod ya había creado su config por defecto antes de que el dueño subiera la suya.
  write('config/create/common.toml', 'por defecto');
  write('config/otro-mod.toml', 'no es del modpack');
  await uploadExtras({
    'config/create/common.toml': 'velocidad = 2',
    'config/jei.toml': 'modo = 1',
    'resourcepacks/Nova.zip': 'paquete v1',
  });
  const first = await sync(token, 'normal', dir);
  assert.equal(first.files, 3);
  assert.equal(read('config/create/common.toml'), 'velocidad = 2');
  assert.equal(read('resourcepacks/Nova.zip'), 'paquete v1');
  assert.equal(read('config/otro-mod.toml'), 'no es del modpack');
  assert.equal(first.progress.at(-1).doneFiles, first.progress.at(-1).totalFiles);

  // El jugador retoca una config: mientras el dueño no la cambie, se queda como él la dejó.
  write('config/jei.toml', 'modo = 2 (a mi gusto)');
  assert.equal((await sync(token, 'normal', dir)).files, 0);
  assert.equal(read('config/jei.toml'), 'modo = 2 (a mi gusto)');

  // El dueño cambia esa config y el paquete de recursos, y deja de repartir create.
  await uploadExtras({ 'config/jei.toml': 'modo = 3', 'resourcepacks/Nova.zip': 'paquete v2' });
  await panel('/api/panel/modpacks/normal/files/remove', { body: { paths: ['config/create'] } });
  // ...y el jugador borra por error el paquete de recursos.
  fs.rmSync(path.join(dir, 'resourcepacks', 'Nova.zip'));
  const update = await sync(token, 'normal', dir);
  assert.equal(update.files, 2);
  assert.equal(update.filesDeleted, 1);
  assert.equal(read('config/jei.toml'), 'modo = 3');
  assert.equal(read('resourcepacks/Nova.zip'), 'paquete v2');
  assert.ok(!fs.existsSync(path.join(dir, 'config', 'create', 'common.toml')), 'lo que ya no se reparte y no se ha tocado, se quita');

  // «Restablecer configuración» olvida lo que se le puso: vuelve la versión del modpack.
  write('config/jei.toml', 'modo = 9 (lo he roto)');
  assert.equal((await sync(token, 'normal', dir)).files, 0);
  saveMeta(dir, { ...loadMeta(dir), files: [] });
  assert.equal((await sync(token, 'normal', dir)).files, 1);
  assert.equal(read('config/jei.toml'), 'modo = 3');

  // Lo que deja de repartirse pero el jugador había retocado, se le deja.
  write('config/jei.toml', 'modo = 4 (mío)');
  await panel('/api/panel/modpacks/normal/files/remove', { body: { paths: ['config/jei.toml'] } });
  const last = await sync(token, 'normal', dir);
  assert.equal(last.filesDeleted, 0);
  assert.equal(read('config/jei.toml'), 'modo = 4 (mío)');
  assert.deepEqual(
    loadMeta(dir).files.map((f) => f.path),
    ['resourcepacks/Nova.zip'],
  );
  await panel('/api/panel/modpacks/normal/files/remove', { body: { paths: ['resourcepacks'] } });
});

test('un archivo del manifiesto que sale de sus carpetas se rechaza', async () => {
  const dir = path.join(tmp, 'inst-rutas');
  for (const bad of ['../fuera.txt', 'mods/troyano.jar', 'config/../../fuera', 'config\\x.toml', 'options.txt', '/etc/passwd']) {
    await assert.rejects(
      syncMods({
        instanceDir: dir,
        manifest: { versionHash: 'x', mods: [], files: [{ path: bad, sha1: 'a'.repeat(40), size: 1 }] },
        download: async () => assert.fail('no debe descargar nada'),
      }),
      undefined,
      bad,
    );
  }
});
