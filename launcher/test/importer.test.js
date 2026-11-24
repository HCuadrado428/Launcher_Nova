const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { knownLocations, findInstances, resolveGameDir, inspect, importItems } = require('../main/importer');

function tree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('encuentra las instalaciones de otros launchers en sus carpetas de siempre', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-import-'));
  try {
    const appData = path.join(home, 'AppData', 'Roaming');
    tree(appData, {
      '.minecraft/options.txt': 'x',
      'ModrinthApp/profiles/Mi pack/saves/Mundo/level.dat': 'x',
      'ModrinthApp/profiles/vacio/nada.txt': 'x',
      // Prism guarda el juego dentro de la instancia.
      'PrismLauncher/instances/Create/.minecraft/options.txt': 'x',
    });
    tree(home, { 'curseforge/minecraft/Instances/All the Mods/mods/a.jar': 'x' });

    const found = findInstances(knownLocations({ platform: 'win32', home, appData }));
    assert.deepEqual(
      found.map((f) => [f.launcher, f.name]),
      [
        ['Minecraft', ''],
        ['Modrinth', 'Mi pack'],
        ['CurseForge', 'All the Mods'],
        ['Prism Launcher', 'Create'],
      ],
      'la carpeta que no parece un Minecraft no se ofrece',
    );
    assert.equal(found[3].path, path.join(appData, 'PrismLauncher', 'instances', 'Create', '.minecraft'));
    // Una carpeta elegida a mano también puede ser la instancia de Prism.
    assert.equal(resolveGameDir(path.join(appData, 'PrismLauncher', 'instances', 'Create')), found[3].path);
    assert.equal(resolveGameDir(path.join(home, 'no-existe')), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('trae lo elegido sin pisar lo que ya había, y los ajustes con copia de lo anterior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-import-'));
  try {
    const from = path.join(root, 'otro');
    const to = path.join(root, 'nova');
    tree(from, {
      'options.txt': 'key_forward:w\nlang:es_es',
      'saves/Mi mundo/level.dat': 'mundo viejo',
      'saves/Mi mundo/region/r.0.0.mca': 'trozo',
      'saves/Otro/level.dat': 'otro',
      'XaeroWaypoints/Multiplayer_xray.dathost.net/dim%0/waypoints.txt': 'casa',
      'journeymap/data/mp/Nova/waypoints/base.json': '{}',
      'journeymap/config/5.9/journeymap.core.config': 'no se trae',
      'player_models/mi-modelo.cpmmodel': 'modelo',
      'screenshots/2026-01-01.png': 'foto',
      'resourcepacks/Fiel.zip': 'zip',
      'mods/un-mod.jar': 'los mods no se traen',
      'config/algo.toml': 'la configuración de mods tampoco',
    });
    tree(to, {
      'options.txt': 'key_forward:z',
      'saves/Mi mundo/level.dat': 'mundo del launcher',
      'screenshots/ya-estaba.png': 'mía',
    });

    assert.deepEqual(
      inspect(from).map((c) => [c.id, c.count]),
      [
        ['options', 1],
        ['maps', 2],
        ['models', 1],
        ['resourcepacks', 1],
        ['screenshots', 1],
        ['worlds', 2],
      ],
    );

    const report = await importItems({ from, to, categories: ['options', 'maps', 'models', 'screenshots', 'worlds'] });
    assert.deepEqual(report.options, { copied: 1, skipped: 0 });
    assert.deepEqual(report.worlds, { copied: 2, skipped: 1 }, 'el level.dat que ya existía se respeta');
    assert.equal(report.resourcepacks, undefined, 'lo no marcado no se toca');

    // Ajustes: los nuevos, con copia de los de antes.
    assert.equal(read(to, 'options.txt'), 'key_forward:w\nlang:es_es');
    assert.equal(read(to, 'options.txt.antes-de-importar'), 'key_forward:z');
    // Mundos: el que ya estaba no se pisa; el que faltaba entra.
    assert.equal(read(to, 'saves/Mi mundo/level.dat'), 'mundo del launcher');
    assert.equal(read(to, 'saves/Otro/level.dat'), 'otro');
    // Mapas, modelos y capturas.
    assert.equal(read(to, 'XaeroWaypoints/Multiplayer_xray.dathost.net/dim%0/waypoints.txt'), 'casa');
    assert.equal(read(to, 'journeymap/data/mp/Nova/waypoints/base.json'), '{}');
    assert.equal(read(to, 'player_models/mi-modelo.cpmmodel'), 'modelo');
    assert.deepEqual(fs.readdirSync(path.join(to, 'screenshots')).sort(), ['2026-01-01.png', 'ya-estaba.png']);
    // Nada de mods, configuración ni lo que no estaba marcado.
    for (const rel of ['mods', 'config', 'resourcepacks', 'journeymap/config']) {
      assert.ok(!fs.existsSync(path.join(to, rel)), rel);
    }
    // El origen queda intacto: se copia, no se mueve.
    assert.equal(read(from, 'saves/Mi mundo/level.dat'), 'mundo viejo');

    // Repetir la importación no pierde la copia de los ajustes originales.
    await importItems({ from, to, categories: ['options'] });
    assert.equal(read(to, 'options.txt.antes-de-importar'), 'key_forward:z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no sigue enlaces ni importa una carpeta sobre sí misma', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-import-'));
  try {
    const from = path.join(root, 'otro');
    const to = path.join(root, 'nova');
    tree(root, { 'secreto.txt': 'fuera de la instalación' });
    tree(from, { 'screenshots/normal.png': 'foto' });
    fs.symlinkSync(path.join(root, 'secreto.txt'), path.join(from, 'screenshots', 'enlace.png'));
    await importItems({ from, to, categories: ['screenshots'] });
    assert.deepEqual(fs.readdirSync(path.join(to, 'screenshots')), ['normal.png']);
    await assert.rejects(importItems({ from, to: from, categories: ['screenshots'] }), /same-folder/);
    await assert.rejects(importItems({ from: path.join(root, 'no-existe'), to, categories: ['screenshots'] }), /missing-source/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
