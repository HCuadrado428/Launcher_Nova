const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Almacén de datos del backend: un único JSON en el volumen (admins y los
// dos modpacks) más una carpeta files/ con los .jar guardados por su SHA-1.
// Son muy pocos datos y solo los cambia el dueño desde el panel, así que no
// hace falta una base de datos: basta con escribir el archivo de forma
// atómica (temporal + rename) para que un corte a mitad no lo corrompa.

const MODPACK_IDS = ['normal', 'admin'];

const DEFAULT_MODPACKS = {
  normal: { name: 'NOVA 2', description: 'El modpack del servidor. Para todo el mundo.' },
  admin: { name: 'NOVA 2 · ADMIN', description: 'Modpack con herramientas de administración. Solo cuentas admin.' },
};

function emptyModpack(id) {
  return {
    id,
    name: DEFAULT_MODPACKS[id].name,
    description: DEFAULT_MODPACKS[id].description,
    mcVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.10',
    mods: [],
    updatedAt: null,
  };
}

// Huella del contenido del modpack: cambia si cambia cualquier mod o la
// versión de Minecraft/Forge. El launcher la compara con la última que
// sincronizó para saber si hay actualización.
function versionHash(modpack) {
  const lines = modpack.mods.map((m) => `${m.sha1}:${m.filename}`).sort();
  lines.push(`${modpack.mcVersion}|${modpack.loader}|${modpack.loaderVersion}`);
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

function createStore(dataDir) {
  const dbPath = path.join(dataDir, 'db.json');
  const filesDir = path.join(dataDir, 'files');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  // Restos de subidas que se quedaron a medias en un arranque anterior.
  for (const name of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, name), { force: true });

  let data;
  try {
    data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`db.json está corrupto y no se puede leer: ${err.message}`);
    data = {};
  }
  data.admins = Array.isArray(data.admins) ? data.admins : [];
  data.modpacks = data.modpacks || {};
  for (const id of MODPACK_IDS) data.modpacks[id] = { ...emptyModpack(id), ...data.modpacks[id], id };

  function save() {
    const tmp = `${dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dbPath);
  }

  function filePath(sha1) {
    return path.join(filesDir, `${sha1}.jar`);
  }

  // Borra del disco los .jar que ya no usa ningún modpack.
  function removeOrphanFiles(candidates) {
    const used = new Set(MODPACK_IDS.flatMap((id) => data.modpacks[id].mods.map((m) => m.sha1)));
    for (const sha1 of candidates) {
      if (!used.has(sha1)) fs.rmSync(filePath(sha1), { force: true });
    }
  }

  function touch(modpack) {
    modpack.updatedAt = new Date().toISOString();
  }

  return {
    tmpDir,
    filesDir,
    filePath,
    getModpack: (id) => (MODPACK_IDS.includes(id) ? data.modpacks[id] : null),
    listAdmins: () => data.admins,

    publicModpack(modpack, { withMods = false } = {}) {
      const out = {
        id: modpack.id,
        name: modpack.name,
        description: modpack.description,
        mcVersion: modpack.mcVersion,
        loader: modpack.loader,
        loaderVersion: modpack.loaderVersion,
        modCount: modpack.mods.length,
        totalSize: modpack.mods.reduce((sum, m) => sum + m.size, 0),
        updatedAt: modpack.updatedAt,
        versionHash: versionHash(modpack),
      };
      if (withMods) out.mods = [...modpack.mods].sort((a, b) => a.filename.localeCompare(b.filename));
      return out;
    },

    // Añade un .jar ya subido a tmp/. Si en el modpack hay otro mod con el
    // mismo nombre de archivo, lo sustituye (es una actualización del mod).
    addMod(id, { tmpPath, filename, sha1, size }) {
      const modpack = data.modpacks[id];
      const dest = filePath(sha1);
      if (fs.existsSync(dest)) fs.rmSync(tmpPath, { force: true });
      else fs.renameSync(tmpPath, dest);

      const replaced = modpack.mods.filter((m) => m.filename.toLowerCase() === filename.toLowerCase());
      modpack.mods = modpack.mods.filter((m) => !replaced.includes(m));
      const mod = { id: crypto.randomUUID(), filename, sha1, size, uploadedAt: new Date().toISOString() };
      modpack.mods.push(mod);
      touch(modpack);
      save();
      removeOrphanFiles(replaced.map((m) => m.sha1));
      return { mod, replaced: replaced.length > 0 };
    },

    removeMods(id, modIds) {
      const modpack = data.modpacks[id];
      const removed = modpack.mods.filter((m) => modIds.includes(m.id));
      if (removed.length === 0) return 0;
      modpack.mods = modpack.mods.filter((m) => !removed.includes(m));
      touch(modpack);
      save();
      removeOrphanFiles(removed.map((m) => m.sha1));
      return removed.length;
    },

    // Deja el modpack "toId" con exactamente los mismos mods que "fromId".
    // No copia archivos: los .jar se guardan una sola vez por SHA-1.
    copyMods(fromId, toId) {
      const from = data.modpacks[fromId];
      const to = data.modpacks[toId];
      const previous = to.mods.map((m) => m.sha1);
      to.mods = from.mods.map((m) => ({ ...m, id: crypto.randomUUID() }));
      touch(to);
      save();
      removeOrphanFiles(previous);
      return to.mods.length;
    },

    updateModpack(id, fields) {
      const modpack = data.modpacks[id];
      Object.assign(modpack, fields);
      touch(modpack);
      save();
      return modpack;
    },

    addAdmin({ nick, uuid }) {
      const existing = data.admins.find((a) => a.uuid === uuid);
      if (existing) {
        existing.nick = nick;
        save();
        return { admin: existing, created: false };
      }
      const admin = { id: crypto.randomUUID(), nick, uuid, addedAt: new Date().toISOString() };
      data.admins.push(admin);
      save();
      return { admin, created: true };
    },

    removeAdmin(adminId) {
      const before = data.admins.length;
      data.admins = data.admins.filter((a) => a.id !== adminId);
      if (data.admins.length === before) return false;
      save();
      return true;
    },

    isAdminUuid: (uuid) => Boolean(uuid) && data.admins.some((a) => a.uuid === uuid),
  };
}

module.exports = { createStore, MODPACK_IDS, versionHash };
