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

// Nombre e icono que el propio modelo lleva dentro. Un .cpmmodel es: un byte
// 0x53, el nombre y la descripción (cada uno con su longitud delante), los
// datos del modelo y, al final, su icono en PNG. El icono se busca por la
// firma PNG (la última del archivo) para no depender del resto del formato.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_MODEL_BYTES = 24 * 1024 * 1024;
const MAX_ICON_BYTES = 400 * 1024;

function readVarInt(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buffer[offset + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  return null;
}

// Recorre los trozos del PNG hasta IEND para saber dónde acaba y qué mide.
function pngAt(buffer, start) {
  if (buffer.length < start + 33 || buffer.toString('latin1', start + 12, start + 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(start + 16);
  const height = buffer.readUInt32BE(start + 20);
  if (width < 1 || height < 1 || width > 256 || height > 256) return null;
  let pos = start + 8;
  while (pos + 12 <= buffer.length && pos - start <= MAX_ICON_BYTES) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    pos += 12 + length;
    if (type === 'IEND') return pos <= buffer.length ? buffer.subarray(start, pos) : null;
  }
  return null;
}

function modelInfo(file) {
  const info = { name: '', icon: null };
  let buffer;
  try {
    if (fs.statSync(file).size > MAX_MODEL_BYTES) return info;
    buffer = fs.readFileSync(file);
  } catch {
    return info;
  }
  if (buffer[0] === 0x53) {
    const length = readVarInt(buffer, 1);
    if (length && length.value > 0 && length.value <= 200 && length.next + length.value <= buffer.length) {
      info.name = buffer.toString('utf8', length.next, length.next + length.value).replace(/[\u0000-\u001f]/g, '').trim();
    }
  }
  const at = buffer.lastIndexOf(PNG_SIGNATURE);
  const png = at === -1 ? null : pngAt(buffer, at);
  if (png) info.icon = `data:image/png;base64,${png.toString('base64')}`;
  return info;
}

// Lo que enseña el launcher de cada modelo: archivo, nombre e icono.
function describeModels(instanceDir) {
  return listModels(instanceDir).map((file) => ({
    file,
    ...modelInfo(path.join(instanceDir, MODELS_DIR, ...file.split('/'))),
  }));
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

module.exports = {
  MAX_CHARACTERS,
  validNick,
  listModels,
  describeModels,
  modelInfo,
  selectModel,
  normalizeCharacters,
  findCharacter,
};
