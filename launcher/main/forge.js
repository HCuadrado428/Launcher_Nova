const fs = require('node:fs');
const path = require('node:path');
const {
  installForgeTask,
  installDependenciesTask,
  installVersionTask,
  getVersionList,
} = require('@xmcl/installer');
const { Version } = require('@xmcl/core');
const { t } = require('../i18n');

// Instalación de Minecraft + Forge en la carpeta compartida game/ (adaptado
// del Ember Launcher). Se hace una sola vez por versión: los dos modpacks
// usan la misma, así que el segundo no vuelve a descargar nada.

// @xmcl/installer usa por defecto http://files.minecraftforge.net/maven, que
// redirige a https y su cliente no sigue la redirección: hay que forzar https.
const FORGE_MAVEN_HTTPS = 'https://files.minecraftforge.net/maven';
const CONCURRENCY = { assetsDownloadConcurrency: 10, librariesDownloadConcurrency: 10 };
const MARKER_FILE = '.nova-forge.json';

// Build de Forge recomendada para una versión de Minecraft (se usa cuando en
// el panel se deja la versión de Forge vacía).
async function resolveRecommendedForge(mcVersion) {
  const res = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(t('err.forgeVersions', { status: res.status }));
  const promos = (await res.json()).promos || {};
  const pick = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`];
  if (!pick) throw new Error(t('err.noForge', { mc: mcVersion }));
  return pick;
}

function readMarker(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, MARKER_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function runTask(task, label, onProgress) {
  return task.startAndWait({
    onUpdate: () => {
      if (task.total) onProgress({ label, percent: Math.min(100, Math.round((task.progress / task.total) * 100)) });
    },
  });
}

// Devuelve el id de versión instalado (p.ej. "1.20.1-forge-47.4.10"), que es
// lo que se le pasa a @xmcl/core para lanzar el juego.
async function ensureForge({ root, mcVersion, forgeVersion, javaPath, onProgress }) {
  const wanted = forgeVersion || (await resolveRecommendedForge(mcVersion));
  const key = `${mcVersion}-forge-${wanted}`;
  const marker = readMarker(root);
  const cached = marker[key];
  if (cached && fs.existsSync(path.join(root, 'versions', cached, `${cached}.json`))) return cached;

  fs.mkdirSync(root, { recursive: true });

  // El instalador de Forge necesita el .jar vanilla ya en disco.
  onProgress({ label: t('prog.minecraft'), percent: 0 });
  const versionList = await getVersionList();
  const versionMeta = versionList.versions.find((v) => v.id === mcVersion);
  if (!versionMeta) throw new Error(t('err.mcMissing', { mc: mcVersion }));
  await runTask(installVersionTask(versionMeta, root, CONCURRENCY), t('prog.minecraft'), onProgress);

  onProgress({ label: t('prog.forge'), percent: 0 });
  let versionId;
  try {
    versionId = await runTask(
      installForgeTask({ mcversion: mcVersion, version: wanted }, root, { mavenHost: FORGE_MAVEN_HTTPS, java: javaPath }),
      t('prog.forge'),
      onProgress,
    );
  } catch (err) {
    throw new Error(t('err.forgeInstall', { forge: wanted, mc: mcVersion, detail: err.message || err }), {
      cause: err,
    });
  }

  // Miles de archivos pequeños en paralelo: un corte puntual de red es
  // normal. Lo ya descargado se salta, así que reintentar es barato.
  const resolved = await Version.parse(root, versionId);
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await runTask(installDependenciesTask(resolved, CONCURRENCY), t('prog.libs'), onProgress);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (lastError) throw lastError;

  fs.writeFileSync(path.join(root, MARKER_FILE), JSON.stringify({ ...marker, [key]: versionId }, null, 2));
  return versionId;
}

module.exports = { ensureForge };
