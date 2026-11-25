const fs = require('node:fs');
const path = require('node:path');

// Personajes de un admin: nicks sin premium con los que entra desde el modpack
// de admins sin cambiar de cuenta dentro del juego. Cada uno puede llevar su
// modelo de Customizable Player Models (CPM).
//
// CPM guarda el modelo elegido en config/cpm.json, clave «selectedModel», como
// ruta relativa a la carpeta player_models (con «/»). Es un ajuste de la
// carpeta de juego, no de la cuenta: por eso al cambiar de cuenta se queda el
// último modelo. Aquí se deja puesto el del personaje antes de abrir el juego.

const MAX_CHARACTERS = 12;
const MODELS_DIR = 'player_models';
const MODEL_EXT = '.cpmmodel';
// Carpetas y archivos que el propio CPM no enseña en su lista.
const HIDDEN = new Set(['autosaves', '.temp.cpmmodel']);
const MAX_MODEL_DEPTH = 4;

const validNick = (nick) => typeof nick === 'string' && /^\w{3,16}$/.test(nick);

// Modelos disponibles en ese modpack, como los nombra CPM («carpeta/archivo.cpmmodel»).
function listModels(instanceDir) {
  const found = [];
  const walk = (dir, prefix, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (HIDDEN.has(entry.name)) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_MODEL_DEPTH) walk(path.join(dir, entry.name), name, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(MODEL_EXT)) {
        found.push(name);
      }
    }
  };
  walk(path.join(instanceDir, MODELS_DIR), '', 0);
  return found.sort((a, b) => a.localeCompare(b));
}

// Un modelo solo vale si es uno de los que hay en la carpeta (nada de rutas
// que salgan de ella).
const hasModel = (instanceDir, model) => typeof model === 'string' && listModels(instanceDir).includes(model);

// Deja ese modelo como el elegido en CPM, sin tocar el resto de sus ajustes.
// Devuelve false si el modelo ya no está (se deja lo que hubiera).
function selectModel(instanceDir, model) {
  if (!hasModel(instanceDir, model)) return false;
  const file = path.join(instanceDir, 'config', 'cpm.json');
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    // Sin archivo, o ilegible: CPM lo vuelve a crear con lo que falte.
  }
  if (data.selectedModel === model) return true;
  data.selectedModel = model;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return true;
}

// Limpia la lista que llega de la ventana. Lanza un error con «code» (y «nick»)
// si algo no vale: 'many', 'nick' o 'repeated'.
function normalizeCharacters(list) {
  const fail = (code, nick) => Object.assign(new Error(code), { code, nick });
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_CHARACTERS) throw fail('many');
  const seen = new Set();
  return list.map((raw) => {
    const nick = String((raw && raw.nick) || '').trim();
    if (!validNick(nick)) throw fail('nick', nick);
    if (seen.has(nick.toLowerCase())) throw fail('repeated', nick);
    seen.add(nick.toLowerCase());
    const label = String((raw && raw.label) || '').trim().slice(0, 40);
    const model = raw && typeof raw.model === 'string' && raw.model ? raw.model.slice(0, 200) : null;
    return { nick, label, model };
  });
}

const findCharacter = (characters, nick) =>
  (characters || []).find((c) => c.nick.toLowerCase() === String(nick || '').toLowerCase()) || null;

module.exports = { MAX_CHARACTERS, validNick, listModels, selectModel, normalizeCharacters, findCharacter };
