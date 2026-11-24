const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// «Traer mis cosas de otro launcher»: busca otras instalaciones de Minecraft
// en el equipo y copia de ellas lo que el jugador elija (ajustes, mapas,
// mundos, capturas...) a la carpeta de un modpack del Nova Launcher.
// Siempre copia, nunca mueve, y no depende de Electron.

// Qué se puede traer. "paths" son rutas dentro de la carpeta del juego.
// overwrite: se sustituye lo que haya (guardando copia); si no, lo que ya
// existe en el destino se respeta y solo se añade lo que falta.
const CATEGORIES = [
  { id: 'options', paths: ['options.txt', 'optionsof.txt', 'optionsshaders.txt'], overwrite: true },
  { id: 'maps', paths: ['XaeroWaypoints', 'XaeroWorldMap', 'xaero', 'journeymap/data'] },
  { id: 'models', paths: ['player_models', 'player-models'] },
  { id: 'resourcepacks', paths: ['resourcepacks'] },
  { id: 'shaderpacks', paths: ['shaderpacks'] },
  { id: 'screenshots', paths: ['screenshots'] },
  { id: 'worlds', paths: ['saves'] },
];
const BACKUP_SUFFIX = '.antes-de-importar';

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Una carpeta parece una instalación de Minecraft si tiene algo de lo típico.
function looksLikeGameDir(dir) {
  return ['options.txt', 'saves', 'mods', 'resourcepacks', 'screenshots'].some((name) => fs.existsSync(path.join(dir, name)));
}

// Prism y MultiMC guardan el juego en una subcarpeta de la instancia.
function resolveGameDir(dir) {
  for (const candidate of [dir, path.join(dir, '.minecraft'), path.join(dir, 'minecraft')]) {
    if (isDir(candidate) && looksLikeGameDir(candidate)) return candidate;
  }
  return null;
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// Dónde guarda cada launcher sus instalaciones. Son las rutas por defecto:
// si el jugador las cambió, no se encontrarán y tendrá que elegir la carpeta.
function knownLocations({ platform = process.platform, home = os.homedir(), appData = process.env.APPDATA } = {}) {
  const data =
    platform === 'win32'
      ? appData || path.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.local', 'share');
  const vanilla =
    platform === 'win32'
      ? path.join(data, '.minecraft')
      : platform === 'darwin'
        ? path.join(data, 'minecraft')
        : path.join(home, '.minecraft');
  return {
    single: [{ launcher: 'Minecraft', dir: vanilla }],
    // Carpetas que contienen una subcarpeta por instancia o perfil.
    multi: [
      { launcher: 'Modrinth', dir: path.join(data, 'ModrinthApp', 'profiles') },
      { launcher: 'Modrinth', dir: path.join(data, 'com.modrinth.theseus', 'profiles') },
      { launcher: 'CurseForge', dir: path.join(home, 'curseforge', 'minecraft', 'Instances') },
      { launcher: 'CurseForge', dir: path.join(home, 'Documents', 'Curse', 'Minecraft', 'Instances') },
      { launcher: 'Prism Launcher', dir: path.join(data, 'PrismLauncher', 'instances') },
      { launcher: 'ATLauncher', dir: path.join(data, 'ATLauncher', 'instances') },
      { launcher: 'GDLauncher', dir: path.join(data, 'gdlauncher_next', 'instances') },
    ],
  };
}

// Instalaciones encontradas: [{ launcher, name, path }], sin repetir carpeta.
function findInstances(locations = knownLocations()) {
  const found = [];
  const add = (launcher, name, dir) => {
    const gameDir = resolveGameDir(dir);
    if (gameDir && !found.some((f) => f.path === gameDir)) found.push({ launcher, name, path: gameDir });
  };
  for (const { launcher, dir } of locations.single) add(launcher, '', dir);
  for (const { launcher, dir } of locations.multi) {
    for (const name of subdirs(dir)) add(launcher, name, path.join(dir, name));
  }
  return found;
}

// Cuenta lo que hay dentro (archivos sueltos, o entradas de la carpeta).
function countEntries(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return 1;
    return fs.readdirSync(target).filter((name) => !name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

// Qué categorías tiene algo que traer en esa instalación.
function inspect(gameDir) {
  return CATEGORIES.map((category) => ({
    id: category.id,
    count: category.paths.reduce((sum, rel) => sum + countEntries(path.join(gameDir, rel)), 0),
  })).filter((category) => category.count > 0);
}

// Copia un archivo o carpeta. Devuelve cuántos archivos ha copiado y cuántos
// se ha saltado porque ya existían. No sigue enlaces simbólicos.
async function copyTree(source, dest, overwrite, totals) {
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.mkdir(dest, { recursive: true });
    for (const name of await fs.promises.readdir(source)) {
      await copyTree(path.join(source, name), path.join(dest, name), overwrite, totals);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (fs.existsSync(dest)) {
    if (!overwrite) {
      totals.skipped++;
      return;
    }
    // Se guarda lo que había (una sola vez: no se pisa una copia anterior).
    const backup = `${dest}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(backup)) await fs.promises.copyFile(dest, backup);
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(source, dest);
  totals.copied++;
}

// Trae las categorías elegidas de "from" a "to". Devuelve, por categoría,
// { copied, skipped } en número de archivos.
async function importItems({ from, to, categories }) {
  const source = path.resolve(from);
  const target = path.resolve(to);
  if (source === target) throw new Error('same-folder');
  if (!isDir(source)) throw new Error('missing-source');
  const report = {};
  for (const category of CATEGORIES) {
    if (!categories.includes(category.id)) continue;
    const totals = { copied: 0, skipped: 0 };
    for (const rel of category.paths) {
      const item = path.join(source, rel);
      if (fs.existsSync(item)) await copyTree(item, path.join(target, rel), Boolean(category.overwrite), totals);
    }
    report[category.id] = totals;
  }
  return report;
}

module.exports = { CATEGORIES, knownLocations, findInstances, resolveGameDir, inspect, importItems };
