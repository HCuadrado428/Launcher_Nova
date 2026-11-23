const fs = require('node:fs');
const path = require('node:path');
const yazl = require('yazl');
const { newestFile } = require('./crash');

// Junta en un .zip lo que hace falta para ayudar a un jugador con un
// problema: los registros del juego, el último informe de error y un resumen
// del launcher. No depende de Electron.

const MAX_TEXT_BYTES = 40 * 1024 * 1024;

// Por si acaso: los registros del juego ya ocultan el token de sesión, pero
// cualquier cosa con forma de token se tacha antes de empaquetar.
function redact(text) {
  return text.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, '[token oculto]');
}

// Archivos de la carpeta del modpack que merece la pena enviar.
function collectLogFiles(instanceDir) {
  const found = [];
  for (const name of ['latest.log', 'debug.log']) {
    const file = path.join(instanceDir, 'logs', name);
    if (fs.existsSync(file)) found.push({ file, name: `logs/${name}` });
  }
  const crash = newestFile(path.join(instanceDir, 'crash-reports'), /\.txt$/i);
  if (crash) found.push({ file: crash, name: `crash-reports/${path.basename(crash)}` });
  const jvm = newestFile(instanceDir, /^hs_err_pid\d+\.log$/i);
  if (jvm) found.push({ file: jvm, name: path.basename(jvm) });
  return found;
}

// Lista de los .jar de la carpeta de mods, para saber qué tiene puesto.
function listMods(instanceDir) {
  try {
    return fs
      .readdirSync(path.join(instanceDir, 'mods'))
      .filter((name) => /\.jar$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function writeLogsZip({ dest, instanceDir, info, consoleLines = [] }) {
  const files = collectLogFiles(instanceDir);
  const zip = new yazl.ZipFile();
  for (const { file, name } of files) {
    const { size } = fs.statSync(file);
    if (size > MAX_TEXT_BYTES) continue;
    zip.addBuffer(Buffer.from(redact(fs.readFileSync(file, 'utf8'))), name);
  }
  if (consoleLines.length > 0) zip.addBuffer(Buffer.from(redact(consoleLines.join('\n'))), 'consola-launcher.txt');
  const mods = listMods(instanceDir);
  const summary = [
    ...Object.entries(info).map(([key, value]) => `${key}: ${value}`),
    '',
    `Mods en la carpeta (${mods.length}):`,
    ...mods.map((name) => `  ${name}`),
  ].join('\n');
  zip.addBuffer(Buffer.from(summary), 'launcher.txt');

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    out.on('error', reject);
    out.on('close', () => resolve({ dest, files: files.map((f) => f.name) }));
    zip.outputStream.pipe(out);
    zip.end();
  });
}

module.exports = { writeLogsZip, collectLogFiles, redact };
