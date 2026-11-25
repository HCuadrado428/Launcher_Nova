const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { t } = require('../i18n');

// Cliente del backend del launcher (carpeta server/ del repo). No depende de
// Electron: recibe la URL y el token en cada llamada.

const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

class ApiError extends Error {
  // data: el cuerpo JSON del error (p. ej. { code: 'banned', until, reason }).
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Versión del launcher: el backend la enseña en la lista de jugadores del panel.
let clientVersion = '';
function setClientVersion(version) {
  clientVersion = String(version || '');
}

function baseHeaders(token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (clientVersion) headers['X-Launcher-Version'] = clientVersion;
  return headers;
}

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function request(baseUrl, pathname, { method = 'GET', token, body } = {}) {
  const headers = baseHeaders(token);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${cleanBaseUrl(baseUrl)}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, t('err.connect'));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || t('err.server', { status: res.status }), data);
  if (!data) throw new ApiError(res.status, t('err.unexpected'));
  return data;
}

async function downloadFile(baseUrl, pathname, token, destPath) {
  let res;
  try {
    res = await fetch(`${cleanBaseUrl(baseUrl)}${pathname}`, {
      headers: baseHeaders(token),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, t('err.downloadCut'));
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, (data && data.error) || t('err.download', { status: res.status }));
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

module.exports = {
  ApiError,
  cleanBaseUrl,
  setClientVersion,
  loginMicrosoft: (baseUrl, accessToken) =>
    request(baseUrl, '/api/auth/microsoft', { method: 'POST', body: { accessToken } }),
  loginOffline: (baseUrl, username) => request(baseUrl, '/api/auth/offline', { method: 'POST', body: { username } }),
  listModpacks: (baseUrl, token) => request(baseUrl, '/api/modpacks', { token }),
  setCharacters: (baseUrl, token, characters) =>
    request(baseUrl, '/api/me/characters', { method: 'PUT', token, body: { characters } }),
  // disabled: mods opcionales que el jugador tiene desactivados (solo para las estadísticas del panel).
  getManifest: (baseUrl, token, modpackId, disabled = null) =>
    request(
      baseUrl,
      `/api/modpacks/${modpackId}/manifest${disabled ? `?disabled=${encodeURIComponent(disabled.join(','))}` : ''}`,
      { token },
    ),
  // Avisa de un cierre por error (solo para las estadísticas del panel).
  reportCrash: (baseUrl, token, suspects) =>
    request(baseUrl, '/api/me/crash', { method: 'POST', token, body: { suspects } }),
  searchCurseforge: (baseUrl, token, query, mcVersion) =>
    request(baseUrl, `/api/curseforge/search?q=${encodeURIComponent(query)}&mc=${encodeURIComponent(mcVersion)}`, { token }),
  curseforgeFile: (baseUrl, token, modId, mcVersion) =>
    request(baseUrl, `/api/curseforge/mods/${encodeURIComponent(modId)}/file?mc=${encodeURIComponent(mcVersion)}`, { token }),
  downloadMod: (baseUrl, token, modpackId, sha1, destPath) =>
    downloadFile(baseUrl, `/api/modpacks/${modpackId}/files/${sha1}`, token, destPath),
};
