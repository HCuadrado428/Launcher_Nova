const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const modrinth = require('../main/modrinth');
const { forgeJar } = require('../../server/testlib/zip');

// Un Modrinth de mentira en local, con las mismas rutas y forma de respuesta
// que la API real (v2), para probar búsqueda, dependencias y descarga.

const sha1 = (content) => crypto.createHash('sha1').update(content).digest('hex');
const FILES = {
  'minimapa-2.0.jar': 'minimapa v2',
  'minimapa-2.1-beta.jar': 'minimapa beta',
  'libmapas-1.0.jar': 'librería de mapas',
  'jei-15.jar': 'jei',
  'roto.jar': 'contenido que no coincide',
  // En Modrinth se llama «xaeros-minimap», pero su modId de Forge es «xaerominimap».
  'Xaeros_Minimap_23.jar': forgeJar('xaerominimap'),
};
const PROJECTS = {
  mini: { slug: 'mini-mapa', title: 'Mini Mapa' },
  lib: { slug: 'libmapas', title: 'Lib Mapas' },
  jei: { slug: 'jei', title: 'Just Enough Items' },
  viejo: { slug: 'solo-fabric', title: 'Solo Fabric' },
  roto: { slug: 'roto', title: 'Mod Roto' },
  fuera: { slug: 'fuera', title: 'Mod De Fuera' },
  xaero: { slug: 'xaeros-minimap', title: "Xaero's Minimap" },
};
let server;
let base;
let tmp;
const requests = [];
let rejectSideFacets = false;

function versionsOf(id) {
  const file = (filename, hash) => ({ filename, primary: true, size: 10, url: `${base}/cdn/${filename}`, hashes: { sha1: hash || sha1(FILES[filename]) } });
  if (id === 'mini') {
    return [
      { version_type: 'beta', files: [file('minimapa-2.1-beta.jar')], dependencies: [] },
      {
        version_type: 'release',
        files: [file('minimapa-2.0.jar')],
        dependencies: [
          { project_id: 'lib', dependency_type: 'required' },
          { project_id: 'jei', dependency_type: 'required' },
          { project_id: 'viejo', dependency_type: 'optional' },
        ],
      },
    ];
  }
  if (id === 'lib') return [{ version_type: 'release', files: [file('libmapas-1.0.jar')], dependencies: [] }];
  if (id === 'jei') return [{ version_type: 'release', files: [file('jei-15.jar')], dependencies: [] }];
  if (id === 'xaero') return [{ version_type: 'release', files: [file('Xaeros_Minimap_23.jar')], dependencies: [] }];
  if (id === 'roto') return [{ version_type: 'release', files: [file('roto.jar', 'f'.repeat(40))], dependencies: [] }];
  if (id === 'fuera') {
    return [{ version_type: 'release', files: [{ filename: 'fuera.jar', primary: true, url: 'https://ejemplo.invalid/fuera.jar', hashes: { sha1: 'a'.repeat(40) } }], dependencies: [] }];
  }
  return [];
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-modrinth-'));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, params: url.searchParams, ua: req.headers['user-agent'] });
    const json = (body, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/v2/search') {
      const facets = JSON.parse(url.searchParams.get('facets'));
      if (rejectSideFacets && facets.length > 3) return json({ error: 'invalid facet' }, 400);
      return json({
        hits: [
          { project_id: 'mini', slug: 'mini-mapa', title: 'Mini Mapa', description: 'Un mapa', icon_url: 'https://cdn.modrinth.com/data/mini/icon.png', downloads: 5000, client_side: 'required', server_side: 'unsupported' },
          { project_id: 'jei', slug: 'jei', title: 'Just Enough Items', description: 'Recetas', icon_url: 'http://otro.example/icono.png', downloads: 900, client_side: 'required', server_side: 'optional' },
          { project_id: 'create', slug: 'create', title: 'Create', description: 'Máquinas', downloads: 99999, client_side: 'required', server_side: 'required' },
          { project_id: 'admin', slug: 'admin-tools', title: 'Admin Tools', description: 'Solo servidor', downloads: 10, client_side: 'unsupported', server_side: 'required' },
        ],
      });
    }
    const version = /^\/v2\/project\/(\w+)\/version$/.exec(url.pathname);
    if (version) return json(versionsOf(version[1]));
    const project = /^\/v2\/project\/(\w+)$/.exec(url.pathname);
    if (project && PROJECTS[project[1]]) return json(PROJECTS[project[1]]);
    const file = /^\/cdn\/(.+)$/.exec(url.pathname);
    if (file && FILES[file[1]] !== undefined) return res.end(FILES[file[1]]);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const common = () => ({ mcVersion: '1.20.1', loader: 'forge', apiUrl: `${base}/v2` });

test('la búsqueda pide mods de Forge para esa versión y solo enseña los de cliente', async () => {
  modrinth.setUserAgent('9.9.9');
  requests.length = 0;
  const results = await modrinth.searchMods({ ...common(), query: 'mapa' });
  assert.deepEqual(
    results.map((r) => r.id),
    ['mini', 'jei'],
    'los que el servidor necesita o no van en cliente quedan fuera',
  );
  assert.equal(results[0].iconUrl, 'https://cdn.modrinth.com/data/mini/icon.png');
  assert.equal(results[1].iconUrl, '', 'no se cargan iconos de otros sitios');

  const { params, ua } = requests[0];
  const facets = JSON.parse(params.get('facets'));
  assert.deepEqual(facets.slice(0, 3), [['project_type:mod'], ['categories:forge'], ['versions:1.20.1']]);
  assert.equal(params.get('query'), 'mapa');
  assert.equal(params.get('index'), 'relevance');
  assert.equal(ua, 'HCuadrado428/Launcher_Nova/9.9.9');

  requests.length = 0;
  await modrinth.searchMods({ ...common(), query: '' });
  assert.equal(requests[0].params.get('index'), 'downloads', 'sin texto: los más descargados');
});

test('si el buscador rechaza el filtro por lado, se busca sin él y se filtra aquí', async () => {
  rejectSideFacets = true;
  try {
    const results = await modrinth.searchMods({ ...common(), query: 'mapa' });
    assert.deepEqual(
      results.map((r) => r.id),
      ['mini', 'jei'],
    );
  } finally {
    rejectSideFacets = false;
  }
});

test('instala la versión estable con lo que necesita, sin repetir lo del modpack', async () => {
  const instanceDir = path.join(tmp, 'inst');
  // El modpack ya trae JEI (con otro nombre de archivo): no hay que duplicarlo.
  const manifestMods = [{ filename: 'jei-1.20.1-forge-15.20.0.jar', sha1: 'b'.repeat(40), modId: 'jei' }];

  const installed = await modrinth.installMod({ ...common(), projectId: 'mini', manifestMods, instanceDir, downloadOrigins: [base] });
  assert.deepEqual(installed, [
    { title: 'Mini Mapa', filename: 'minimapa-2.0.jar' },
    { title: 'Lib Mapas', filename: 'libmapas-1.0.jar' },
  ]);
  const modsDir = path.join(instanceDir, 'mods');
  assert.deepEqual(fs.readdirSync(modsDir).sort(), ['libmapas-1.0.jar', 'minimapa-2.0.jar']);
  assert.equal(fs.readFileSync(path.join(modsDir, 'minimapa-2.0.jar'), 'utf8'), 'minimapa v2');
  assert.deepEqual(modrinth.installedProjects(instanceDir), { mini: 'minimapa-2.0.jar', lib: 'libmapas-1.0.jar' });
  assert.equal(modrinth.loadRegistry(instanceDir)['minimapa-2.0.jar'].title, 'Mini Mapa');

  // Un mod que ya viene en el modpack no se puede instalar encima.
  await assert.rejects(modrinth.installMod({ ...common(), projectId: 'jei', manifestMods, instanceDir, downloadOrigins: [base] }), /ya viene en el modpack/);
  // Ni uno sin versión para este Minecraft.
  await assert.rejects(modrinth.installMod({ ...common(), projectId: 'viejo', manifestMods, instanceDir, downloadOrigins: [base] }), /no tiene versión/);
  assert.deepEqual(fs.readdirSync(modsDir).sort(), ['libmapas-1.0.jar', 'minimapa-2.0.jar']);
});

test('una versión nueva sustituye a la anterior del mismo mod', async () => {
  const instanceDir = path.join(tmp, 'inst-update');
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'minimapa-1.0.jar'), 'vieja');
  fs.writeFileSync(path.join(instanceDir, '.nova-own.json'), JSON.stringify({ 'minimapa-1.0.jar': { projectId: 'mini', title: 'Mini Mapa' } }));
  await modrinth.installMod({ ...common(), projectId: 'mini', manifestMods: [{ filename: 'libmapas-1.0.jar', sha1: 'c'.repeat(40), modId: null }], instanceDir, downloadOrigins: [base] });
  // Se quita la versión vieja; la librería ya la trae el modpack y JEI no, así que JEI sí se baja.
  assert.deepEqual(fs.readdirSync(modsDir).sort(), ['jei-15.jar', 'minimapa-2.0.jar']);
});

