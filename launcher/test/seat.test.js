const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareSeat } = require('../main/seat');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-seat-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('la segunda ventana comparte mods y mundos, y copia la configuración', () => {
  const root = tree({
    'admin/mods/worldedit.jar': 'mod',
    'admin/player_models/maga.cpmmodel': 'modelo',
    'admin/saves/Pruebas/level.dat': 'mundo',
    'admin/config/cpm.json': '{"selectedModel":"herrera.cpmmodel"}',
    'admin/config/create/common.toml': 'velocidad = 2',
    'admin/options.txt': 'fov:90',
  });
  const main = path.join(root, 'admin');
  const seat = path.join(root, 'admin-2');
  prepareSeat(main, seat);

  // Compartido: lo que se escribe por un lado se ve por el otro.
  assert.ok(fs.lstatSync(path.join(seat, 'mods')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(seat, 'mods', 'worldedit.jar'), 'utf8'), 'mod');
  fs.writeFileSync(path.join(main, 'mods', 'nuevo.jar'), 'otro');
  assert.ok(fs.existsSync(path.join(seat, 'mods', 'nuevo.jar')));
  assert.ok(fs.existsSync(path.join(seat, 'saves', 'Pruebas', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(seat, 'resourcepacks')), 'lo que la principal no tiene no se inventa');

  // Copiado: cambiar el modelo en la segunda no toca la principal.
  assert.ok(!fs.lstatSync(path.join(seat, 'config')).isSymbolicLink());
  fs.writeFileSync(path.join(seat, 'config', 'cpm.json'), '{"selectedModel":"maga.cpmmodel"}');
  fs.writeFileSync(path.join(seat, 'config', 'solo-aqui.toml'), 'x');
  assert.match(fs.readFileSync(path.join(main, 'config', 'cpm.json'), 'utf8'), /herrera/);
  assert.equal(fs.readFileSync(path.join(seat, 'options.txt'), 'utf8'), 'fov:90');

  // Al abrirla otra vez vuelve a ser un espejo de la principal.
  fs.writeFileSync(path.join(main, 'config', 'create', 'common.toml'), 'velocidad = 3');
  prepareSeat(main, seat);
  assert.equal(fs.readFileSync(path.join(seat, 'config', 'create', 'common.toml'), 'utf8'), 'velocidad = 3');
  assert.match(fs.readFileSync(path.join(seat, 'config', 'cpm.json'), 'utf8'), /herrera/);
  assert.ok(!fs.existsSync(path.join(seat, 'config', 'solo-aqui.toml')));
  // ...y la principal sigue entera.
  assert.deepEqual(fs.readdirSync(path.join(main, 'mods')).sort(), ['nuevo.jar', 'worldedit.jar']);
  assert.equal(fs.readFileSync(path.join(main, 'saves', 'Pruebas', 'level.dat'), 'utf8'), 'mundo');
});

test('con la principal recién creada también se puede preparar', () => {
  const root = tree({});
  prepareSeat(path.join(root, 'admin'), path.join(root, 'admin-2'));
  assert.ok(fs.existsSync(path.join(root, 'admin', 'mods')));
  assert.ok(fs.existsSync(path.join(root, 'admin-2', 'mods')));
  assert.ok(fs.statSync(path.join(root, 'admin-2', 'config')).isDirectory());
});
