// Cuánta memoria darle a Minecraft. La mayoría de jugadores no sabe qué poner
// en un deslizador de GB, así que por defecto lo decide el launcher según el
// equipo; quien quiera puede fijarla a mano en Ajustes.

const GB = 1024 ** 3;
// Por debajo de esto el modpack (más de 200 mods) va justo.
const LOW_MEMORY_TOTAL_GB = 7;

// totalBytes: memoria del equipo. cfg: { memoryAuto, memoryGb } guardados.
function memoryPlan(totalBytes, cfg = {}) {
  // Un equipo "de 16 GB" declara algo menos (15,x): se redondea hacia abajo.
  const totalGb = Math.floor(totalBytes / GB);
  // Se dejan al menos 2 GB para Windows y lo demás.
  const maxGb = Math.max(2, Math.min(16, totalGb - 2));
  const wanted = totalGb >= 15 ? 8 : totalGb >= 11 ? 6 : 5;
  const recommendedGb = Math.max(2, Math.min(maxGb, wanted));
  const auto = cfg.memoryAuto !== false;
  const manualGb = Math.min(maxGb, Math.max(2, Math.round(Number(cfg.memoryGb)) || recommendedGb));
  return {
    memoryAuto: auto,
    memoryGb: auto ? recommendedGb : manualGb,
    recommendedMemoryGb: recommendedGb,
    maxMemoryGb: maxGb,
    lowMemory: totalGb < LOW_MEMORY_TOTAL_GB,
  };
}

// Memoria para un juego que se abre mientras otro modpack sigue abierto. En
// automático se reparte lo que queda libre, para no pedir entre los dos más
// de lo que tiene el equipo; fijada a mano, se respeta lo que eligió el jugador.
function memoryForExtraGame(totalBytes, plan, usedGb) {
  if (!plan.memoryAuto || usedGb <= 0) return plan.memoryGb;
  const free = Math.floor(totalBytes / GB) - 2 - usedGb;
  return Math.max(2, Math.min(plan.memoryGb, free));
}

module.exports = { memoryPlan, memoryForExtraGame };