test('no se queda nada si el archivo llega dañado o viene de otro sitio', async () => {
  const instanceDir = path.join(tmp, 'inst-malo');
  await assert.rejects(modrinth.installMod({ ...common(), projectId: 'roto', manifestMods: [], instanceDir, downloadOrigins: [base] }), /dañado/);
  // Aunque el buscador devolviera una descarga de otro servidor, no se baja.
  await assert.rejects(modrinth.installMod({ ...common(), projectId: 'fuera', manifestMods: [], instanceDir, downloadOrigins: [base] }), /no es válido/);
  assert.deepEqual(fs.readdirSync(path.join(instanceDir, 'mods')), []);
  assert.deepEqual(modrinth.installedProjects(instanceDir), {});
});

test('por defecto solo se descarga del servidor de archivos de Modrinth', async () => {
  // Sin indicar orígenes, la descarga del Modrinth de mentira (127.0.0.1) se rechaza.
  await assert.rejects(modrinth.installMod({ ...common(), projectId: 'lib', manifestMods: [], instanceDir: path.join(tmp, 'inst-origen') }), /no es válido/);
});

test('si el mod ya viene en el modpack con otro nombre, se detecta al abrir el .jar', async () => {
  const instanceDir = path.join(tmp, 'inst-duplicado');
  // Ni el nombre de Modrinth, ni el del archivo, ni el contenido coinciden con
  // lo del modpack: solo el identificador que lleva dentro el .jar.
  const manifestMods = [{ filename: 'Xaeros_Minimap_22_Forge.jar', sha1: 'd'.repeat(40), modId: 'xaerominimap' }];
  await assert.rejects(
    modrinth.installMod({ ...common(), projectId: 'xaero', manifestMods, instanceDir, downloadOrigins: [base] }),
    /ya viene en el modpack/,
  );
  assert.deepEqual(fs.readdirSync(path.join(instanceDir, 'mods')), []);

  // Sin ese mod en el modpack, se instala con normalidad.
  const installed = await modrinth.installMod({ ...common(), projectId: 'xaero', manifestMods: [], instanceDir, downloadOrigins: [base] });
  assert.deepEqual(installed, [{ title: "Xaero's Minimap", filename: 'Xaeros_Minimap_23.jar' }]);
});
