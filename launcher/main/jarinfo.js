const yauzl = require('yauzl');

// (Misma lógica que server/src/jarinfo.js.)
// Lee el identificador del mod (modId) de un .jar de Forge, que está en
// META-INF/mods.toml. Sirve para reconocer que dos archivos con nombres
// distintos (p.ej. dos versiones) son el mismo mod. Devuelve null si el .jar
// no es un mod de Forge o no se puede leer: nunca lanza.

const MAX_TOML_BYTES = 256 * 1024;

function parseModId(toml) {
  const section = toml.indexOf('[[mods]]');
  if (section === -1) return null;
  const match = /^\s*modId\s*=\s*["']([^"'\r\n]{1,64})["']/m.exec(toml.slice(section));
  return match ? match[1].toLowerCase() : null;
}

function readModId(jarPath) {
  return new Promise((resolve) => {
    yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr) return resolve(null);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        zip.close();
        resolve(value);
      };
      zip.on('error', () => finish(null));
      zip.on('end', () => finish(null));
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'META-INF/mods.toml') return zip.readEntry();
        if (entry.uncompressedSize > MAX_TOML_BYTES) return finish(null);
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return finish(null);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', () => finish(null));
          stream.on('end', () => finish(parseModId(Buffer.concat(chunks).toString('utf8'))));
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { readModId, parseModId };
