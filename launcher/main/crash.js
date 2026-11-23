const fs = require('node:fs');
const path = require('node:path');

// Lee el informe de error que deja Minecraft cuando se cierra mal y saca de
// él lo que le sirve a un jugador: qué ha pasado y qué mod tiene pinta de
// ser el culpable. No depende de Electron.

// .jar que salen en casi cualquier traza y no son "el mod que ha fallado".
const NOT_A_SUSPECT =
  /^(client-|forge-|fmlcore|fmlloader|fmlearlydisplay|javafmllanguage|lowcodelanguage|mclanguage|modlauncher|eventbus|bootstraplauncher|securejarhandler|mixin|minecraft|unionfs|coremods|accesstransformers)/i;

// Archivo más reciente de una carpeta cuyo nombre cumple el patrón y que se
// ha modificado después de "since" (ms). null si no hay.
function newestFile(dir, pattern, since = 0) {
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const file = path.join(dir, name);
    const { mtimeMs } = fs.statSync(file);
    if (mtimeMs >= since && (!best || mtimeMs > best.mtimeMs)) best = { file, mtimeMs };
  }
  return best ? best.file : null;
}

function parseCrashReport(text) {
  const description = (/^Description: (.+)$/m.exec(text) || [])[1] || null;

  // La excepción es la primera línea con texto después de "Description:".
  let exception = null;
  if (description) {
    const after = text.slice(text.indexOf('Description: ')).split(/\r?\n/).slice(1);
    exception = (after.find((line) => line.trim() !== '') || '').trim().slice(0, 300) || null;
  }

  // Forge añade un apartado "Suspected Mods" cuando sabe de qué mod es el
  // código que ha fallado.
  const suspects = [];
  const section = /Suspected Mods?: ?([\s\S]*?)(?:\r?\n\r?\n|Stacktrace:|$)/.exec(text);
  if (section) {
    for (const match of section[1].matchAll(/^\t(?!\t)(.+?) \(([\w.-]+)\), Version: (.+)$/gm)) {
      suspects.push(`${match[1].trim()} ${match[3].trim()}`);
    }
  }
  // Si Forge no señala a ninguno, el primer .jar de mod que aparece en la
  // traza suele ser buena pista.
  if (suspects.length === 0) {
    const head = text.split('A detailed walkthrough')[0];
    for (const match of head.matchAll(/~\[([^\]%!/\\]+\.jar)%/g)) {
      if (!NOT_A_SUSPECT.test(match[1]) && !suspects.includes(match[1])) suspects.push(match[1]);
      if (suspects.length === 3) break;
    }
  }
  return { description, exception, suspects };
}

// Resumen del cierre: busca un informe creado desde que se abrió el juego.
function analyzeCrash({ instanceDir, since, logLines = [] }) {
  const reportFile = newestFile(path.join(instanceDir, 'crash-reports'), /\.txt$/i, since);
  let parsed = { description: null, exception: null, suspects: [] };
  let text = '';
  if (reportFile) {
    try {
      text = fs.readFileSync(reportFile, 'utf8');
      parsed = parseCrashReport(text);
    } catch {
      // Informe ilegible: se sigue sin detalles.
    }
  }
  const outOfMemory = /OutOfMemoryError/.test(text) || logLines.some((line) => line.includes('OutOfMemoryError'));
  return { ...parsed, outOfMemory, hasReport: Boolean(reportFile) };
}

module.exports = { analyzeCrash, parseCrashReport, newestFile };
