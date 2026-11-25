const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Almacén de datos del backend: un único JSON en el volumen (admins y los
// dos modpacks) más una carpeta files/ con los .jar guardados por su SHA-1.
// Son muy pocos datos y solo los cambia el dueño desde el panel, así que no
// hace falta una base de datos: basta con escribir el archivo de forma
// atómica (temporal + rename) para que un corte a mitad no lo corrompa.

const MODPACK_IDS = ['normal', 'admin'];
const PLAYER_SEEN_INTERVAL_MS = 5 * 60 * 1000;
// Versiones anteriores que se guardan de cada modpack para poder deshacer.
const MAX_HISTORY = 15;
// Días de actividad que se guardan para las estadísticas del panel.
const STATS_DAYS = 60;

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
    // Archivos sueltos que se reparten además de los mods (config, recursos, shaders).
    files: [],
    updatedAt: null,
  };
}

// Huella del contenido del modpack: cambia si cambia cualquier mod o la
// versión de Minecraft/Forge. El launcher la compara con la última que
// sincronizó para saber si hay actualización.
function versionHash(modpack) {
  const lines = modpack.mods
    .map((m) => `${m.sha1}:${m.filename}${m.optional ? `:opcional:${m.label || ''}:${m.description || ''}` : ''}`)
    .sort();
  for (const file of modpack.files || []) lines.push(`archivo:${file.path}:${file.sha1}`);
  lines.sort();
  lines.push(`${modpack.mcVersion}|${modpack.loader}|${modpack.loaderVersion}`);
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

// Deja los datos leídos de db.json (o de una copia de seguridad) con todos
// sus apartados, rellenando lo que falte. Devuelve el mismo objeto.
function normalize(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Los datos no tienen el formato esperado.');
  data.admins = Array.isArray(data.admins) ? data.admins : [];
  data.modpacks = data.modpacks && typeof data.modpacks === 'object' ? data.modpacks : {};
  for (const id of MODPACK_IDS) {
    data.modpacks[id] = { ...emptyModpack(id), ...data.modpacks[id], id };
    if (!Array.isArray(data.modpacks[id].mods)) data.modpacks[id].mods = [];
    if (!Array.isArray(data.modpacks[id].files)) data.modpacks[id].files = [];
  }
  // Versiones anteriores de cada modpack, de la más reciente a la más antigua.
  data.history = data.history && typeof data.history === 'object' ? data.history : {};
  for (const id of MODPACK_IDS) if (!Array.isArray(data.history[id])) data.history[id] = [];
  // Quién ha abierto el launcher cada día: { 'AAAA-MM-DD': [claves de jugador] }.
  data.stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
  data.stats.days = data.stats.days && typeof data.stats.days === 'object' ? data.stats.days : {};
  data.news = data.news && typeof data.news.text === 'string' ? data.news : { text: '', updatedAt: null };
  data.event = data.event && data.event.name && data.event.start ? data.event : null;
  data.discordUrl = typeof data.discordUrl === 'string' ? data.discordUrl : '';
  // Frases del servidor que el launcher enseña al azar junto al título.
  data.phrases = Array.isArray(data.phrases) ? data.phrases.filter((p) => typeof p === 'string') : [];
  // Jugadores que han usado el launcher y accesos suspendidos, por clave de jugador.
  data.players = data.players && typeof data.players === 'object' ? data.players : {};
  data.bans = data.bans && typeof data.bans === 'object' ? data.bans : {};
  return data;
}

function createStore(dataDir) {
  const dbPath = path.join(dataDir, 'db.json');
  const filesDir = path.join(dataDir, 'files');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  // Restos de subidas que se quedaron a medias en un arranque anterior.
  for (const name of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, name), { force: true, recursive: true });

  let data;
  try {
    data = normalize(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`db.json está corrupto y no se puede leer: ${err.message}`);
    data = normalize({});
  }

  function save() {
    const tmp = `${dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dbPath);
  }

  function filePath(sha1) {
    return path.join(filesDir, `${sha1}.jar`);
  }

  // Archivos en uso: los de los modpacks y los de sus versiones guardadas.
  function usedSha1() {
    const used = new Set();
    for (const id of MODPACK_IDS) {
      for (const state of [data.modpacks[id], ...data.history[id]]) {
        for (const item of [...state.mods, ...(state.files || [])]) used.add(item.sha1);
      }
    }
    return used;
  }

  // Borra del disco los archivos que ya no usa ningún modpack ni su historial.
  function removeOrphanFiles(candidates) {
    const used = usedSha1();
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
        fileCount: modpack.files.length,
        totalSize: [...modpack.mods, ...modpack.files].reduce((sum, m) => sum + m.size, 0),
        updatedAt: modpack.updatedAt,
        versionHash: versionHash(modpack),
      };
      if (withMods) {
        out.mods = [...modpack.mods].sort((a, b) => a.filename.localeCompare(b.filename));
        out.files = [...modpack.files].sort((a, b) => a.path.localeCompare(b.path));
      }
      return out;
    },

    // Añade un .jar ya subido a tmp/. Sustituye al mod que tuviera el mismo
    // nombre de archivo o el mismo modId (otra versión del mismo mod: dos
    // copias harían que Forge no arrancara), y hereda si era opcional.
    addMod(id, { tmpPath, filename, sha1, size, modId = null }) {
      const modpack = data.modpacks[id];
      const dest = filePath(sha1);
      if (fs.existsSync(dest)) fs.rmSync(tmpPath, { force: true });
      else fs.renameSync(tmpPath, dest);

      const replaced = modpack.mods.filter(
        (m) => m.filename.toLowerCase() === filename.toLowerCase() || (modId && m.modId === modId),
      );
      modpack.mods = modpack.mods.filter((m) => !replaced.includes(m));
      const mod = {
        id: crypto.randomUUID(),
        filename,
        sha1,
        size,
        modId,
        optional: replaced.some((m) => m.optional),
        // El nombre y la descripción que ve el jugador se conservan al actualizar el mod.
        label: (replaced.find((m) => m.label) || {}).label || '',
        description: (replaced.find((m) => m.description) || {}).description || '',
        uploadedAt: new Date().toISOString(),
      };
      modpack.mods.push(mod);
      touch(modpack);
      save();
      removeOrphanFiles(replaced.map((m) => m.sha1));
      return { mod, replaced: replaced.map((m) => m.filename) };
    },

    // Cambia cómo ve el jugador un mod: si es opcional y con qué nombre y
    // descripción sale en el launcher.
    updateMod(id, modId, fields) {
      const modpack = data.modpacks[id];
      const mod = modpack.mods.find((m) => m.id === modId);
      if (!mod) return false;
      Object.assign(mod, fields);
      touch(modpack);
      save();
      return true;
    },

    // Los mods subidos antes de que se guardara el modId no lo tienen: se lee
    // de sus .jar una vez, al arrancar.
    async backfillModIds(readModId) {
      let changed = false;
      for (const id of MODPACK_IDS) {
        for (const mod of data.modpacks[id].mods) {
          if (mod.modId !== undefined) continue;
          mod.modId = await readModId(filePath(mod.sha1));
          changed = true;
        }
      }
      if (changed) save();
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

    // ---------- Archivos sueltos (config, recursos, shaders) ----------

    // Añade archivos ya subidos a tmp/. Uno con la misma ruta sustituye al anterior.
    addFiles(id, entries) {
      const modpack = data.modpacks[id];
      const replaced = [];
      for (const { tmpPath, path: filePathInPack, sha1, size } of entries) {
        const dest = filePath(sha1);
        if (fs.existsSync(dest)) fs.rmSync(tmpPath, { force: true });
        else fs.renameSync(tmpPath, dest);
        const old = modpack.files.filter((f) => f.path.toLowerCase() === filePathInPack.toLowerCase());
        replaced.push(...old.map((f) => f.sha1));
        modpack.files = modpack.files.filter((f) => !old.includes(f));
        modpack.files.push({ path: filePathInPack, sha1, size });
      }
      touch(modpack);
      save();
      removeOrphanFiles(replaced);
    },

    // Quita los archivos cuya ruta está en la lista, o está dentro de una
    // de esas carpetas («config/create» quita todo lo de esa carpeta).
    removeFiles(id, paths) {
      const modpack = data.modpacks[id];
      const removed = modpack.files.filter((f) => paths.some((p) => f.path === p || f.path.startsWith(`${p}/`)));
      if (removed.length === 0) return 0;
      modpack.files = modpack.files.filter((f) => !removed.includes(f));
      touch(modpack);
      save();
      removeOrphanFiles(removed.map((f) => f.sha1));
      return removed.length;
    },

    // ---------- Historial ----------

    // Guarda cómo está el modpack ahora mismo, antes de cambiarlo.
    snapshot(id, label) {
      const modpack = data.modpacks[id];
      const list = data.history[id];
      list.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        label,
        mcVersion: modpack.mcVersion,
        loader: modpack.loader,
        loaderVersion: modpack.loaderVersion,
        mods: modpack.mods.map((m) => ({ ...m })),
        files: modpack.files.map((f) => ({ ...f })),
      });
      const dropped = list.splice(MAX_HISTORY);
      save();
      removeOrphanFiles(dropped.flatMap((state) => [...state.mods, ...state.files].map((item) => item.sha1)));
    },

    listHistory: (id) =>
      data.history[id].map((state) => ({
        id: state.id,
        at: state.at,
        label: state.label,
        modCount: state.mods.length,
        fileCount: state.files.length,
        loaderVersion: state.loaderVersion,
      })),

    // Deja el modpack como estaba en esa versión guardada. Lo que había
    // justo antes de volver se guarda también, por si hay que deshacerlo.
    restoreSnapshot(id, snapshotId) {
      const state = data.history[id].find((entry) => entry.id === snapshotId);
      if (!state) return false;
      this.snapshot(id, 'Antes de volver a una versión anterior');
      const modpack = data.modpacks[id];
      modpack.mcVersion = state.mcVersion;
      modpack.loader = state.loader;
      modpack.loaderVersion = state.loaderVersion;
      modpack.mods = state.mods.map((m) => ({ ...m }));
      modpack.files = state.files.map((f) => ({ ...f }));
      touch(modpack);
      save();
      return true;
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

    // Novedades y próximo evento: lo que ve todo el mundo al abrir el launcher.
    getAnnouncements: () => ({ news: data.news, event: data.event, discordUrl: data.discordUrl, phrases: data.phrases }),

    setPhrases(phrases) {
      data.phrases = phrases;
      save();
    },

    // ---------- Copia de seguridad ----------

    // Los datos tal cual se guardan en db.json, y los .jar que usan los modpacks.
    exportData: () => JSON.stringify(data, null, 2),
    usedFiles: () => [...usedSha1()],

    // Sustituye todos los datos por los de una copia (ya validada y con sus
    // .jar puestos en files/) y borra los .jar que dejan de usarse.
    replaceData(raw) {
      data = normalize(raw);
      save();
      const used = new Set(this.usedFiles());
      for (const name of fs.readdirSync(filesDir)) {
        const sha1 = name.replace(/\.jar$/, '');
        if (!used.has(sha1)) fs.rmSync(path.join(filesDir, name), { force: true });
      }
    },

    setDiscordUrl(url) {
      data.discordUrl = url;
      save();
    },

    setNews(text) {
      data.news = { text, updatedAt: text ? new Date().toISOString() : null };
      save();
    },

    setEvent(event) {
      data.event = event;
      save();
    },

    // ---------- Jugadores ----------

    // Apunta que un jugador ha usado el launcher. Para no escribir el archivo
    // en cada petición, la fecha solo se actualiza si la guardada tiene más
    // de unos minutos (o si ha cambiado el nick o la versión).
    touchPlayer(key, { name, uuid, premium, launcherVersion }) {
      const now = Date.now();
      const known = data.players[key];
      // Estadísticas: se apunta que hoy ha abierto el launcher (una vez al día).
      const today = new Date(now).toISOString().slice(0, 10);
      let dayChanged = false;
      if (!data.stats.days[today]) {
        data.stats.days[today] = [];
        for (const date of Object.keys(data.stats.days).sort().slice(0, -STATS_DAYS)) delete data.stats.days[date];
      }
      if (!data.stats.days[today].includes(key)) {
        data.stats.days[today].push(key);
        dayChanged = true;
      }
      const version = launcherVersion || (known && known.launcherVersion) || '';
      if (
        known &&
        known.name === name &&
        known.launcherVersion === version &&
        now - new Date(known.lastSeen).getTime() < PLAYER_SEEN_INTERVAL_MS
      ) {
        if (dayChanged) save();
        return;
      }
      const stamp = new Date(now).toISOString();
      data.players[key] = {
        name,
        uuid: uuid || null,
        premium: Boolean(premium),
        firstSeen: known ? known.firstSeen : stamp,
        lastSeen: stamp,
        launcherVersion: version,
        ...(known && known.characters ? { characters: known.characters } : {}),
        ...(known && known.blockedCharacters ? { blockedCharacters: known.blockedCharacters } : {}),
        ...(known && known.disabled ? { disabled: known.disabled } : {}),
      };
      save();
    },

    // Personajes de un admin: nicks sin premium con los que entra desde el
    // modpack de admins. Devuelve null si se han guardado, o por qué no:
    // { code: 'taken' | 'blocked', nick } (lo usa otro jugador, o el dueño
    // lo ha quitado desde el panel).
    setCharacters(key, nicks) {
      const own = data.players[key];
      if (!own) return null;
      const blocked = (own.blockedCharacters || []).map((nick) => nick.toLowerCase());
      const refused = nicks.find((nick) => blocked.includes(nick.toLowerCase()));
      if (refused) return { code: 'blocked', nick: refused };
      const taken = new Set();
      for (const [other, player] of Object.entries(data.players)) {
        if (other === key) continue;
        taken.add(player.name.toLowerCase());
        for (const nick of player.characters || []) taken.add(nick.toLowerCase());
      }
      const clash = nicks.find((nick) => taken.has(nick.toLowerCase()));
      if (clash) return { code: 'taken', nick: clash };
      if (nicks.length > 0) own.characters = nicks;
      else delete own.characters;
      save();
      return null;
    },

    // El dueño quita un personaje a un admin: deja de estar en su lista y
    // ya no puede volver a ponerlo hasta que se le permita.
    blockCharacter(key, nick) {
      const player = data.players[key];
      if (!player) return false;
      const same = (other) => other.toLowerCase() === nick.toLowerCase();
      player.characters = (player.characters || []).filter((other) => !same(other));
      if (player.characters.length === 0) delete player.characters;
      if (!(player.blockedCharacters || []).some(same)) player.blockedCharacters = [...(player.blockedCharacters || []), nick];
      save();
      return true;
    },

    unblockCharacter(key, nick) {
      const player = data.players[key];
      if (!player || !player.blockedCharacters) return false;
      player.blockedCharacters = player.blockedCharacters.filter((other) => other.toLowerCase() !== nick.toLowerCase());
      if (player.blockedCharacters.length === 0) delete player.blockedCharacters;
      save();
      return true;
    },

    blockedCharacters: (key) => (data.players[key] && data.players[key].blockedCharacters) || [],

    // Mods opcionales que ese jugador tiene desactivados en un modpack (lo
    // cuenta el launcher al pedir el modpack). Solo se usa para estadísticas.
    setDisabledMods(key, modpackId, keys) {
      const player = data.players[key];
      if (!player) return;
      const before = JSON.stringify((player.disabled || {})[modpackId] || null);
      if (before === JSON.stringify(keys)) return;
      player.disabled = { ...(player.disabled || {}), [modpackId]: keys };
      save();
    },

    // Resumen para el panel: actividad por día, versiones del launcher en uso
    // y qué mods opcionales desactiva más la gente.
    stats() {
      const days = [];
      for (let i = 29; i >= 0; i--) {
        const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        days.push({ date, players: (data.stats.days[date] || []).length });
      }
      const recent = Date.now() - 30 * 86400000;
      const versions = {};
      for (const player of Object.values(data.players)) {
        if (new Date(player.lastSeen).getTime() < recent) continue;
        const version = player.launcherVersion || 'desconocida';
        versions[version] = (versions[version] || 0) + 1;
      }
      const optional = {};
      for (const id of MODPACK_IDS) {
        const reports = Object.values(data.players)
          .map((player) => player.disabled && player.disabled[id])
          .filter(Array.isArray);
        optional[id] = {
          players: reports.length,
          mods: data.modpacks[id].mods
            .filter((mod) => mod.optional)
            .map((mod) => ({
              name: mod.label || mod.filename,
              disabled: reports.filter((keys) => keys.includes(mod.modId || mod.filename)).length,
            }))
            .sort((a, b) => b.disabled - a.disabled),
        };
      }
      return {
        days,
        versions: Object.entries(versions)
          .map(([version, players]) => ({ version, players }))
          .sort((a, b) => b.players - a.players),
        optional,
      };
    },

    listPlayers() {
      return Object.entries(data.players)
        .map(([key, player]) => ({ key, ...player, ban: this.activeBan(key) }))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    },

    hasPlayer: (key) => Object.hasOwn(data.players, key),

    // Suspensión en vigor de ese jugador, o null. Las caducadas se borran solas.
    activeBan(key) {
      const ban = data.bans[key];
      if (!ban) return null;
      if (ban.until && new Date(ban.until).getTime() <= Date.now()) {
        delete data.bans[key];
        save();
        return null;
      }
      return ban;
    },

    // until: fecha ISO de fin, o null si no tiene fin.
    setBan(key, { until, reason }) {
      data.bans[key] = { until, reason, createdAt: new Date().toISOString() };
      save();
    },

    removeBan(key) {
      if (!data.bans[key]) return false;
      delete data.bans[key];
      save();
      return true;
    },

    isAdminUuid: (uuid) => Boolean(uuid) && data.admins.some((a) => a.uuid === uuid),
  };
}

module.exports = { createStore, MODPACK_IDS, versionHash };
