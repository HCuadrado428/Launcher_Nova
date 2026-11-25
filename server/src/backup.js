const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');

// Copia de seguridad del panel: un .zip con db.json (modpacks, admins,
// jugadores, suspensiones, novedades...) y los .jar de los mods en files/.
// Restaurarla deja el panel exactamente como estaba al hacer la copia.

const FILE_ENTRY_RE = /^files\/([a-f0-9]{40})\.jar$/;
const MAX_DB_BYTES = 20 * 1024 * 1024;

// Escribe la copia en "output" (la respuesta HTTP) sin cargar los mods en memoria.
function writeBackup(store, output) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(store.exportData()), 'db.json');
  for (const sha1 of store.usedFiles()) {
    const file = store.filePath(sha1);
    // Los .jar ya están comprimidos: se guardan tal cual, que es mucho más rápido.
    if (fs.existsSync(file)) zip.addFile(file, `files/${sha1}.jar`, { compress: false });
  }
  zip.end();
  return pipeline(zip.outputStream, output);
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function entryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

// Recorre las entradas del zip una a una, esperando a que "onEntry" termine.
function eachEntry(zip, onEntry) {
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      onEntry(entry).then(() => zip.readEntry(), reject);
    });
    zip.readEntry();
  });
}

class BackupError extends Error {}

// Restaura la copia de "zipPath". No toca nada hasta haberla comprobado
// entera: que trae db.json válido y todos los .jar que nombra, sin dañar.
async function restoreBackup(store, zipPath) {
  const workDir = path.join(store.tmpDir, `restore-${crypto.randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  let zip;
  try {
    try {
      zip = await openZip(zipPath);
    } catch {
      throw new BackupError('El archivo no es un .zip válido.');
    }
    let raw = null;
    const extracted = new Set();
    await eachEntry(zip, async (entry) => {
      if (entry.fileName === 'db.json') {
        if (entry.uncompressedSize > MAX_DB_BYTES) throw new BackupError('El db.json de la copia es demasiado grande.');
        const chunks = [];
        for await (const chunk of await entryStream(zip, entry)) chunks.push(chunk);
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new BackupError('El db.json de la copia está dañado.');
        }
        return;
      }
      // Solo se aceptan nombres files/<sha1>.jar: nada de rutas raras.
      const match = FILE_ENTRY_RE.exec(entry.fileName);
      if (!match) return;
      const dest = path.join(workDir, `${match[1]}.jar`);
      const hash = crypto.createHash('sha1');
      const source = await entryStream(zip, entry);
      source.on('data', (chunk) => hash.update(chunk));
      await pipeline(source, fs.createWriteStream(dest));
      if (hash.digest('hex') !== match[1]) throw new BackupError(`Un mod de la copia está dañado (${match[1].slice(0, 8)}...).`);
      extracted.add(match[1]);
    });

    if (!raw || typeof raw !== 'object' || !raw.modpacks) throw new BackupError('El .zip no es una copia de seguridad de este panel.');
    // Imprescindibles: los mods y archivos de los modpacks. Los del historial
    // (versiones anteriores) se recuperan si vienen en la copia.
    const needed = new Set();
    const wanted = new Set();
    const collect = (state, into) => {
      for (const item of [...((state && state.mods) || []), ...((state && state.files) || [])]) {
        if (!item || !/^[a-f0-9]{40}$/.test(item.sha1)) throw new BackupError('La lista de mods de la copia no es válida.');
        into.add(item.sha1);
      }
    };
    for (const modpack of Object.values(raw.modpacks)) collect(modpack, needed);
    for (const list of Object.values(raw.history || {})) {
      for (const state of Array.isArray(list) ? list : []) collect(state, wanted);
    }
    const missing = [...needed].filter((sha1) => !extracted.has(sha1) && !fs.existsSync(store.filePath(sha1)));
    if (missing.length > 0) throw new BackupError(`A la copia le faltan ${missing.length} mods: no se puede restaurar.`);

    for (const sha1 of extracted) {
      if ((needed.has(sha1) || wanted.has(sha1)) && !fs.existsSync(store.filePath(sha1))) {
        fs.renameSync(path.join(workDir, `${sha1}.jar`), store.filePath(sha1));
      }
    }
    // Una versión del historial a la que le falte algún archivo ya no se puede recuperar: se descarta.
    for (const [id, list] of Object.entries(raw.history || {})) {
      if (!Array.isArray(list)) continue;
      raw.history[id] = list.filter((state) =>
        [...(state.mods || []), ...(state.files || [])].every((item) => fs.existsSync(store.filePath(item.sha1))),
      );
    }
    store.replaceData(raw);
    return { mods: needed.size };
  } finally {
    if (zip) zip.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { writeBackup, restoreBackup, BackupError };
