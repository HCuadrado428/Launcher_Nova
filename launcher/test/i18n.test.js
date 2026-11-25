const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../i18n');

const root = path.join(__dirname, '..');
const { es, en, pt } = i18n.LANGUAGES;
const holes = (text) => (text.match(/\{\w+\}/g) || []).sort().join(' ');

test('los tres idiomas tienen las mismas claves y los mismos huecos', () => {
  for (const [name, dict] of Object.entries({ en, pt })) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(es).sort(), `claves de ${name}`);
    for (const key of Object.keys(es)) {
      assert.equal(holes(dict[key]), holes(es[key]), `huecos de ${name}: ${key}`);
      assert.ok(dict[key].trim(), `${name}: ${key} está vacío`);
    }
  }
});

test('todas las claves que usa el código existen', () => {
  const used = new Set();
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(match[1]);
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split('|')) used.add(pair.split(':')[1]);
  }
  const sources = ['renderer.js', 'main.js', ...fs.readdirSync(path.join(root, 'main')).map((f) => `main/${f}`)];
  for (const file of sources) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    // t('clave') y también 'clave' sueltas con forma de clave (p.ej. en ternarios).
    for (const match of code.matchAll(/'((?:common|char|login|account|server|side|update|pack|stage|ban|help|nav|home|online|shots|theme|import|news|event|play|console|settings|mods|crash|logs|dialog|prog|warn|err)\.[\w.-]+)'/g)) {
      used.add(match[1]);
    }
  }
  const missing = [...used].filter((key) => !(key in es));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 80, 'se han encontrado las claves del código');
});

test('t() rellena huecos y cae al español si falta el idioma', () => {
  i18n.setLanguage('en-US');
  assert.equal(i18n.t('pack.mods', { n: 3 }), '3 mods');
  assert.equal(i18n.t('play.play'), 'PLAY');
  i18n.setLanguage('pt-BR');
  assert.equal(i18n.t('play.play'), 'JOGAR');
  assert.equal(i18n.setLanguage('fr'), 'es');
  assert.equal(i18n.t('play.play'), 'JUGAR');
});
