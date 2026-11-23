const crypto = require('node:crypto');
const { launch, generateArguments } = require('@xmcl/core');

// Arranque de Minecraft con @xmcl/core, la misma familia de librerías que
// instala Forge. Lee el perfil de versión de Forge completo, incluidos sus
// argumentos de la JVM (--add-opens, -p, ...): sin ellos Forge 1.17+ muere
// nada más arrancar con "InaccessibleObjectException".

// Mismo UUID que usa un servidor en modo offline para ese nick.
function offlineUuid(username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

function launchOptions({ account, gameRoot, instanceDir, versionId, javaPath, memoryGb, serverAddress }) {
  const microsoft = account.type === 'microsoft';
  const auth = microsoft ? account.mclcAuth : null;
  return {
    version: versionId,
    gamePath: instanceDir, // mods, mundos y opciones de este modpack
    resourcePath: gameRoot, // versiones, librerías y assets compartidos
    javaPath,
    minMemory: 2048,
    maxMemory: memoryGb * 1024,
    gameProfile: {
      name: microsoft ? auth.name : account.username,
      id: (microsoft ? auth.uuid : offlineUuid(account.username)).replace(/-/g, ''),
    },
    accessToken: microsoft ? auth.access_token : '0',
    userType: microsoft ? 'msa' : 'legacy',
    launcherName: 'NovaLauncher',
    launcherBrand: 'NovaLauncher',
    // Valores para ${clientid} y ${auth_xuid} de los argumentos del juego.
    features: {
      nova: {
        clientid: crypto.randomUUID(),
        auth_xuid: (microsoft && auth.meta && auth.meta.xuid) || '0',
      },
    },
    ...(serverAddress ? { quickPlayMultiplayer: serverAddress } : {}),
  };
}

// Lanza el juego y devuelve el proceso. onLog recibe la salida línea a línea.
async function launchGame(params, { onLog, onClose }) {
  let child;
  try {
    child = await launch({ ...launchOptions(params), extraExecOption: { detached: false } });
  } catch (err) {
    const reasons = {
      MissingLibraries: 'Faltan librerías del juego.',
      CorruptedVersionJar: 'El archivo del juego está dañado.',
      MissingVersionJar: 'Falta el archivo del juego.',
    };
    const reason = reasons[err && err.error];
    if (reason) throw new Error(`${reason} Pulsa «Reparar mods» en Ajustes y vuelve a intentarlo.`, { cause: err });
    throw err;
  }
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onLog(line);
    });
    stream.on('end', () => {
      if (pending) onLog(pending);
    });
  }
  child.on('error', (err) => onLog(`[ERROR] No se pudo iniciar Java: ${err.message}`));
  child.on('close', (code) => onClose(code));
  return child;
}

module.exports = { launchGame, launchOptions, offlineUuid, generateArguments };
