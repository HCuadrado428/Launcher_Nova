const fs = require('node:fs');
const path = require('node:path');

// Capturas de pantalla que hace el jugador en Minecraft (F2), que el juego
// guarda en la carpeta screenshots/ del modpack. No depende de Electron.

const MAX_SHOTS = 150;
const SHOT_RE = /\.(png|jpe?g)$/i;

// Solo nombres de archivo de imagen, sin rutas: lo que llega desde la
// ventana nunca debe poder señalar fuera de la carpeta de capturas.
function safeShotName(name) {
  return typeof name === 'string' && SHOT_RE.test(name) && name === path.basename(name) && !name.includes('\\') && !name.startsWith('.');
}

function screenshotsDir(instanceDir) {
  return path.join(instanceDir, 'screenshots');
}

// Ruta de una captura, o null si el nombre no vale o el archivo no existe.
function shotPath(instanceDir, name) {
  if (!safeShotName(name)) return null;
  const file = path.join(screenshotsDir(instanceDir), name);
  return fs.existsSync(file) ? file : null;
}

// Las más recientes primero.
function listScreenshots(instanceDir) {
  let names = [];
  try {
    names = fs.readdirSync(screenshotsDir(instanceDir));
  } catch {
    return [];
  }
  return names
    .filter(safeShotName)
    .map((name) => {
      const stat = fs.statSync(path.join(screenshotsDir(instanceDir), name));
      return { name, mtimeMs: Math.round(stat.mtimeMs), size: stat.size, isFile: stat.isFile() };
    })
    .filter((shot) => shot.isFile)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SHOTS)
    .map(({ name, mtimeMs, size }) => ({ name, mtimeMs, size }));
}

// Suma una sesión de juego al tiempo jugado guardado. playtime tiene la
// forma { [modpack]: { seconds, lastPlayed } }.
function addPlaytime(playtime, modpackId, startedAt, endedAt) {
  const previous = (playtime && playtime[modpackId]) || { seconds: 0, lastPlayed: null };
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return {
    ...(playtime || {}),
    [modpackId]: { seconds: (Number(previous.seconds) || 0) + seconds, lastPlayed: new Date(endedAt).toISOString() },
  };
}

module.exports = { listScreenshots, shotPath, safeShotName, screenshotsDir, addPlaytime };
