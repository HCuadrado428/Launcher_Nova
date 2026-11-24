const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { t } = require('../i18n');
const { safeModFilename } = require('./sync');
const { readModId } = require('./jarinfo');

// Buscar e instalar mods de cliente desde Modrinth (https://modrinth.com),
// que tiene una API abierta y dice de cada mod si hace falta en el cliente y
// en el servidor. Solo se ofrecen los que funcionan sin tocar el servidor.
// No depende de Electron.

const API_URL = 'https://api.modrinth.com/v2';
const DOWNLOAD_ORIGINS = ['https://cdn.modrinth.com'];
const REGISTRY_FILE = '.nova-own.json';
const SEARCH_LIMIT = 30;
// Tope de mods por instalación (el pedido más los que necesita para funcionar).
const MAX_INSTALL = 12;
const TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

let userAgent = 'HCuadrado428/Launcher_Nova';
function setUserAgent(version) {
  // Modrinth pide que cada programa se identifique en sus peticiones.
  userAgent = `HCuadrado428/Launcher_Nova/${version}`;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(t('err.modrinth'), { cause: err });
  }
  if (!res.ok) {
    const error = new Error(t('err.modrinth'));
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Un mod vale como "de cliente" si funciona en el cliente y el servidor no lo necesita.
function isClientMod(hit) {
  return hit.client_side !== 'unsupported' && hit.server_side !== 'required';
}

function searchUrl(apiUrl, { query, mcVersion, loader, sideFacets }) {
  const facets = [['project_type:mod'], [`categories:${loader}`], [`versions:${mcVersion}`]];
  if (sideFacets) facets.push(['server_side:optional', 'server_side:unsupported'], ['client_side:required', 'client_side:optional']);
  const params = new URLSearchParams({
    query: query || '',
    facets: JSON.stringify(facets),
    limit: String(SEARCH_LIMIT),
    // Sin texto de búsqueda se enseñan los más descargados.
    index: query ? 'relevance' : 'downloads',
  });
  return `${apiUrl}/search?${params}`;
}

async function searchMods({ query, mcVersion, loader, apiUrl = API_URL }) {
  const options = { query: String(query || '').trim().slice(0, 80), mcVersion, loader };
  let data;
  try {
    data = await getJson(searchUrl(apiUrl, { ...options, sideFacets: true }));
  } catch (err) {
    // Si el buscador no admite filtrar por lado, se pide sin ese filtro: de
    // todas formas se vuelve a comprobar aquí abajo, mod a mod.
    if (err.status !== 400) throw err;
    data = await getJson(searchUrl(apiUrl, { ...options, sideFacets: false }));
  }
  return (data.hits || []).filter(isClientMod).map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    iconUrl: typeof hit.icon_url === 'string' && hit.icon_url.startsWith('https://cdn.modrinth.com/') ? hit.icon_url : '',
    downloads: hit.downloads || 0,
  }));
}

// Los modId de Forge y los nombres de Modrinth casi siempre coinciden salvo
// por guiones y mayúsculas ("farmers-delight" / "farmersdelight").
const normalizeName = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// pack: lo que ya trae el modpack, para no instalar nada repetido.
function packIndex(manifestMods) {
  return {
    names: new Set(manifestMods.map((m) => normalizeName(m.modId)).filter(Boolean)),
    filenames: new Set(manifestMods.map((m) => m.filename.toLowerCase())),
    sha1s: new Set(manifestMods.map((m) => m.sha1)),
  };
}

function inPack(pack, { slug, filename, sha1 }) {
  return (
    pack.names.has(normalizeName(slug)) ||
    (filename && pack.filenames.has(filename.toLowerCase())) ||
    (sha1 && pack.sha1s.has(sha1))
  );
}

// La versión más reciente del mod para ese Minecraft y ese cargador
// (primero las estables), con su archivo principal.
async function latestFile(apiUrl, projectId, mcVersion, loader) {
  const params = new URLSearchParams({ loaders: JSON.stringify([loader]), game_versions: JSON.stringify([mcVersion]) });
  const versions = await getJson(`${apiUrl}/project/${encodeURIComponent(projectId)}/version?${params}`);
  const version = versions.find((v) => v.version_type === 'release') || versions[0];
  if (!version) return null;
  const file = version.files.find((f) => f.primary) || version.files.find((f) => /\.jar$/i.test(f.filename));
  if (!file) return null;
  return {
    filename: file.filename,
    url: file.url,
    sha1: file.hashes && file.hashes.sha1,
    size: file.size || 0,
    requires: (version.dependencies || [])
      .filter((d) => d.dependency_type === 'required' && d.project_id)
      .map((d) => d.project_id),
  };
}

