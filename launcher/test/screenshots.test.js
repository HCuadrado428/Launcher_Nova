const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listScreenshots, shotPath, safeShotName, addPlaytime } = require('../main/screenshots');

test('lista las capturas, las más recientes primero, y nada más que imágenes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-shots-'));
  try {
    assert.deepEqual(listScreenshots(dir), [], 'sin carpeta de capturas no falla');
    const shots = path.join(dir, 'screenshots');
    fs.mkdirSync(path.join(shots, 'carpeta.png'), { recursive: true });
    const put = (name, ageMinutes) => {
      fs.writeFileSync(path.join(shots, name), 'x');
      const when = new Date(Date.now() - ageMinutes * 60_000);
      fs.utimesSync(path.join(shots, name), when, when);
    };
    put('2026-11-23_20.10.02.png', 30);
    put('2026-11-24_09.00.00.png', 5);
    put('vieja.JPG', 600);
    put('notas.txt', 1);
    assert.deepEqual(
      listScreenshots(dir).map((s) => s.name),
      ['2026-11-24_09.00.00.png', '2026-11-23_20.10.02.png', 'vieja.JPG'],
    );
    assert.equal(shotPath(dir, 'vieja.JPG'), path.join(shots, 'vieja.JPG'));
    assert.equal(shotPath(dir, 'no-existe.png'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('los nombres con ruta no salen de la carpeta de capturas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-shots-'));
  try {
    fs.mkdirSync(path.join(dir, 'screenshots'));
    fs.writeFileSync(path.join(dir, 'secreto.png'), 'x');
    for (const name of ['../secreto.png', '..\\secreto.png', 'sub/a.png', '.oculta.png', 'programa.exe', '', null]) {
      assert.equal(safeShotName(name), false, String(name));
      assert.equal(shotPath(dir, name), null);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el tiempo jugado se acumula por modpack', () => {
  const start = Date.UTC(2026, 10, 24, 10, 0, 0);
  let playtime = addPlaytime(undefined, 'normal', start, start + 90 * 60_000);
  assert.equal(playtime.normal.seconds, 5400);
  playtime = addPlaytime(playtime, 'normal', start, start + 30_000);
  playtime = addPlaytime(playtime, 'admin', start, start + 60_000);
  assert.equal(playtime.normal.seconds, 5430);
  assert.equal(playtime.admin.seconds, 60);
  assert.equal(playtime.normal.lastPlayed, new Date(start + 30_000).toISOString());
  // Un reloj que va hacia atrás no resta tiempo.
  assert.equal(addPlaytime(playtime, 'normal', start, start - 5000).normal.seconds, 5430);
});
