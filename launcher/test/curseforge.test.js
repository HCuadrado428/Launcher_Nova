const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { searchResults, installMod, isCurseforgeId } = require('../main/curseforge');
const { loadRegistry } = require('../main/modrinth');
const { forgeJar } = require('../../server/testlib/zip');

let server;
let origin;
const files = {};
const sha1 = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex');

before(async () => {
  files['/minimapa-1.jar'] = await forgeJar('minimapa');
  files['/minimapa-2.jar'] = Buffer.concat([await forgeJar('minimapa'), Buffer.from('v2')]);
  files['/create.jar'] = await forgeJar('create');
  server = http.createServer((req, res) => {
    const body = files[req.url];
    if (!body) return res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const fileFor = (name) => ({ filename: name.slice(1), url: origin + name, size: files[name].length, sha1: sha1(files[name]) });

test('los resultados de CurseForge se dejan con la forma del buscador', () => {
  const results = searchResults([
    { id: '238222', title: 'JEI', description: 'Recetas', downloads: 5, icon: 'https://media.forgecdn.net/a.png', allowed: true },
    { id: '7', title: 'Cerrado', icon: 'https://otro.sitio/a.png', allowed: false },
    { id: '../x', title: 'Raro' },
  ]);
  assert.deepEqual(results, [
    { id: 'cf:238222', slug: '', title: 'JEI', description: 'Recetas', iconUrl: 'https://media.forgecdn.net/a.png', downloads: 5, blocked: false },
    { id: 'cf:7', slug: '', title: 'Cerrado', description: '', iconUrl: '', downloads: 0, blocked: true },
  ]);
  assert.ok(isCurseforgeId('cf:238222'));
  assert.ok(!isCurseforgeId('AANobbMI'));
  assert.ok(!isCurseforgeId('cf:../x'));
});

test('instala un mod de CurseForge, lo actualiza y no duplica los del modpack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cf-'));
  const options = { instanceDir: dir, downloadOrigins: [origin], manifestMods: [{ filename: 'create-0.5.jar', sha1: 'b'.repeat(40), modId: 'create' }] };

  const first = await installMod({ ...options, projectId: 'cf:1', title: 'Minimapa', file: fileFor('/minimapa-1.jar') });
  assert.deepEqual(first, [{ title: 'Minimapa', filename: 'minimapa-1.jar' }]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')), ['minimapa-1.jar']);

  // Una versión nueva del mismo mod quita la anterior.
  await installMod({ ...options, projectId: 'cf:1', title: 'Minimapa', file: fileFor('/minimapa-2.jar') });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')), ['minimapa-2.jar']);
  assert.deepEqual(loadRegistry(dir), { 'minimapa-2.jar': { projectId: 'cf:1', title: 'Minimapa' } });

  // Un mod que el modpack ya trae (se reconoce al abrir el .jar) no se instala.
  await assert.rejects(installMod({ ...options, projectId: 'cf:2', title: 'Create', file: fileFor('/create.jar') }));
  // Un archivo que no coincide con su huella, o de otro servidor, tampoco.
  await assert.rejects(installMod({ ...options, projectId: 'cf:3', title: 'Roto', file: { ...fileFor('/minimapa-1.jar'), sha1: 'c'.repeat(40) } }));
  await assert.rejects(installMod({ ...options, projectId: 'cf:4', title: 'Ajeno', file: { ...fileFor('/minimapa-1.jar'), url: 'https://malo.example/minimapa-1.jar' } }));
  await assert.rejects(installMod({ ...options, projectId: 'cf:5', title: 'Sin huella', file: { ...fileFor('/minimapa-1.jar'), sha1: null } }));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')), ['minimapa-2.jar']);
});
