const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');

// Archivos sueltos de un modpack (config, recursos, shaders): se suben al
// panel dentro de un .zip que lleva esas carpetas, o de uno en uno eligiendo
// la carpeta de destino.

// Carpetas del juego a las que puede ir un archivo repartido por el modpack.
const EXTRA_ROOTS = ['config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks'];
const MAX_EXTRA_ENTRIES = 3000;
const MAX_EXTRA_BYTES = 600 * 1024 * 1024; // descomprimido, por subida
const MAX_PATH_LENGTH = 200;

class ExtrasError extends Error {}

// Devuelve la ruta limpia («config/create/common.toml») o null si no vale:
// fuera de las carpetas permitidas, con «..», absoluta o con caracteres raros.
function cleanExtraPath(raw) {
  const text = String(raw || '').replace(/\\/g, '/');
  if (!text || text.length > MAX_PATH_LENGTH || text.startsWith('/') || text.endsWith('/')) return null;
  const parts = text.split('/');
  if (parts.length < 2 || !EXTRA_ROOTS.includes(parts[0])) return null;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')) return null;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: se rechazan a propósito
    if (/[\u0000-\u001f<>:"|?*]/.test(part)) return null;
  }
  return parts.join('/');
}

// Extrae a tmpDir los archivos del zip que van a una carpeta permitida.
// Devuelve { entries: [{ tmpPath, path, sha1, size }], skipped } (skipped:
// archivos del zip que no iban a ninguna de esas carpetas). Si algo falla,
// borra lo que hubiera extraído y lanza ExtrasError.
function extractExtras(zipPath, tmpDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr) return reject(new ExtrasError('El archivo no es un .zip válido.'));
      const entries = [];
      let skipped = 0;
      let total = 0;
      let done = false;
      const fail = (message) => {
        if (done) return;
        done = true;
        zip.close();
        for (const entry of entries) fs.rmSync(entry.tmpPath, { force: true });
        reject(new ExtrasError(message));
      };
      zip.on('error', () => fail('El .zip está dañado.'));
      zip.on('end', () => {
        if (done) return;
        done = true;
        resolve({ entries, skipped });
      });
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry(); // carpeta
        const target = cleanExtraPath(entry.fileName);
        if (!target) {
          skipped += 1;
          return zip.readEntry();
        }
        if (entries.some((known) => known.path.toLowerCase() === target.toLowerCase())) return zip.readEntry();
        if (entries.length >= MAX_EXTRA_ENTRIES) return fail(`El .zip tiene más de ${MAX_EXTRA_ENTRIES} archivos.`);
        total += entry.uncompressedSize;
        if (total > MAX_EXTRA_BYTES) return fail('El contenido del .zip pasa de 600 MB.');
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return fail('El .zip está dañado.');
          const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.part`);
          const hash = crypto.createHash('sha1');
          const out = fs.createWriteStream(tmpPath);
          let size = 0;
          entries.push({ tmpPath, path: target, sha1: '', size: 0 });
          const record = entries[entries.length - 1];
          stream.on('data', (chunk) => {
            hash.update(chunk);
            size += chunk.length;
          });
          stream.on('error', () => fail('El .zip está dañado.'));
          out.on('error', () => fail('No se pudo guardar el contenido del .zip.'));
          out.on('finish', () => {
            record.sha1 = hash.digest('hex');
            record.size = size;
            zip.readEntry();
          });
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { EXTRA_ROOTS, cleanExtraPath, extractExtras, ExtrasError };
