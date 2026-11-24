# Nova Launcher

El launcher del SMP **NOVA 2**: el jugador inicia sesión, el launcher se baja Java, Forge y los mods, y entra al servidor. Los mods se gestionan desde un panel web al que solo entra la cuenta del servidor.

## Descargar · Download

**[Última versión para Windows · Latest Windows installer](https://github.com/HCuadrado428/Launcher_Nova/releases/latest)**: descarga el archivo `.exe` y ejecútalo.

The installer is not code-signed, so Windows and some browsers may warn before running it. See the [code signing policy](#code-signing-policy) and the [guía de instalación](https://hcuadrado428.github.io/Nova-Web/).

## Contenido del repositorio

```
launcher/   App de escritorio (Electron). Lo que se instalan los jugadores.
mod/        Mod de Forge con el menú principal de NOVA 2. Lo compila GitHub Actions.
server/     Backend + panel web. Se despliega en Railway.
```

## Cómo funciona

- Hay **dos modpacks**: `NOVA 2` (para todos) y `NOVA 2 · ADMIN` (solo cuentas admin).
- El **panel web** es la página principal del backend (`https://tu-backend.up.railway.app/`). Solo deja entrar con Google al correo de `OWNER_EMAIL` (`noovaasmp@gmail.com`). Desde ahí:
  - arrastras los `.jar` a cada modpack, o los quitas. Subir otra versión de un mod sustituye a la anterior aunque el archivo se llame distinto;
  - marcas como **Opcional** los mods de cliente (minimapa, shaders...) y les pones un nombre y una frase: cada jugador decide en el launcher si los usa;
  - «Copiar los del normal» deja el modpack de admins igual que el normal, para subir encima solo los mods extra;
  - escribes las **novedades** y el **próximo evento** (con cuenta atrás) que ven todos al abrir el launcher;
  - ves la **lista de jugadores** que han abierto el launcher (nick, última vez, versión), haces admin a quien quieras con un botón y **suspendes** el acceso al launcher por un tiempo o sin fecha de fin;
  - añades o quitas **nicks admin**.
- En el **launcher**, cada vez que alguien pulsa Jugar se compara su carpeta con el modpack del panel y se baja solo lo que ha cambiado (y se borra lo que ya no está). Los mods que el jugador haya metido a mano no se tocan, y los opcionales que haya desactivado no se le vuelven a bajar. Todo eso se gestiona desde el botón **Mods** del launcher.
- Una cuenta ve el modpack de admins solo si ha iniciado sesión **con Microsoft** y su cuenta está en la lista. El backend lo comprueba preguntando a los servidores de Minecraft, así que un nick offline con el mismo nombre no sirve. Quitar un nick de la lista le corta el acceso al momento.

> Suspender a alguien desde el panel le impide usar el launcher, pero no lo expulsa del servidor de Minecraft: para eso está `/ban` en el servidor. A una cuenta sin premium se la suspende por su nick, así que puede volver con otro.

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
- **Memoria:** por defecto la elige el launcher según el equipo (8 GB con 16 o más, 6 con 12, 5 con 8). En Ajustes se puede fijar a mano.
- **Ayuda para el jugador:** «¿Problemas?» guarda los registros y abre el Discord (la invitación se pone en el panel). El tamaño del texto se cambia en Ajustes.
- **Dónde se guarda todo en el PC del jugador:** `%APPDATA%\.novalauncher` (`game/` compartido, `instances/normal` e `instances/admin` con sus mods, mundos y opciones).
- **Menú del juego:** el mod `novamenu` (carpeta `mod/`) deja el menú principal con «Entrar al Nova 2», Opciones y Salir. Hay que subir su `.jar` al modpack desde el panel. En el modpack admin el launcher lo desactiva solo, así que puede estar en los dos. La IP del servidor está en `launcher/main/constants.js`.
- **Entrar directo al servidor:** desactivado por defecto; se activa en Ajustes y solo afecta al modpack normal.
- **Idiomas:** el launcher está en español, inglés y portugués (`launcher/i18n.js`). Usa el del sistema la primera vez y se cambia en Ajustes. El panel y los mensajes que devuelve el backend están solo en español.
- **Si el juego se cierra por un error:** el launcher lee el informe que deja Minecraft y enseña qué ha pasado y qué mod tiene pinta de ser el culpable.
- **Registros:** «Guardar registros» (en Ajustes y en el aviso de error) crea un `.zip` con `latest.log`, `debug.log`, el último informe de error y un resumen del launcher, listo para mandar por Discord.
- **Límites del panel:** 300 MB por `.jar`.

## Desarrollo

```sh
cd server && npm install && npm test      # API del backend
cd launcher && npm install && npm test    # sincronización contra el backend real y descarga de Java
```

Backend en local: copia `server/.env.example` a `server/.env`, rellénalo y ejecuta `node --env-file=.env src/index.js` dentro de `server/`.

## Licencia

El código es libre bajo la [licencia MIT](LICENSE). Las fuentes (Press Start 2P e Inter) tienen licencia SIL Open Font License 1.1; ver `launcher/assets/fonts/`. El nombre y el logo de NOVA 2 identifican al servidor y no se ceden con la licencia.

## Code signing policy

The Windows installer is built by GitHub Actions from the source code in this repository (`.github/workflows/release.yml`); no binaries are built or uploaded by hand.

The installer is currently **not code-signed**.

- Committers and reviewers: [HCuadrado428](https://github.com/HCuadrado428)
- Approvers: [HCuadrado428](https://github.com/HCuadrado428)

Privacy: this program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. What it sends when you sign in, download the game or check the server is listed in the [privacy policy](PRIVACY.md).
