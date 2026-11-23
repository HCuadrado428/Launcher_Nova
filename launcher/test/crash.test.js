const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { analyzeCrash, parseCrashReport } = require('../main/crash');
const { writeLogsZip, redact } = require('../main/logs');

// Informe con el formato de Forge 1.20.1 cuando señala a un mod.
const WITH_SUSPECT = `---- Minecraft Crash Report ----
// Why did you do that?

Time: 2026-11-23 20:10:02
Description: Rendering entity in world

java.lang.NullPointerException: Cannot invoke "java.util.function.BiConsumer.accept(Object, Object)" because "h" is null
	at com.tom.cpm.api.ClientApi.handlePacket(ClientApi.java:409) ~[CustomPlayerModels-1.20-0.6.27a.jar%23332!/:0.6.27a] {re:classloading}
	at net.minecraft.client.Minecraft.m_91383_(Minecraft.java:1106) ~[client-1.20.1-20230612.114412-srg.jar%23426!/:?] {re:mixin}


A detailed walkthrough of the error, its code path and all known details is as follows:
---------------------------------------------------------------------------------------

-- Head --
Thread: Render thread
Suspected Mod: 
	Customizable Player Models (cpm), Version: 0.6.27a
		at TRANSFORMER/cpm@0.6.27a/com.tom.cpm.api.ClientApi.handlePacket(ClientApi.java:409)
Stacktrace:
	at com.tom.cpm.api.ClientApi.handlePacket(ClientApi.java:409) ~[CustomPlayerModels-1.20-0.6.27a.jar%23332!/:0.6.27a] {re:classloading}
`;

// Informe en el que Forge no señala a nadie: hay que tirar de la traza.
const WITHOUT_SUSPECT = `---- Minecraft Crash Report ----

Time: 2026-11-23 21:00:00
Description: Ticking entity

java.lang.IllegalStateException: boom
	at net.minecraft.world.entity.Entity.m_8119_(Entity.java:400) ~[client-1.20.1-20230612.114412-srg.jar%23426!/:?] {re:mixin}
	at com.simibubi.create.Thing.tick(Thing.java:12) ~[create-1.20.1-0.5.1.j.jar%23310!/:0.5.1.j] {re:classloading}
	at net.minecraftforge.common.ForgeHooks.onTick(ForgeHooks.java:1) ~[forge-1.20.1-47.4.10-universal.jar%23430!/:?] {re:classloading}
	at vazkii.botania.Other.tick(Other.java:3) ~[Botania-1.20.1-446-FORGE.jar%23301!/:1.20.1-446-FORGE] {re:classloading}

A detailed walkthrough of the error, its code path and all known details is as follows:
-- Head --
Thread: Server thread
Suspected Mods: NONE
Stacktrace:
	at somewhere.Else.x(Else.java:1) ~[otro-mod.jar%2399!/:1] {}
`;

test('saca la descripción, la excepción y el mod que señala Forge', () => {
  const parsed = parseCrashReport(WITH_SUSPECT);
  assert.equal(parsed.description, 'Rendering entity in world');
  assert.match(parsed.exception, /^java\.lang\.NullPointerException: Cannot invoke/);
  assert.deepEqual(parsed.suspects, ['Customizable Player Models 0.6.27a']);
});

test('si Forge no señala a ninguno, propone los .jar de mods de la traza', () => {
  const parsed = parseCrashReport(WITHOUT_SUSPECT);
  assert.equal(parsed.description, 'Ticking entity');
  assert.deepEqual(parsed.suspects, ['create-1.20.1-0.5.1.j.jar', 'Botania-1.20.1-446-FORGE.jar']);
});

test('un texto que no es un informe no rompe nada', () => {
  assert.deepEqual(parseCrashReport('nada útil'), { description: null, exception: null, suspects: [] });
});

test('solo cuenta el informe de esta partida y detecta la falta de memoria', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-crash-'));
  try {
    const reports = path.join(dir, 'crash-reports');
    fs.mkdirSync(reports);
    const old = path.join(reports, 'crash-2026-11-01_10.00.00-client.txt');
    fs.writeFileSync(old, WITHOUT_SUSPECT);
    const longAgo = new Date(Date.now() - 86_400_000);
    fs.utimesSync(old, longAgo, longAgo);

    // Cierre sin informe nuevo: no se le cuelga el de otro día.
    const none = analyzeCrash({ instanceDir: dir, since: Date.now() - 60_000, logLines: ['java.lang.OutOfMemoryError: Java heap space'] });
    assert.equal(none.hasReport, false);
    assert.equal(none.description, null);
    assert.equal(none.outOfMemory, true);

    fs.writeFileSync(path.join(reports, 'crash-2026-11-23_20.10.02-client.txt'), WITH_SUSPECT);
    const found = analyzeCrash({ instanceDir: dir, since: Date.now() - 60_000 });
    assert.equal(found.hasReport, true);
    assert.equal(found.description, 'Rendering entity in world');
    assert.equal(found.outOfMemory, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el zip de registros lleva los archivos útiles y ningún token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-logs-'));
  try {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3VhcmlvIn0.c2lnbmF0dXJlLWZpcm1h';
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.mkdirSync(path.join(dir, 'crash-reports'));
    fs.mkdirSync(path.join(dir, 'mods'));
    fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), `linea normal\n--accessToken ${token}\n`);
    fs.writeFileSync(path.join(dir, 'logs', 'debug.log'), 'debug');
    fs.writeFileSync(path.join(dir, 'crash-reports', 'crash-2026-11-23_20.10.02-client.txt'), WITH_SUSPECT);
    fs.writeFileSync(path.join(dir, 'mods', 'create.jar'), 'x');
    const dest = path.join(dir, 'registros.zip');

    const result = await writeLogsZip({
      dest,
      instanceDir: dir,
      consoleLines: ['salida del juego'],
      info: { Launcher: '1.1.0', Modpack: 'normal' },
    });
    assert.deepEqual(result.files, ['logs/latest.log', 'logs/debug.log', 'crash-reports/crash-2026-11-23_20.10.02-client.txt']);

    const list = execFileSync('unzip', ['-Z1', dest], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(list, [
      'consola-launcher.txt',
      'crash-reports/crash-2026-11-23_20.10.02-client.txt',
      'launcher.txt',
      'logs/debug.log',
      'logs/latest.log',
    ]);
    const latest = execFileSync('unzip', ['-p', dest, 'logs/latest.log'], { encoding: 'utf8' });
    assert.ok(latest.includes('linea normal'));
    assert.ok(!latest.includes(token));
    const summary = execFileSync('unzip', ['-p', dest, 'launcher.txt'], { encoding: 'utf8' });
    assert.match(summary, /Launcher: 1\.1\.0/);
    assert.match(summary, /create\.jar/);
    assert.equal(redact(`a ${token} b`), 'a [token oculto] b');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
