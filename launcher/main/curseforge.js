const fs = require('node:fs');
const path = require('node:path');
const { t } = require('../i18n');
const { readModId } = require('./jarinfo');
const modrinth = require('./modrinth');

// Mods de CurseForge. La búsqueda pasa por el servidor del launcher, que es
// quien guarda la clave de su API; aquí solo se descarga el .jar elegido.
// A diferencia de Modrinth, CurseForge no dice si un mod es solo de cliente
// ni se instalan solas sus dependencias: la interfaz lo avisa.

const DOWNLOAD_ORIGINS = ['https://edge.forgecdn.net', 'https://mediafilez.forgecdn.net'];
const ICON_ORIGIN = 'https://media.forgecdn.net/';
// En el registro de mods propios, los de CurseForge llevan este prefijo.
const PREFIX = 'cf:';

const isCurseforgeId = (id) => typeof id === 'string' && /^cf:\d{1,10}$/.test(id);

// Deja los resultados del servidor con la misma forma que los de Modrinth.
function searchResults(hits) {
  return (Array.isArray(hits) ? hits : [])
    .filter((hit) => hit && /^\d{1,10}$/.test(String(hit.id)))
    .map((hit) => ({
      id: `${PREFIX}${hit.id}`,
      slug: '',
      title: String(hit.title || ''),
      description: String(hit.description || ''),
      iconUrl: typeof hit.icon === 'string' && hit.icon.startsWith(ICON_ORIGIN) ? hit.icon : '',
      downloads: Number(hit.downloads) || 0,
      // El autor no deja descargarlo desde fuera de la app de CurseForge.
      blocked: hit.allowed === false,
    }));
}

// file: { filename, url, size, sha1 } tal como lo da el servidor.
async function installMod({ projectId, title, file, manifestMods, instanceDir, downloadOrigins = DOWNLOAD_ORIGINS }) {
  const name = String(title || file.filename);
  const pack = modrinth.packIndex(manifestMods);
  if (!file || !/^[a-f0-9]{40}$/.test(String(file.sha1 || ''))) throw new Error(t('err.modBadFile', { title: name }));
  if (pack.filenames.has(String(file.filename).toLowerCase()) || pack.sha1s.has(file.sha1)) {
    throw new Error(t('err.modInPack', { title: name }));
  }
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const tmp = await modrinth.downloadToTemp({ ...file, title: name }, modsDir, downloadOrigins, 'err.curseforge');
  // Con el archivo en la mano: si es un mod que ya trae el modpack, fuera
  // (dos copias del mismo mod no dejan arrancar el juego).
  const modId = await readModId(tmp);
  if (modId && pack.names.has(modrinth.normalizeName(modId))) {
    fs.rmSync(tmp, { force: true });
    throw new Error(t('err.modInPack', { title: name }));
  }
  fs.renameSync(tmp, path.join(modsDir, file.filename));
  const registry = modrinth.loadRegistry(instanceDir);
  for (const [filename, entry] of Object.entries(registry)) {
    if (entry.projectId === projectId && filename !== file.filename) {
      fs.rmSync(path.join(modsDir, path.basename(filename)), { force: true });
      delete registry[filename];
    }
  }
  registry[file.filename] = { projectId, title: name };
  modrinth.saveRegistry(instanceDir, registry);
  return [{ title: name, filename: file.filename }];
}

module.exports = { searchResults, installMod, isCurseforgeId, DOWNLOAD_ORIGINS, PREFIX };
