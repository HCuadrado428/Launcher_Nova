const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listModels, selectModel, normalizeCharacters, findCharacter } = require('../main/characters');
const { launchOptions, offlineUuid } = require('../main/launch');

function instance(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-pj-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('lista los modelos de CPM como los nombra el mod', () => {
  const dir = instance({
    'player_models/herrera.cpmmodel': 'x',
    'player_models/magia/maga.cpmmodel': 'x',
    'player_models/.temp.cpmmodel': 'x',
    'player_models/autosaves/viejo.cpmmodel': 'x',
    'player_models/notas.txt': 'x',
  });
  assert.deepEqual(listModels(dir), ['herrera.cpmmodel', 'magia/maga.cpmmodel']);
  assert.deepEqual(listModels(instance({})), []);
});

test('elegir modelo cambia solo esa clave de cpm.json', () => {
  const dir = instance({
    'player_models/herrera.cpmmodel': 'x',
    'player_models/magia/maga.cpmmodel': 'x',
    'config/cpm.json': JSON.stringify({ selectedModel: 'herrera.cpmmodel', keybinds: { gesture: 71 } }),
  });
  assert.equal(selectModel(dir, 'magia/maga.cpmmodel'), true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config/cpm.json'), 'utf8'));
  assert.deepEqual(saved, { selectedModel: 'magia/maga.cpmmodel', keybinds: { gesture: 71 } });

  // Un modelo que ya no está, o una ruta que sale de la carpeta, no toca nada.
  assert.equal(selectModel(dir, 'borrado.cpmmodel'), false);
  assert.equal(selectModel(dir, '../config/cpm.json'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config/cpm.json'), 'utf8')).selectedModel, 'magia/maga.cpmmodel');

  // Sin cpm.json todavía (CPM no se ha abierto nunca), se crea.
  const fresh = instance({ 'player_models/herrera.cpmmodel': 'x' });
  assert.equal(selectModel(fresh, 'herrera.cpmmodel'), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'config/cpm.json'), 'utf8')).selectedModel, 'herrera.cpmmodel');
});

test('la lista de personajes se limpia y rechaza nicks malos o repetidos', () => {
  assert.deepEqual(normalizeCharacters([{ nick: ' Herrera_Nik ', label: '  La herrera ', model: 'herrera.cpmmodel', otro: 1 }]), [
    { nick: 'Herrera_Nik', label: 'La herrera', model: 'herrera.cpmmodel' },
  ]);
  assert.deepEqual(normalizeCharacters([{ nick: 'Maga_Nik' }]), [{ nick: 'Maga_Nik', label: '', model: null }]);
  assert.throws(() => normalizeCharacters([{ nick: 'no vale' }]), { code: 'nick' });
  assert.throws(() => normalizeCharacters([{ nick: 'ab' }]), { code: 'nick' });
  assert.throws(() => normalizeCharacters([{ nick: 'Maga_Nik' }, { nick: 'maga_nik' }]), { code: 'repeated' });
  assert.throws(() => normalizeCharacters(Array.from({ length: 13 }, (_, i) => ({ nick: `Nick_${i}` }))), { code: 'many' });
  assert.equal(findCharacter([{ nick: 'Maga_Nik' }], 'MAGA_NIK').nick, 'Maga_Nik');
  assert.equal(findCharacter([{ nick: 'Maga_Nik' }], null), null);
});

test('un personaje entra al juego como cuenta sin premium con su nick', () => {
  const options = launchOptions({
    account: { type: 'offline', username: 'Herrera_Nik' },
    gameRoot: '/juego',
    instanceDir: '/juego/instances/admin',
    versionId: '1.20.1-forge-47.4.10',
    javaPath: '/java',
    memoryGb: 6,
    freeMenu: true,
  });
  assert.equal(options.gameProfile.name, 'Herrera_Nik');
  assert.equal(options.gameProfile.id, offlineUuid('Herrera_Nik'));
  assert.equal(options.accessToken, '0');
  assert.equal(options.userType, 'legacy');
});
