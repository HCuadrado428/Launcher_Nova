const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryPlan } = require('../main/memory');

const gb = (n) => n * 1024 ** 3;

test('en automático la memoria depende del equipo', () => {
  // [memoria que declara el equipo, memoria para el juego]
  for (const [total, expected] of [
    [31.9, 8],
    [15.9, 8],
    [11.9, 6],
    [7.9, 5],
    [5.9, 3],
    [3.9, 2],
  ]) {
    const plan = memoryPlan(gb(total));
    assert.equal(plan.memoryAuto, true);
    assert.equal(plan.memoryGb, expected, `${total} GB`);
    assert.ok(plan.memoryGb <= plan.maxMemoryGb);
  }
});

test('avisa cuando el equipo va justo', () => {
  assert.equal(memoryPlan(gb(5.9)).lowMemory, true);
  assert.equal(memoryPlan(gb(7.9)).lowMemory, false);
});

test('un valor guardado de antes no desactiva el automático', () => {
  // Las versiones anteriores guardaban siempre memoryGb al pulsar Guardar.
  assert.equal(memoryPlan(gb(15.9), { memoryGb: 4 }).memoryGb, 8);
});

test('a mano se respeta lo elegido, dentro de lo que el equipo permite', () => {
  assert.equal(memoryPlan(gb(15.9), { memoryAuto: false, memoryGb: 10 }).memoryGb, 10);
  assert.equal(memoryPlan(gb(7.9), { memoryAuto: false, memoryGb: 12 }).memoryGb, 5);
  assert.equal(memoryPlan(gb(15.9), { memoryAuto: false, memoryGb: 1 }).memoryGb, 2);
});
