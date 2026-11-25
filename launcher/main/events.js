// Avisos del próximo evento del servidor: uno cuando falta poco y otro cuando
// empieza. No depende de Electron: decide qué avisar y quien llama lo enseña.

const SOON_MS = 30 * 60 * 1000;
// Si el launcher se abre con el evento ya empezado hace rato, no se avisa.
const STARTED_WINDOW_MS = 10 * 60 * 1000;

// event: { name, start (ISO) } o null. shown: Set con los avisos ya dados
// (se rellena aquí). Devuelve { kind: 'soon' | 'now', name, minutes } o null.
function dueAlert(event, now, shown) {
  if (!event || !event.name || !event.start) return null;
  const start = new Date(event.start).getTime();
  if (!Number.isFinite(start)) return null;
  const left = start - now;
  const id = `${event.name}|${start}`;
  if (left <= 0) {
    if (-left > STARTED_WINDOW_MS || shown.has(`${id}|now`)) return null;
    shown.add(`${id}|now`);
    shown.add(`${id}|soon`);
    return { kind: 'now', name: event.name, minutes: 0 };
  }
  if (left > SOON_MS || shown.has(`${id}|soon`)) return null;
  shown.add(`${id}|soon`);
  return { kind: 'soon', name: event.name, minutes: Math.max(1, Math.round(left / 60000)) };
}

module.exports = { dueAlert, SOON_MS };
