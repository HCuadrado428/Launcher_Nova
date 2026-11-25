# Privacy policy · Política de privacidad

*English first; español más abajo.*

## English

Nova Launcher has no advertising and sends nothing to analytics companies. It only contacts other systems to do what you ask it to do: sign in, download the game and its mods, and show the server status. Its own server keeps a few usage counts for the server's owner, listed below.

| When | Who is contacted | What is sent |
|---|---|---|
| Signing in with Microsoft | Microsoft, Xbox and Minecraft services | Your Microsoft sign-in, in Microsoft's own window. The launcher never sees your password. |
| When a session with the launcher server is opened or renewed, and when the launcher lists your modpacks | The Nova Launcher server (`launchernova-production.up.railway.app`) | Microsoft accounts: your Minecraft session token, so the server can ask Minecraft's services who you are. The server does not store the token. Non-premium accounts: the nickname you typed. The server answers with which modpacks your account may use. |
| Pressing Play | The Nova Launcher server, Mojang and Forge | Requests to download Java, Minecraft, Forge, the mods and the modpack's settings files. The launcher also tells its server which optional mods you have turned off. |
| While the launcher is open | `api.mcsrvstat.us` | The address of the NOVA 2 Minecraft server, to show whether it is online. |
| Showing your avatar (Microsoft accounts) | `mc-heads.net` | Your Minecraft account ID (public). |
| Searching for or installing client mods (Mods section) | Modrinth (`api.modrinth.com`, `cdn.modrinth.com`) | What you typed in the search box, the game version, and the download of the mods you choose. |
| Searching CurseForge (only if the server offers it) | The Nova Launcher server, which asks CurseForge on your behalf; downloads come from CurseForge (`forgecdn.net`) | What you typed in the search box and the game version. CurseForge sees the server's request, not yours, until you download a mod. |
| Checking for launcher updates | GitHub | A request for the latest release of this repository. |

The Nova Launcher server keeps a list of the players who have used the launcher, visible only to the server's owner: Minecraft nickname, Minecraft account ID (Microsoft accounts), whether the account is premium, the first and last time the launcher contacted the server, and the launcher version. The owner uses it to decide who may use the admin modpack and to suspend a player's access to the launcher. It keeps no passwords and no session tokens.

For the owner's statistics the server also keeps, per player, which optional mods are turned off, and for the last 60 days which players opened the launcher each day. Admins who create characters (extra non-premium nicknames for the admin modpack) have those nicknames stored with their account.

As with any internet connection, each of those systems sees your IP address.

Sign-in tokens are stored only on your computer, encrypted with the operating system's credential storage when available. "Save logs" creates a file on your computer and sends it nowhere; you decide whether to share it.

The launcher cannot work without those connections, so there is no switch to turn them off. To stop all of them, sign out or uninstall the launcher.

Third parties and their policies: [Microsoft](https://privacy.microsoft.com/privacystatement), [Mojang / Minecraft](https://www.minecraft.net/privacy), [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement), [Modrinth](https://modrinth.com/legal/privacy), [CurseForge](https://www.curseforge.com/privacy-policy), [Railway](https://railway.com/legal/privacy), [mcsrvstat.us](https://mcsrvstat.us/), [mc-heads.net](https://mc-heads.net/).

## Español

Nova Launcher no tiene publicidad ni envía nada a empresas de analíticas. Solo se conecta a otros sistemas para hacer lo que le pides: iniciar sesión, descargar el juego y sus mods, y enseñar el estado del servidor. Su propio servidor guarda unos pocos datos de uso para el dueño del servidor, que se detallan abajo.

| Cuándo | Con quién se conecta | Qué se envía |
|---|---|---|
| Al entrar con Microsoft | Servicios de Microsoft, Xbox y Minecraft | Tu inicio de sesión de Microsoft, en la ventana de la propia Microsoft. El launcher nunca ve tu contraseña. |
| Al abrir o renovar la sesión con el servidor del launcher, y cuando el launcher pide tu lista de modpacks | El servidor del Nova Launcher (`launchernova-production.up.railway.app`) | Cuentas Microsoft: tu token de sesión de Minecraft, para que el servidor pregunte a los servicios de Minecraft quién eres. El servidor no guarda el token. Cuentas sin premium: el nick que escribiste. El servidor responde con los modpacks que puede usar tu cuenta. |
| Al pulsar Jugar | El servidor del Nova Launcher, Mojang y Forge | Peticiones para descargar Java, Minecraft, Forge, los mods y los archivos de configuración del modpack. El launcher también le dice a su servidor qué mods opcionales tienes desactivados. |
| Con el launcher abierto | `api.mcsrvstat.us` | La dirección del servidor de Minecraft de NOVA 2, para enseñar si está online. |
| Al enseñar tu avatar (cuentas Microsoft) | `mc-heads.net` | El identificador de tu cuenta de Minecraft (es público). |
| Al buscar o instalar mods de cliente (sección Mods) | Modrinth (`api.modrinth.com`, `cdn.modrinth.com`) | Lo que escribes en el buscador, la versión del juego y la descarga de los mods que elijas. |
| Al buscar en CurseForge (solo si el servidor lo ofrece) | El servidor del Nova Launcher, que pregunta a CurseForge por ti; las descargas vienen de CurseForge (`forgecdn.net`) | Lo que escribes en el buscador y la versión del juego. CurseForge ve la petición del servidor, no la tuya, hasta que descargas un mod. |
| Al buscar actualizaciones del launcher | GitHub | Una petición de la última versión de este repositorio. |

El servidor del Nova Launcher guarda una lista de los jugadores que han usado el launcher, que solo ve el dueño del servidor: nick de Minecraft, identificador de la cuenta de Minecraft (cuentas Microsoft), si la cuenta es premium, la primera y la última vez que el launcher contactó con el servidor, y la versión del launcher. El dueño la usa para decidir quién puede usar el modpack de admins y para suspender el acceso de un jugador al launcher. No guarda contraseñas ni tokens de sesión.

Para las estadísticas del dueño, el servidor guarda además, por jugador, qué mods opcionales tiene desactivados y, de los últimos 60 días, qué jugadores abrieron el launcher cada día. A los admins que crean personajes (nicks sin premium para el modpack de admins) se les guardan esos nicks junto a su cuenta.

Como en cualquier conexión a internet, cada uno de esos sistemas ve tu dirección IP.

Los tokens de sesión se guardan solo en tu equipo, cifrados con el almacén de credenciales del sistema cuando está disponible. «Guardar registros» crea un archivo en tu equipo y no lo envía a ningún sitio; tú decides si lo compartes.

El launcher no puede funcionar sin esas conexiones, así que no hay un interruptor para desactivarlas. Para cortarlas todas, cierra sesión o desinstala el launcher.
