const { app } = require('electron');
const path = require('node:path');
const { t } = require('../i18n');

// Todo lo del launcher vive en %APPDATA%/.novalauncher:
//   game/        versiones, librerías y assets de Minecraft y Forge (se
//                comparten entre los dos modpacks: son la misma versión)
//   instances/   una carpeta de juego por modpack (mods, mundos, opciones...)
//   runtime/     el Java que descarga el launcher si hace falta
const DATA_ROOT = path.join(app.getPath('appData'), '.novalauncher');
const GAME_ROOT = path.join(DATA_ROOT, 'game');
const RUNTIME_DIR = path.join(DATA_ROOT, 'runtime');

function instanceDir(modpackId) {
  if (!/^[a-z0-9-]+$/.test(modpackId)) throw new Error(t('err.badPack'));
  return path.join(DATA_ROOT, 'instances', modpackId);
}

module.exports = { DATA_ROOT, GAME_ROOT, RUNTIME_DIR, instanceDir };
