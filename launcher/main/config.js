const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// config.json guarda la sesión con el backend y los tokens de Microsoft de la
// cuenta, así que se cifra con el almacén de credenciales del sistema (DPAPI
// en Windows). Si no está disponible se guarda en texto plano en vez de
// romper la app. Se mantiene en memoria y solo se toca el disco al guardar.
let cache = null;

function readFile() {
  const raw = fs.readFileSync(CONFIG_PATH);
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return JSON.parse(safeStorage.decryptString(raw));
    } catch {
      // Sin cifrar (o corrupto): probamos como texto plano.
    }
  }
  return JSON.parse(raw.toString('utf8'));
}

function loadConfig() {
  if (cache === null) {
    try {
      cache = readFile();
    } catch {
      cache = {};
    }
  }
  return { ...cache };
}

function saveConfig(partial) {
  const merged = { ...loadConfig(), ...partial };
  cache = merged;
  try {
    const json = JSON.stringify(merged, null, 2);
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
  } catch (err) {
    console.error('[ERROR] No se pudo guardar la configuración:', err);
  }
  return { ...merged };
}

module.exports = { loadConfig, saveConfig };
