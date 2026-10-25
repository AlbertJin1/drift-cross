// Narrow, allow-listed IPC bridge between the browser chrome and main process.
const { contextBridge, ipcRenderer } = require('electron');

const RECEIVE_CHANNELS = ['state', 'focus-address', 'palette:open', 'open-bookmarks', 'open-adblock', 'open-settings'];
const MANAGE_CHANNELS = [
  'bookmark:update', 'bookmark:remove',
  'adblock:toggle', 'adblock:toggle-site', 'adblock:reset-count', 'settings:update'
];

contextBridge.exposeInMainWorld('drift', {
  platform: process.platform,
  cmd: (name, arg) => ipcRenderer.send('cmd', name, arg),
  on: (channel, fn) => {
    if (RECEIVE_CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
  manage: (channel, ...args) => {
    if (MANAGE_CHANNELS.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  query: (q) => ipcRenderer.invoke('palette:query', q),
  run: (act) => ipcRenderer.send('palette:run', act),
  windowAction: (action) => { if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('window:action', action); }
});
