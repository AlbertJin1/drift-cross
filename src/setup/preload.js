const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('setup', {
  info: () => ipcRenderer.invoke('info'),
  browse: (cur) => ipcRenderer.invoke('browse', cur),
  install: (opts) => ipcRenderer.invoke('install', opts),
  uninstall: (opts) => ipcRenderer.invoke('uninstall', opts),
  launch: (p) => ipcRenderer.invoke('launch', p),
  win: (a) => ipcRenderer.send('win', a),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
});
