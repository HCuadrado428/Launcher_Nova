const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryPlan, memoryForExtraGame } = require('../main/memory');

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

test('a mano no se deja dar tanta memoria que el juego se quede sin sitio', () => {
  // Con 15 GB se llegaba a 13 y el juego se cerraba por falta de memoria.
  assert.equal(memoryPlan(gb(15.9)).maxMemoryGb, 11);
  assert.equal(memoryPlan(gb(15.9), { memoryAuto: false, memoryGb: 13 }).memoryGb, 11);
  assert.equal(memoryPlan(gb(31.9)).maxMemoryGb, 16);
  // En equipos pequeños nunca por debajo de lo recomendado.
  assert.equal(memoryPlan(gb(7.9)).maxMemoryGb, 5);
});

test('el segundo juego a la vez solo se abre si cabe', () => {
  const extra = (total, cfg, open) => memoryForExtraGame(gb(total), memoryPlan(gb(total), cfg), open);
  // Sin otro juego abierto, lo de siempre.
  assert.deepEqual(extra(15.9, {}, []), { memoryGb: 8 });
  // Con 32 GB caben dos de 8.
  assert.deepEqual(extra(31.9, {}, [8]), { memoryGb: 8 });
  // Con 16 GB y el primero en automático (8 GB) no cabe: hay que bajarlo a 4.
  assert.deepEqual(extra(15.9, {}, [8]), { memoryGb: null, suggestGb: 4 });
  // ...y con los dos a 4 GB, sí.
  assert.deepEqual(extra(15.9, { memoryAuto: false, memoryGb: 4 }, [4]), { memoryGb: 4 });
  // A mano tampoco se deja pedir más de lo que hay (el caso que cerraba los dos juegos).
  assert.deepEqual(extra(15.9, { memoryAuto: false, memoryGb: 11 }, [11]), { memoryGb: null, suggestGb: 4 });
  // Con 24 GB caben dos de 8; con 20 GB, el segundo se queda con lo que sobra.
  assert.deepEqual(extra(23.9, {}, [8]), { memoryGb: 8 });
  assert.deepEqual(extra(19.9, {}, [8]), { memoryGb: 4 });
  // Un equipo de 12 GB no da para dos.
  assert.deepEqual(extra(11.9, {}, [6]), { memoryGb: null, suggestGb: null });
});
