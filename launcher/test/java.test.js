const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { ensureJava, runtimeFor, javaMajor } = require('../main/java');

test('cada versión de Minecraft pide su Java', () => {
  assert.equal(runtimeFor('1.20.1').major, 17);
  assert.equal(runtimeFor('1.16.5').major, 8);
  assert.equal(runtimeFor('1.17.1').major, 16);
  assert.equal(runtimeFor('1.21.1').major, 21);
});

// Descarga un "Java" de mentira desde un servidor local que imita el índice
// de runtimes de Mojang. Comprueba el camino entero: índice -> manifiesto ->
// descarga con verificación -> ejecutable listo.
test('descarga el Java de Mojang la primera vez y luego lo reutiliza', { skip: process.platform === 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-java-'));
  const files = {
    'bin/java': '#!/bin/sh\necho \'openjdk version "17.0.8" 2023-07-18\' >&2\n',
    'lib/modules': 'contenido',
  };
  const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/all.json') {
      const entry = [{ manifest: { url: `${base}/manifest.json` }, version: { name: '17.0.8' } }];
      const platforms = ['linux', 'linux-i386', 'mac-os', 'mac-os-arm64'];
      return res.end(JSON.stringify(Object.fromEntries(platforms.map((p) => [p, { 'java-runtime-gamma': entry }]))));
    }
    if (req.url === '/manifest.json') {
      const out = { bin: { type: 'directory' }, lib: { type: 'directory' } };
      for (const [name, text] of Object.entries(files)) {
        out[process.platform === 'darwin' ? `jre.bundle/Contents/Home/${name}` : name] = {
          type: 'file',
          executable: name.startsWith('bin/'),
          downloads: { raw: { url: `${base}/f/${name}`, sha1: sha1(text), size: Buffer.byteLength(text) } },
        };
      }
      return res.end(JSON.stringify({ files: out }));
    }
    const text = files[req.url.replace('/f/', '')];
    if (text === undefined) return res.writeHead(404).end();
    res.end(text);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const options = {
    runtimeDir: tmp,
    mcVersion: '1.20.1',
    customPath: '',
    runtimeIndexUrl: `http://127.0.0.1:${server.address().port}/all.json`,
  };
  try {
    const first = await ensureJava(options);
    assert.ok(fs.existsSync(first.javaPath));
    assert.equal(await javaMajor(first.javaPath), 17);

    const before = requests;
    const second = await ensureJava(options);
    assert.equal(second.javaPath, first.javaPath);
    assert.equal(requests, before, 'la segunda vez no descarga nada');

    // Un Java elegido a mano de otra versión avisa, pero se respeta.
    const custom = await ensureJava({ ...options, mcVersion: '1.21.1', customPath: first.javaPath });
    assert.deepEqual(custom.warning, { found: 17, wanted: 21 });
    await assert.rejects(ensureJava({ ...options, customPath: path.join(tmp, 'no-existe') }), /ya no existe/);
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
