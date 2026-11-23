const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchOptions, offlineUuid, generateArguments } = require('../main/launch');

// Monta en una carpeta temporal los perfiles de versión tal como los deja el
// instalador (vanilla + Forge que hereda de él) y comprueba la línea de
// comandos que saldría, sin arrancar el juego.
function fakeGameRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-launch-'));
  const write = (id, json) => {
    fs.mkdirSync(path.join(root, 'versions', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'versions', id, `${id}.json`), JSON.stringify(json));
  };
  write('1.20.1', {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: { id: '5', sha1: 'a'.repeat(40), size: 1, totalSize: 1, url: 'https://example.invalid/5.json' },
    downloads: { client: { sha1: 'b'.repeat(40), size: 1, url: 'https://example.invalid/client.jar' } },
    libraries: [],
    arguments: {
      game: [
        '--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}',
        '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}',
        '--accessToken', '${auth_access_token}', '--clientId', '${clientid}', '--xuid', '${auth_xuid}',
        '--userType', '${user_type}', '--versionType', '${version_type}',
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
      ],
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
  });
  // Los argumentos de la JVM que trae de verdad el perfil de Forge 1.20.1.
  write('1.20.1-forge-47.4.10', {
    id: '1.20.1-forge-47.4.10',
    inheritsFrom: '1.20.1',
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [],
    arguments: {
      game: ['--launchTarget', 'forgeclient', '--fml.forgeVersion', '47.4.10', '--fml.mcVersion', '1.20.1'],
      jvm: [
        '-DignoreList=bootstraplauncher,securejarhandler,forge-,${version_name}.jar',
        '-DlibraryDirectory=${library_directory}',
        '-p',
        '${library_directory}/cpw/mods/bootstraplauncher/1.1.2/bootstraplauncher-1.1.2.jar${classpath_separator}${library_directory}/cpw/mods/securejarhandler/2.1.10/securejarhandler-2.1.10.jar',
        '--add-modules', 'ALL-MODULE-PATH',
        '--add-opens', 'java.base/java.util.jar=cpw.mods.securejarhandler',
        '--add-opens', 'java.base/java.lang.invoke=cpw.mods.securejarhandler',
        '--add-exports', 'java.base/sun.security.util=cpw.mods.securejarhandler',
      ],
    },
  });
  return root;
}

const microsoft = {
  type: 'microsoft',
  username: 'HCuadrado',
  mclcAuth: { name: 'HCuadrado', uuid: '0123456789abcdef0123456789abcdef', access_token: 'TOKEN-MS', meta: { xuid: '2533' } },
};

test('la línea de comandos lleva los argumentos de la JVM de Forge', async () => {
  const root = fakeGameRoot();
  const instanceDir = path.join(root, 'instances', 'normal');
  try {
    const cmd = await generateArguments(
      launchOptions({
        account: microsoft,
        gameRoot: root,
        instanceDir,
        versionId: '1.20.1-forge-47.4.10',
        javaPath: '/java/bin/java',
        memoryGb: 6,
        serverAddress: 'xray.dathost.net:17487',
        joinOnStart: true,
      }),
    );
    const main = cmd.indexOf('cpw.mods.bootstraplauncher.BootstrapLauncher');
    assert.ok(main > 0, 'arranca por el BootstrapLauncher de Forge');
    const jvm = cmd.slice(0, main);
    const game = cmd.slice(main + 1);
    const libs = path.join(root, 'libraries');

    // Justo lo que faltaba cuando el juego moría con InaccessibleObjectException.
    assert.equal(jvm[jvm.indexOf('java.base/java.lang.invoke=cpw.mods.securejarhandler') - 1], '--add-opens');
    assert.ok(jvm.includes('ALL-MODULE-PATH'));
    const modulePath = jvm[jvm.indexOf('-p') + 1];
    assert.ok(modulePath.startsWith(`${libs}/cpw/mods/bootstraplauncher`), modulePath);
    assert.ok(modulePath.includes(`${path.delimiter}${libs}/cpw/mods/securejarhandler`));
    assert.ok(jvm.includes(`-DlibraryDirectory=${libs}`));
    assert.ok(jvm.includes('-DignoreList=bootstraplauncher,securejarhandler,forge-,1.20.1.jar'));
    assert.ok(jvm[jvm.indexOf('-cp') + 1].endsWith(path.join('versions', '1.20.1', '1.20.1.jar')));
    assert.ok(jvm.includes('-Xmx6144M'));
    assert.ok(!jvm.includes('-Xmx2G'));
    assert.ok(jvm.includes('-XX:+UseG1GC'));
    assert.ok(jvm.includes('-Dnova.server=xray.dathost.net:17487'));
    assert.ok(!jvm.includes('-Dnova.menuLibre=true'), 'el modpack normal lleva el menú restringido');
    assert.ok(!cmd.some((arg) => arg.includes('${')), `sin huecos por rellenar: ${cmd.filter((a) => a.includes('${'))}`);

    const value = (flag) => game[game.indexOf(flag) + 1];
    assert.equal(value('--username'), 'HCuadrado');
    assert.equal(value('--uuid'), '0123456789abcdef0123456789abcdef');
    assert.equal(value('--accessToken'), 'TOKEN-MS');
    assert.equal(value('--userType'), 'msa');
    assert.equal(value('--xuid'), '2533');
    assert.equal(value('--gameDir'), instanceDir);
    assert.equal(value('--assetsDir'), path.join(root, 'assets'));
    assert.equal(value('--launchTarget'), 'forgeclient');
    assert.equal(value('--quickPlayMultiplayer'), 'xray.dathost.net:17487');
    assert.ok(!game.includes('--demo'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cuenta offline: UUID de servidor offline, menú libre y sin entrar directo', async () => {
  const root = fakeGameRoot();
  try {
    const cmd = await generateArguments(
      launchOptions({
        account: { type: 'offline', username: 'Lyra_Nova' },
        gameRoot: root,
        instanceDir: path.join(root, 'instances', 'normal'),
        versionId: '1.20.1-forge-47.4.10',
        javaPath: '/java/bin/java',
        memoryGb: 4,
        serverAddress: 'xray.dathost.net:17487',
        freeMenu: true,
      }),
    );
    const value = (flag) => cmd[cmd.indexOf(flag) + 1];
    assert.equal(value('--username'), 'Lyra_Nova');
    assert.equal(value('--uuid'), offlineUuid('Lyra_Nova'));
    assert.equal(value('--userType'), 'legacy');
    assert.ok(!cmd.includes('--quickPlayMultiplayer'), 'sin joinOnStart se abre en el menú');
    // Lo que pasa el launcher para el modpack admin.
    assert.ok(cmd.indexOf('-Dnova.menuLibre=true') < cmd.indexOf('cpw.mods.bootstraplauncher.BootstrapLauncher'));
    assert.ok(cmd.indexOf('-Dnova.menuLibre=true') > 0);
    assert.ok(!cmd.some((arg) => arg.includes('${')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('el UUID offline coincide con el de Java para "OfflinePlayer:Notch"', () => {
  // UUID.nameUUIDFromBytes("OfflinePlayer:Notch".getBytes(UTF_8))
  assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
});
