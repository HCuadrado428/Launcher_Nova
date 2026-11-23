const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Sincronización de los mods de un modpack con el manifiesto del backend.
// No depende de Electron: recibe las rutas y la función de descarga, así que
// se puede probar con node --test contra un backend de verdad.

const META_FILE = '.nova-meta.json';
const DOWNLOAD_CONCURRENCY = 4;

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function loadMeta(instanceDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(instanceDir, META_FILE), 'utf8'));
    return { versionHash: meta.versionHash || null, mods: Array.isArray(meta.mods) ? meta.mods : [] };
  } catch {
    return { versionHash: null, mods: [] };
  }
}

function saveMeta(instanceDir, meta) {
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, META_FILE), JSON.stringify(meta, null, 2));
}

// El manifiesto viene del servidor: aun así no nos fiamos de los nombres de
// archivo para construir rutas dentro del disco del jugador.
function safeModFilename(filename) {
  return (
    typeof filename === 'string' &&
    /\.jar$/i.test(filename) &&
    filename === path.basename(filename) &&
    !filename.includes('\\') &&
    !filename.startsWith('.')
  );
}

// Clave con la que se recuerda que un jugador ha quitado un mod opcional: el
// modId si el backend lo conoce (aguanta que el archivo cambie de nombre al
// actualizarse), y si no el nombre del archivo.
function modKey(mod) {
  return String(mod.modId || mod.filename).toLowerCase();
}

// Los mods que le tocan a este jugador: todos menos los opcionales que ha
// desactivado.
function wantedMods(manifestMods, disabled = []) {
  const off = new Set(disabled);
  return manifestMods.filter((mod) => !(mod.optional && off.has(modKey(mod))));
}

// Decide qué hay que borrar y qué hay que bajar. Solo se tocan los archivos
// que puso el launcher (los que constan en el meta local): si el jugador ha
// metido a mano un mod suyo en la carpeta, se respeta.
function planSync(localMods, remoteMods, existingFiles) {
  const remoteByName = new Map(remoteMods.map((m) => [m.filename.toLowerCase(), m]));
  const localByName = new Map(localMods.map((m) => [m.filename.toLowerCase(), m]));
  const existing = new Set([...existingFiles].map((f) => f.toLowerCase()));

  const toDelete = localMods.filter((m) => !remoteByName.has(m.filename.toLowerCase()));
  const toDownload = remoteMods.filter((m) => {
    const local = localByName.get(m.filename.toLowerCase());
    return !local || local.sha1 !== m.sha1 || !existing.has(m.filename.toLowerCase());
  });
  return { toDelete, toDownload };
}

async function runLimited(items, limit, worker) {
  const queue = [...items];
  let failure = null;
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0 && !failure) {
      try {
        await worker(queue.shift());
      } catch (err) {
        failure = err;
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
}

// download(mod, destPath) debe dejar el archivo completo en destPath.
async function syncMods({ instanceDir, manifest, download, disabled = [], onProgress = () => {} }) {
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  for (const mod of manifest.mods) {
    if (!safeModFilename(mod.filename) || !/^[a-f0-9]{40}$/.test(mod.sha1)) {
      throw new Error(`El modpack contiene un archivo con un nombre no válido: ${String(mod.filename).slice(0, 80)}`);
    }
  }

  // Un opcional desactivado no se baja; si ya estaba bajado, se borra como
  // cualquier mod que deja de estar en la lista.
  const remoteMods = wantedMods(manifest.mods, disabled);
  const meta = loadMeta(instanceDir);
  const { toDelete, toDownload } = planSync(meta.mods, remoteMods, fs.readdirSync(modsDir));

  for (const mod of toDelete) {
    if (safeModFilename(mod.filename)) fs.rmSync(path.join(modsDir, mod.filename), { force: true });
  }

  const totalBytes = toDownload.reduce((sum, m) => sum + (m.size || 0), 0);
  let doneBytes = 0;
  let doneFiles = 0;
  // El meta se va guardando mod a mod: si la descarga se corta a mitad, la
  // siguiente vez solo se baja lo que falta.
  const synced = new Map(
    meta.mods.filter((m) => !toDelete.includes(m)).map((m) => [m.filename.toLowerCase(), m]),
  );
  const persist = (versionHash) =>
    saveMeta(instanceDir, {
      versionHash,
      mods: [...synced.values()].map(({ filename, sha1, size }) => ({ filename, sha1, size })),
    });
  persist(null);

  onProgress({ doneFiles, totalFiles: toDownload.length, doneBytes, totalBytes, filename: null });
  await runLimited(toDownload, DOWNLOAD_CONCURRENCY, async (mod) => {
    const dest = path.join(modsDir, mod.filename);
    const tmp = `${dest}.descargando`;
    try {
      await download(mod, tmp);
      const actual = await sha1File(tmp);
      if (actual !== mod.sha1) throw new Error(`${mod.filename} se descargó dañado. Vuelve a intentarlo.`);
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    synced.set(mod.filename.toLowerCase(), mod);
    persist(null);
    doneFiles++;
    doneBytes += mod.size || 0;
    onProgress({ doneFiles, totalFiles: toDownload.length, doneBytes, totalBytes, filename: mod.filename });
  });

  persist(manifest.versionHash);
  return { downloaded: toDownload.length, deleted: toDelete.length };
}

module.exports = { syncMods, planSync, loadMeta, saveMeta, safeModFilename, modKey, wantedMods, META_FILE };
