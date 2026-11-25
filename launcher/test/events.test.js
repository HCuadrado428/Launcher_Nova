const test = require('node:test');
const assert = require('node:assert/strict');
const { dueAlert } = require('../main/events');

const MIN = 60000;

test('avisa una vez cuando falta poco y otra cuando empieza el evento', () => {
  const start = Date.parse('2026-12-01T20:00:00Z');
  const event = { name: 'Be The Boss', start: new Date(start).toISOString() };
  const shown = new Set();
  assert.equal(dueAlert(event, start - 3 * 3600000, shown), null);
  assert.deepEqual(dueAlert(event, start - 25 * MIN, shown), { kind: 'soon', name: 'Be The Boss', minutes: 25 });
  assert.equal(dueAlert(event, start - 24 * MIN, shown), null, 'no se repite');
  assert.deepEqual(dueAlert(event, start + 20000, shown), { kind: 'now', name: 'Be The Boss', minutes: 0 });
  assert.equal(dueAlert(event, start + MIN, shown), null);

  // Otra fecha para el mismo evento es otro aviso.
  const moved = { name: 'Be The Boss', start: new Date(start + 86400000).toISOString() };
  assert.equal(dueAlert(moved, start + 86400000 - 10 * MIN, shown).kind, 'soon');
});

test('si el launcher se abre con el evento ya empezado, avisa solo si acaba de empezar', () => {
  const start = Date.parse('2026-12-01T20:00:00Z');
  const event = { name: 'Nether', start: new Date(start).toISOString() };
  assert.equal(dueAlert(event, start + 2 * MIN, new Set()).kind, 'now');
  assert.equal(dueAlert(event, start + 40 * MIN, new Set()), null);
  assert.equal(dueAlert(null, start, new Set()), null);
  assert.equal(dueAlert({ name: 'x', start: 'no es fecha' }, start, new Set()), null);
});