// Decide qué archivos hay que bajar para instalar un mod: el pedido y los
// que necesita para funcionar, saltándose los que ya trae el modpack.
async function planInstall({ projectId, mcVersion, loader, manifestMods, apiUrl = API_URL }) {
  const pack = packIndex(manifestMods);
  const files = [];
  const seen = new Set();
  const queue = [projectId];
  while (queue.length > 0 && seen.size < MAX_INSTALL) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const isRequested = id === projectId;
    const project = await getJson(`${apiUrl}/project/${encodeURIComponent(id)}`);
    if (inPack(pack, { slug: project.slug })) {
      if (isRequested) throw new Error(t('err.modInPack', { title: project.title }));
      continue;
    }
    const file = await latestFile(apiUrl, id, mcVersion, loader);
    if (!file || !file.sha1) {
      if (isRequested) throw new Error(t('err.modNoVersion', { title: project.title, mc: mcVersion }));
      continue; // una dependencia sin versión compatible: se instala lo demás
    }
    if (inPack(pack, { slug: project.slug, filename: file.filename, sha1: file.sha1 })) {
      if (isRequested) throw new Error(t('err.modInPack', { title: project.title }));
      continue;
    }
    files.push({ projectId: id, title: project.title, filename: file.filename, url: file.url, sha1: file.sha1, size: file.size });
    queue.push(...file.requires);
  }
  return files;
}

// ---------- Registro de lo instalado ----------

// Qué mods propios vinieron de Modrinth, para enseñar su nombre y saber cuál
// sustituir al instalar una versión nueva. { [archivo]: { projectId, title } }
function loadRegistry(instanceDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(instanceDir, REGISTRY_FILE), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveRegistry(instanceDir, registry) {
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, REGISTRY_FILE), JSON.stringify(registry, null, 2));
}

function forgetOwnMod(instanceDir, filename) {
  const registry = loadRegistry(instanceDir);
  if (!Object.hasOwn(registry, filename)) return;
  delete registry[filename];
  saveRegistry(instanceDir, registry);
}

// Mods de Modrinth que siguen en la carpeta: { [projectId]: archivo }.
function installedProjects(instanceDir) {
  const out = {};
  for (const [filename, entry] of Object.entries(loadRegistry(instanceDir))) {
    if (entry && entry.projectId && fs.existsSync(path.join(instanceDir, 'mods', filename))) out[entry.projectId] = filename;
  }
  return out;
}

// ---------- Descarga ----------

// Baja el archivo a un temporal junto a su destino y devuelve la ruta del
// temporal, ya comprobado. Quien llama decide si se queda (renombrándolo).
async function downloadToTemp(file, destDir, downloadOrigins) {
  let url;
  try {
    url = new URL(file.url);
  } catch {
    throw new Error(t('err.modBadFile', { title: file.title }));
  }
  // Solo nombres de .jar normales y solo desde los servidores de Modrinth.
  if (!safeModFilename(file.filename) || !downloadOrigins.includes(url.origin)) {
    throw new Error(t('err.modBadFile', { title: file.title }));
  }
  const tmp = path.join(destDir, `${file.filename}.descargando`);
  try {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(t('err.modrinth'), { cause: err });
    }
    if (!res.ok || !res.body) throw new Error(t('err.modrinth'));
    const hash = crypto.createHash('sha1');
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, fs.createWriteStream(tmp));
    if (hash.digest('hex') !== file.sha1) throw new Error(t('err.damaged', { name: file.filename }));
    return tmp;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Instala un mod de Modrinth (y lo que necesite) en la carpeta de mods.
async function installMod({ projectId, mcVersion, loader, manifestMods, instanceDir, apiUrl = API_URL, downloadOrigins = DOWNLOAD_ORIGINS }) {
  const files = await planInstall({ projectId, mcVersion, loader, manifestMods, apiUrl });
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const registry = loadRegistry(instanceDir);
  const pack = packIndex(manifestMods);
  const installed = [];
  for (const file of files) {
    const tmp = await downloadToTemp(file, modsDir, downloadOrigins);
    // Última comprobación, ya con el archivo en la mano: el nombre de un mod
    // en Modrinth no siempre coincide con su identificador de Forge, y dos
    // copias del mismo mod no dejan arrancar el juego.
    const modId = await readModId(tmp);
    if (modId && pack.names.has(normalizeName(modId))) {
      fs.rmSync(tmp, { force: true });
      if (file.projectId === projectId) throw new Error(t('err.modInPack', { title: file.title }));
      continue;
    }
    fs.renameSync(tmp, path.join(modsDir, file.filename));
    // Si había otra versión del mismo mod con otro nombre de archivo, se quita.
    for (const [filename, entry] of Object.entries(registry)) {
      if (entry.projectId === file.projectId && filename !== file.filename) {
        if (safeModFilename(filename)) fs.rmSync(path.join(modsDir, filename), { force: true });
        delete registry[filename];
      }
    }
    registry[file.filename] = { projectId: file.projectId, title: file.title };
    saveRegistry(instanceDir, registry);
    installed.push({ title: file.title, filename: file.filename });
  }
  return installed;
}

module.exports = {
  searchMods,
  planInstall,
  installMod,
  installedProjects,
  loadRegistry,
  forgetOwnMod,
  setUserAgent,
  normalizeName,
  isClientMod,
};
