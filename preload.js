// Bridge between the Drift UI pages (sidebar/toolbar/palette) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'focus-address', 'palette:open'];

contextBridge.exposeInMainWorld('drift', {
  platform: process.platform,
  cmd: (name, arg) => ipcRenderer.send('cmd', name, arg),
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
  query: (q) => ipcRenderer.invoke('palette:query', q),
  run: (act) => ipcRenderer.send('palette:run', act)
});
