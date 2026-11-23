const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { installJavaRuntimeTask } = require('@xmcl/installer');

// Java para el juego. Si el jugador no ha elegido uno en Ajustes, el launcher
// usa su propia copia del Java oficial de Mojang (la misma que baja el
// launcher de Minecraft) y la descarga la primera vez: así nadie tiene que
// instalar Java a mano ni acertar con la versión.

// Qué runtime de Mojang corresponde a cada versión de Minecraft.
function runtimeFor(mcVersion) {
  const [, minor = 0, patch = 0] = mcVersion.split('.').map(Number);
  if (minor <= 16) return { target: 'jre-legacy', major: 8 };
  if (minor === 17) return { target: 'java-runtime-alpha', major: 16 };
  if (minor < 20 || (minor === 20 && patch <= 4)) return { target: 'java-runtime-gamma', major: 17 };
  return { target: 'java-runtime-delta', major: 21 };
}

const RUNTIME_INDEX_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function runtimePlatform() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return arch === 'ia32' ? 'linux-i386' : 'linux';
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`estado ${res.status}`);
  return res.json();
}

// Lista de archivos del Java de Mojang para este sistema. Se pide a mano en
// vez de con fetchJavaRuntimeManifest() de @xmcl/installer, que en la versión
// que usamos falla siempre ("invalid throwOnError") por un cambio de undici.
async function fetchRuntimeManifest(target, indexUrl) {
  const index = await fetchJson(indexUrl);
  const entries = (index[runtimePlatform()] || {})[target];
  if (!entries || entries.length === 0) throw new Error('Mojang no ofrece ese Java para este sistema.');
  const manifest = await fetchJson(entries[0].manifest.url);
  return { files: manifest.files, target, version: entries[0].version };
}

function javaExecutable(dir) {
  if (process.platform === 'win32') return path.join(dir, 'bin', 'javaw.exe');
  if (process.platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(dir, 'bin', 'java');
}

// "Major" del Java de una ruta (8, 17, 21...) o null si no responde.
function javaMajor(javaPath) {
  // javaw.exe no escribe en consola; para preguntar la versión se usa java.exe.
  const exe = javaPath.replace(/javaw\.exe$/i, 'java.exe');
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 15_000 }, (err, stdout, stderr) => {
      const match = `${stdout || ''}${stderr || ''}`.match(/version "(\d+)(?:\.(\d+))?/);
      if (!match) return resolve(null);
      const first = Number(match[1]);
      resolve(first === 1 && match[2] ? Number(match[2]) : first);
    });
  });
}

async function ensureJava({ runtimeDir, mcVersion, customPath, onProgress = () => {}, runtimeIndexUrl = RUNTIME_INDEX_URL }) {
  const wanted = runtimeFor(mcVersion);

  if (customPath) {
    if (!fs.existsSync(customPath)) throw new Error('La ruta de Java de Ajustes ya no existe. Cámbiala o déjala en automático.');
    const major = await javaMajor(customPath);
    return { javaPath: customPath, warning: major && major !== wanted.major ? { found: major, wanted: wanted.major } : null };
  }

  const dir = path.join(runtimeDir, wanted.target);
  const exe = javaExecutable(dir);
  const marker = path.join(dir, '.nova-ok');
  if (fs.existsSync(marker) && fs.existsSync(exe)) return { javaPath: exe, warning: null };

  onProgress({ label: `Descargando Java ${wanted.major}`, percent: 0 });
  let manifest;
  try {
    manifest = await fetchRuntimeManifest(wanted.target, runtimeIndexUrl);
  } catch (err) {
    throw new Error(`No se pudo descargar Java ${wanted.major}. Comprueba tu conexión e inténtalo de nuevo.`, {
      cause: err,
    });
  }
  const task = installJavaRuntimeTask({ destination: dir, manifest });
  try {
    await task.startAndWait({
      onUpdate: () => {
        if (task.total) {
          onProgress({
            label: `Descargando Java ${wanted.major}`,
            percent: Math.min(100, Math.round((task.progress / task.total) * 100)),
          });
        }
      },
    });
  } catch (err) {
    throw new Error(`Se cortó la descarga de Java ${wanted.major}. Vuelve a pulsar Jugar para continuarla.`, { cause: err });
  }
  // El instalador no marca los ejecutables (en Windows no hace falta).
  if (process.platform !== 'win32') {
    for (const [file, entry] of Object.entries(manifest.files)) {
      if (entry.type === 'file' && entry.executable) fs.chmodSync(path.join(dir, file), 0o755);
    }
  }
  if (!fs.existsSync(exe)) throw new Error('La descarga de Java ha terminado pero no se encuentra el ejecutable.');
  fs.writeFileSync(marker, manifest.version.name);
  return { javaPath: exe, warning: null };
}

module.exports = { ensureJava, runtimeFor, javaMajor };
