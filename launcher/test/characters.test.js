const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listModels, describeModels, modelInfo, selectModel, normalizeCharacters, findCharacter } = require('../main/characters');
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

// Un .cpmmodel de mentira con la misma forma que los de verdad: 0x53, nombre,
// descripción, datos, bloque extra vacío e icono PNG (más la suma de control).
function fakeModel({ name, icon, data = Buffer.from('datos del modelo') }) {
  const block = (buffer) => Buffer.concat([Buffer.from([buffer.length]), buffer]);
  return Buffer.concat([
    Buffer.from([0x53]),
    block(Buffer.from(name, 'utf8')),
    block(Buffer.from('desc', 'utf8')),
    block(data),
    Buffer.from([0]),
    block(icon || Buffer.alloc(0)),
    Buffer.from([1, 2]),
  ]);
}

// PNG mínimo válido de 1x1.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==',
  'base64',
);

test('de cada modelo se saca su nombre y su icono', () => {
  const dir = instance({
    'player_models/maga.cpmmodel': fakeModel({ name: 'La Maga Ñ', icon: PNG }),
    'player_models/sin-icono.cpmmodel': fakeModel({ name: 'Sin icono' }),
    'player_models/roto.cpmmodel': 'esto no es un modelo',
  });
  const models = describeModels(dir);
  assert.deepEqual(
    models.map((m) => [m.file, m.name, Boolean(m.icon)]),
    [
      ['maga.cpmmodel', 'La Maga Ñ', true],
      ['roto.cpmmodel', '', false],
      ['sin-icono.cpmmodel', 'Sin icono', false],
    ],
  );
  assert.equal(models[0].icon, `data:image/png;base64,${PNG.toString('base64')}`);
  // Un archivo que no existe no rompe nada.
  assert.deepEqual(modelInfo(path.join(dir, 'no-esta.cpmmodel')), { name: '', icon: null });
});
