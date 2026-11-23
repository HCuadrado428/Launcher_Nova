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
  stopGame: () => ipcRenderer.invoke('stop-game'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  pickJava: () => ipcRenderer.invoke('pick-java'),
  openFolder: (id) => ipcRenderer.invoke('open-folder', id),
  repair: (id) => ipcRenderer.invoke('repair', id),
  openWeb: () => ipcRenderer.invoke('open-web'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  onPlayProgress: on('play-progress'),
  onGameLog: on('game-log'),
  onGameStarted: on('game-started'),
  onGameClosed: on('game-closed'),
  onUpdateReady: on('update-ready'),
});
