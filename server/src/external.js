const { OAuth2Client } = require('google-auth-library');

// Llamadas a servicios de fuera (Google, Mojang, Microsoft). Van aparte para
// que los tests puedan sustituirlas por versiones falsas sin tocar la red.

const TIMEOUT_MS = 10_000;

function normalizeUuid(uuid) {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

// Comprueba el "credential" que devuelve el botón de Google del panel y
// devuelve el correo solo si Google confirma que está verificado.
function createGoogleVerifier(clientId) {
  const client = new OAuth2Client(clientId);
  return async (credential) => {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.email_verified) throw new Error('Correo de Google sin verificar.');
    return { email: payload.email.toLowerCase() };
  };
}

// Pregunta a los servidores de Minecraft de quién es un access_token. Es lo
// que demuestra que quien usa el launcher es de verdad el dueño de la cuenta
// (un nick offline se lo puede inventar cualquiera; esto no).
async function fetchMinecraftProfile(accessToken) {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Los servidores de Minecraft respondieron ${res.status}.`);
  const body = await res.json();
  if (!body.id || !body.name) return null;
  return { uuid: normalizeUuid(body.id), name: body.name };
}

// Nick -> UUID de una cuenta premium. Devuelve null si no existe.
async function lookupMojangProfile(nick) {
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nick)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Mojang respondió ${res.status}.`);
  const body = await res.json();
  if (!body.id || !body.name) return null;
  return { uuid: normalizeUuid(body.id), name: body.name };
}

// Cliente mínimo de la API de CurseForge: devuelve una función
// (ruta, parámetros) => JSON que manda la clave en la cabecera.
function createCurseforgeClient(apiKey) {
  return async (pathname, params = {}) => {
    const url = new URL(pathname, 'https://api.curseforge.com');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`CurseForge respondió ${res.status}`);
    return res.json();
  };
}

module.exports = {
  createCurseforgeClient, createGoogleVerifier, fetchMinecraftProfile, lookupMojangProfile, normalizeUuid };
