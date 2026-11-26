// Cuánta memoria darle a Minecraft. La mayoría de jugadores no sabe qué poner
// en un deslizador de GB, así que por defecto lo decide el launcher según el
// equipo; quien quiera puede fijarla a mano en Ajustes.

const GB = 1024 ** 3;
// Por debajo de esto el modpack (más de 200 mods) va justo.
const LOW_MEMORY_TOTAL_GB = 7;
// Lo que se deja para Windows y los demás programas.
const SYSTEM_RESERVE_GB = 3;
// Lo que usa cada juego además de la memoria que se le da (-Xmx): Java,
// los mods cargados y la tarjeta gráfica. Con este modpack, unos 2 GB.
const GAME_OVERHEAD_GB = 2;
// Menos de esto no le basta al modpack.
const MIN_GAME_GB = 4;

// totalBytes: memoria del equipo. cfg: { memoryAuto, memoryGb } guardados.
function memoryPlan(totalBytes, cfg = {}) {
  // Un equipo "de 16 GB" declara algo menos (15,x): se redondea hacia abajo.
  const totalGb = Math.floor(totalBytes / GB);
  const wanted = totalGb >= 15 ? 8 : totalGb >= 11 ? 6 : 5;
  const recommendedGb = Math.max(2, Math.min(totalGb - 2, wanted));
  // A mano no se deja pasar de lo que cabe junto a Windows y lo que el juego
  // usa por fuera (con 15 GB, 11). Dar más no lo hace ir mejor: deja sin
  // sitio al propio juego y se cierra por falta de memoria.
  const maxGb = Math.max(recommendedGb, Math.min(16, totalGb - SYSTEM_RESERVE_GB - GAME_OVERHEAD_GB + 1));
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

// Memoria para un juego que se abre mientras otro sigue abierto (el otro
// modpack o una segunda ventana). openGb: memoria de los juegos ya abiertos.
// Devuelve { memoryGb } si cabe, o { memoryGb: null, suggestGb } si no: con
// suggestGb (o null si el equipo no da para dos) la memoria que habría que
// poner a mano para que quepan los dos.
// Aunque la memoria esté puesta a mano, aquí no se respeta si no cabe: dos
// juegos pidiendo más de lo que hay se cierran los dos.
function memoryForExtraGame(totalBytes, plan, openGb = []) {
  if (openGb.length === 0) return { memoryGb: plan.memoryGb };
  const totalGb = Math.floor(totalBytes / GB);
  const taken = openGb.reduce((sum, gb) => sum + gb + GAME_OVERHEAD_GB, 0);
  const free = totalGb - SYSTEM_RESERVE_GB - taken - GAME_OVERHEAD_GB;
  if (free >= MIN_GAME_GB) return { memoryGb: Math.min(plan.memoryGb, free) };
  const eachGb = Math.floor((totalGb - SYSTEM_RESERVE_GB) / 2) - GAME_OVERHEAD_GB;
  return { memoryGb: null, suggestGb: eachGb >= MIN_GAME_GB ? Math.min(eachGb, plan.recommendedMemoryGb) : null };
}

module.exports = { memoryPlan, memoryForExtraGame };
