# Nova Launcher

El launcher del SMP **NOVA 2**: el jugador inicia sesión, el launcher se baja Java, Forge y los mods, y entra al servidor. Los mods se gestionan desde un panel web al que solo entra la cuenta del servidor.

```
launcher/   App de escritorio (Electron). Lo que se instalan los jugadores.
server/     Backend + panel web. Se despliega en Railway.
```

## Cómo funciona

- Hay **dos modpacks**: `NOVA 2` (para todos) y `NOVA 2 · ADMIN` (solo cuentas admin).
- El **panel web** es la página principal del backend (`https://tu-backend.up.railway.app/`). Solo deja entrar con Google al correo de `OWNER_EMAIL` (`noovaasmp@gmail.com`). Desde ahí:
  - arrastras los `.jar` a cada modpack (subir uno con el mismo nombre de archivo lo sustituye), o los quitas;
  - «Copiar los del normal» deja el modpack de admins igual que el normal, para subir encima solo los mods extra;
  - añades o quitas **nicks admin**.
- En el **launcher**, cada vez que alguien pulsa Jugar se compara su carpeta con el modpack del panel y se baja solo lo que ha cambiado (y se borra lo que ya no está). Los mods que el jugador haya metido a mano no se tocan.
- Una cuenta ve el modpack de admins solo si ha iniciado sesión **con Microsoft** y su cuenta está en la lista. El backend lo comprueba preguntando a los servidores de Minecraft, así que un nick offline con el mismo nombre no sirve. Quitar un nick de la lista le corta el acceso al momento.

> El launcher no da `/op` en el servidor de Minecraft: la lista de admins del panel y los ops del servidor son dos listas distintas que mantienes tú.

## Puesta en marcha

### 1. Backend en Railway

1. En Railway: **New Project → Deploy from GitHub repo → `Launcher_Nova`**.
2. En los ajustes del servicio, pon **Root Directory** = `server`.
3. Añade un **volumen** al servicio (por ejemplo montado en `/data`). Ahí se guardan los mods y la lista de admins; sin volumen se pierden en cada despliegue.
4. En **Networking**, genera un dominio público. Esa es la dirección de tu backend.
5. En **Variables**:

| Variable | Valor |
|---|---|
| `JWT_SECRET` | Una cadena aleatoria larga (`openssl rand -hex 32`). |
| `GOOGLE_CLIENT_ID` | El ID de cliente del paso siguiente. |
| `OWNER_EMAIL` | Opcional. Por defecto `noovaasmp@gmail.com`. |

### 2. Inicio de sesión con Google para el panel

1. En [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (vale el mismo proyecto de Firebase de la web), **Crear credenciales → ID de cliente de OAuth → Aplicación web**.
2. En **Orígenes de JavaScript autorizados** añade la dirección del backend (`https://tu-backend.up.railway.app`).
3. Copia el ID de cliente a la variable `GOOGLE_CLIENT_ID` de Railway.

Abre la dirección del backend, entra con `noovaasmp@gmail.com` y ya puedes subir mods y añadir admins.

### 3. Launcher

1. Pon la dirección del backend en `launcher/main/constants.js` (`DEFAULT_BACKEND_URL`).
2. Para probarlo: `cd launcher && npm install && npm start`.
3. Para publicar el instalador de Windows: sube el número de `version` en `launcher/package.json` y haz push a `main`. GitHub Actions compila el instalador y lo publica en **Releases** con esa versión. Los launchers instalados se actualizan solos.

También se puede compilar a mano en Windows con `npm run dist` (el instalador queda en `launcher/dist/`).

## Detalles

- **Versión del juego:** Minecraft 1.20.1 con Forge 47.4.10. Se cambia en el panel, en «Versión de Minecraft y Forge» de cada modpack; tiene que coincidir con la del servidor.
- **Java:** el launcher descarga el Java 17 oficial de Mojang la primera vez. En Ajustes se puede elegir otro.
- **Dónde se guarda todo en el PC del jugador:** `%APPDATA%\.novalauncher` (`game/` compartido, `instances/normal` e `instances/admin` con sus mods, mundos y opciones).
- **Entrar directo al servidor:** activado por defecto (Ajustes) en el modpack normal. El modpack admin abre siempre en el menú principal. La IP está en `launcher/main/constants.js`.
- **Límites del panel:** 300 MB por `.jar`.

## Desarrollo

```sh
cd server && npm install && npm test      # API del backend
cd launcher && npm install && npm test    # sincronización contra el backend real y descarga de Java
```

Backend en local: copia `server/.env.example` a `server/.env`, rellénalo y ejecuta `node --env-file=.env src/index.js` dentro de `server/`.

Las fuentes (Press Start 2P e Inter) tienen licencia SIL Open Font License 1.1; ver `launcher/assets/fonts/`.
