const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => {
  ipcRenderer.on(channel, (event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld('nova', {
  getState: () => ipcRenderer.invoke('get-state'),
  loginMicrosoft: () => ipcRenderer.invoke('login-microsoft'),
  loginOffline: (username) => ipcRenderer.invoke('login-offline', username),
  logout: () => ipcRenderer.invoke('logout'),
  getModpacks: () => ipcRenderer.invoke('get-modpacks'),
  selectModpack: (id) => ipcRenderer.invoke('select-modpack', id),
  serverStatus: () => ipcRenderer.invoke('server-status'),
  play: (id) => ipcRenderer.invoke('play', id),
  stopGame: (id) => ipcRenderer.invoke('stop-game', id),
  getCharacters: () => ipcRenderer.invoke('get-characters'),
  selectCharacter: (nick) => ipcRenderer.invoke('select-character', nick),
  saveCharacters: (list) => ipcRenderer.invoke('save-characters', list),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  pickJava: () => ipcRenderer.invoke('pick-java'),
  openFolder: (id) => ipcRenderer.invoke('open-folder', id),
  repair: (id) => ipcRenderer.invoke('repair', id),
  openWeb: () => ipcRenderer.invoke('open-web'),
  openDiscord: () => ipcRenderer.invoke('open-discord'),
  getMods: (id) => ipcRenderer.invoke('get-mods', id),
  setModEnabled: (modpackId, key, enabled) => ipcRenderer.invoke('set-mod-enabled', { modpackId, key, enabled }),
  addOwnMods: (id) => ipcRenderer.invoke('add-own-mods', id),
  removeOwnMod: (modpackId, filename) => ipcRenderer.invoke('remove-own-mod', { modpackId, filename }),
  searchMods: (modpackId, query, source) => ipcRenderer.invoke('search-mods', { modpackId, query, source }),
  installMod: (modpackId, projectId, title) => ipcRenderer.invoke('install-mod', { modpackId, projectId, title }),
  playSecond: (nick) => ipcRenderer.invoke('play-second', nick),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  exportLogs: (id) => ipcRenderer.invoke('export-logs', id),
  importSources: (id) => ipcRenderer.invoke('import-sources', id),
  importPick: (id) => ipcRenderer.invoke('import-pick', id),
  importRun: (modpackId, from, categories) => ipcRenderer.invoke('import-run', { modpackId, from, categories }),
  listScreenshots: (id) => ipcRenderer.invoke('list-screenshots', id),
  openScreenshot: (modpackId, name) => ipcRenderer.invoke('open-screenshot', { modpackId, name }),
  copyScreenshot: (modpackId, name) => ipcRenderer.invoke('copy-screenshot', { modpackId, name }),
  deleteScreenshot: (modpackId, name) => ipcRenderer.invoke('delete-screenshot', { modpackId, name }),
  openScreenshotsFolder: (id) => ipcRenderer.invoke('open-screenshots-folder', id),

  onPlayProgress: on('play-progress'),
  onGameLog: on('game-log'),
  onGameStarted: on('game-started'),
  onGameClosed: on('game-closed'),
  onUpdateReady: on('update-ready'),
});
