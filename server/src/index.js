const path = require('node:path');
const { createApp } = require('./app');
const { createGoogleVerifier, fetchMinecraftProfile, lookupMojangProfile } = require('./external');

// Arranque del backend. Toda la configuración viene de variables de entorno
// (ver README.md): en Railway se ponen en la pestaña "Variables".

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const googleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const ownerEmail = process.env.OWNER_EMAIL || 'noovaasmp@gmail.com';
const jwtSecret = process.env.JWT_SECRET || '';

if (jwtSecret.length < 32) {
  console.error('Falta JWT_SECRET (mínimo 32 caracteres). Genera uno con: openssl rand -hex 32');
  process.exit(1);
}
if (!googleClientId) {
  console.warn('[AVISO] Falta GOOGLE_CLIENT_ID: nadie podrá entrar al panel hasta que la configures.');
}
if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn('[AVISO] No hay volumen montado: los mods subidos se perderán en cada despliegue.');
}

const app = createApp({
  dataDir,
  jwtSecret,
  ownerEmail,
  googleClientId,
  verifyGoogleCredential: googleClientId
    ? createGoogleVerifier(googleClientId)
    : async () => {
        throw new Error('GOOGLE_CLIENT_ID sin configurar');
      },
  fetchMinecraftProfile,
  lookupMojangProfile,
});

app.listen(port, () => {
  console.log(`Nova Launcher backend en el puerto ${port} · datos en ${dataDir} · dueño: ${ownerEmail}`);
});
