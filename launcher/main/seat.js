const fs = require('node:fs');
const path = require('node:path');

// Segunda ventana del modpack de admins: otro personaje abierto a la vez.
// Dos juegos no pueden compartir carpeta sin pisarse los ajustes y los
// registros, así que el segundo usa una carpeta propia que es un «espejo» de
// la principal:
//   - mods, modelos, recursos, shaders, mundos y capturas son ENLACES a las
//     carpetas de la principal (no ocupan sitio y siempre son los mismos);
//   - la configuración y las opciones se COPIAN de la principal cada vez que
//     se abre, para que cada juego pueda tener su modelo de CPM.

// Carpetas que se comparten con la principal mediante un enlace.
const LINKED = ['mods', 'player_models', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots', 'schematics', 'kubejs', 'defaultconfigs'];
// Carpetas que hacen falta aunque la principal aún no las tenga.
const ALWAYS = ['mods', 'player_models'];
// Lo que se copia en cada apertura.
const COPIED_DIRS = ['config'];
const COPIED_FILES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat'];

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

// Deja lista la carpeta del segundo juego. No borra nunca nada de la principal.
function prepareSeat(mainDir, seatDir) {
  fs.mkdirSync(seatDir, { recursive: true });
  for (const name of LINKED) {
    const target = path.join(mainDir, name);
    if (ALWAYS.includes(name)) fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(target)) continue;
    const link = path.join(seatDir, name);
    const stat = lstat(link);
    if (stat && stat.isSymbolicLink()) {
      // Un enlace que ya no lleva a ningún sitio (se movió la carpeta) se rehace.
      if (fs.existsSync(link)) continue;
      fs.rmSync(link, { force: true });
    } else if (stat) {
      continue; // hay una carpeta de verdad: no se toca
    }
    // «junction»: en Windows no pide permisos de administrador. En otros
    // sistemas Node lo trata como un enlace normal.
    fs.symlinkSync(target, link, 'junction');
  }
  for (const name of COPIED_DIRS) {
    const from = path.join(mainDir, name);
    const to = path.join(seatDir, name);
    const stat = lstat(to);
    // Solo se vacía si es una carpeta de verdad de esta copia (nunca un enlace).
    if (stat && stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(to, { recursive: true, force: true });
    else if (stat) fs.rmSync(to, { force: true });
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
    else fs.mkdirSync(to, { recursive: true });
  }
  for (const name of COPIED_FILES) {
    const from = path.join(mainDir, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(seatDir, name));
  }
}

module.exports = { prepareSeat, LINKED };
