const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { t } = require('../i18n');

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
    return {
      versionHash: meta.versionHash || null,
      mods: Array.isArray(meta.mods) ? meta.mods : [],
      files: Array.isArray(meta.files) ? meta.files : [],
    };
  } catch {
    return { versionHash: null, mods: [], files: [] };
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

// Carpetas del juego a las que el modpack puede mandar archivos sueltos
// (config, recursos, shaders). Las mismas que acepta el panel.
const EXTRA_ROOTS = ['config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks'];

// Igual que con los mods: la ruta viene del servidor, pero no se usa sin
// comprobar que se queda dentro de una de esas carpetas.
function safeExtraPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 200 || filePath.includes('\\')) return false;
  const parts = filePath.split('/');
  if (parts.length < 2 || !EXTRA_ROOTS.includes(parts[0])) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: se rechazan a propósito
  return parts.every((part) => part && part !== '.' && part !== '..' && !/[\u0000-\u001f<>:"|?*]/.test(part));
}

// Qué archivos sueltos hay que bajar y cuáles borrar.
//  - Se baja uno cuando falta, o cuando el dueño lo ha cambiado en el panel
//    desde la última vez que se le puso al jugador. Si el jugador lo ha
//    retocado después y en el panel sigue igual, se respeta lo suyo.
//  - Se borra uno que el modpack ya no reparte solo si el jugador no lo ha
//    tocado (sigue siendo el que se le puso).
// localFiles: [{ path, sha1 }] del meta. current(path): sha1 del archivo en
// disco, o null si no está.
async function planFiles(localFiles, remoteFiles, current) {
  const remoteByPath = new Map(remoteFiles.map((f) => [f.path.toLowerCase(), f]));
  const localByPath = new Map(localFiles.map((f) => [f.path.toLowerCase(), f]));
  const toDownload = [];
  const kept = [];
  for (const file of remoteFiles) {
    const local = localByPath.get(file.path.toLowerCase());
    const onDisk = await current(file.path);
    if (onDisk === file.sha1) kept.push(file);
    else if (onDisk && local && local.sha1 === file.sha1) kept.push(file); // retocado por el jugador
    else toDownload.push(file);
  }
  const toDelete = [];
  for (const local of localFiles) {
    if (remoteByPath.has(local.path.toLowerCase())) continue;
    if ((await current(local.path)) === local.sha1) toDelete.push(local);
  }
  return { toDownload, toDelete, kept };
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
      throw new Error(t('err.badFile', { name: String(mod.filename).slice(0, 80) }));
    }
  }

  // Un opcional desactivado no se baja; si ya estaba bajado, se borra como
  // cualquier mod que deja de estar en la lista.
  const remoteFiles = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of remoteFiles) {
    if (!safeExtraPath(file.path) || !/^[a-f0-9]{40}$/.test(file.sha1)) {
      throw new Error(t('err.badFile', { name: String(file.path).slice(0, 80) }));
    }
  }

  const remoteMods = wantedMods(manifest.mods, disabled);
  const meta = loadMeta(instanceDir);
  const { toDelete, toDownload } = planSync(meta.mods, remoteMods, fs.readdirSync(modsDir));

  // Archivos sueltos (config, recursos, shaders).
  const currentSha1 = async (filePath) => {
    const full = path.join(instanceDir, ...filePath.split('/'));
    try {
      return fs.statSync(full).isFile() ? await sha1File(full) : null;
    } catch {
      return null;
    }
  };
  const knownFiles = meta.files.filter((f) => safeExtraPath(f.path));
  const filePlan = await planFiles(knownFiles, remoteFiles, currentSha1);
  for (const file of filePlan.toDelete) fs.rmSync(path.join(instanceDir, ...file.path.split('/')), { force: true });
  const syncedFiles = new Map(filePlan.kept.map((f) => [f.path.toLowerCase(), f]));

  for (const mod of toDelete) {
    if (safeModFilename(mod.filename)) fs.rmSync(path.join(modsDir, mod.filename), { force: true });
  }

  const totalBytes = [...toDownload, ...filePlan.toDownload].reduce((sum, m) => sum + (m.size || 0), 0);
  const totalFiles = toDownload.length + filePlan.toDownload.length;
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
      files: [...syncedFiles.values()].map(({ path: filePath, sha1 }) => ({ path: filePath, sha1 })),
    });
  persist(null);

  onProgress({ doneFiles, totalFiles, doneBytes, totalBytes, filename: null });
  await runLimited(toDownload, DOWNLOAD_CONCURRENCY, async (mod) => {
    const dest = path.join(modsDir, mod.filename);
    const tmp = `${dest}.descargando`;
    try {
      await download(mod, tmp);
      const actual = await sha1File(tmp);
      if (actual !== mod.sha1) throw new Error(t('err.damaged', { name: mod.filename }));
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    synced.set(mod.filename.toLowerCase(), mod);
    persist(null);
    doneFiles++;
    doneBytes += mod.size || 0;
    onProgress({ doneFiles, totalFiles, doneBytes, totalBytes, filename: mod.filename });
  });

  await runLimited(filePlan.toDownload, DOWNLOAD_CONCURRENCY, async (file) => {
    const dest = path.join(instanceDir, ...file.path.split('/'));
    const tmp = `${dest}.descargando`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await download(file, tmp);
      const actual = await sha1File(tmp);
      if (actual !== file.sha1) throw new Error(t('err.damaged', { name: file.path }));
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    syncedFiles.set(file.path.toLowerCase(), file);
    persist(null);
    doneFiles++;
    doneBytes += file.size || 0;
    onProgress({ doneFiles, totalFiles, doneBytes, totalBytes, filename: file.path });
  });

  persist(manifest.versionHash);
  return {
    downloaded: toDownload.length,
    deleted: toDelete.length,
    files: filePlan.toDownload.length,
    filesDeleted: filePlan.toDelete.length,
  };
}

module.exports = {
  syncMods,
  planSync,
  planFiles,
  loadMeta,
  saveMeta,
  safeModFilename,
  safeExtraPath,
  modKey,
  wantedMods,
  META_FILE,
};
