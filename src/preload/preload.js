// Narrow, allow-listed IPC bridge between the browser chrome and main process.
const { contextBridge, ipcRenderer } = require('electron');

const RECEIVE_CHANNELS = ['state', 'focus-address', 'palette:open', 'find:show', 'extension:confirm', 'reset-address', 'clear-data:show', 'tabs:search'];
const MANAGE_CHANNELS = [
  'bookmark:update', 'bookmark:remove', 'bookmark:add',
  'history:remove', 'history:clear',
  'adblock:toggle', 'adblock:toggle-site', 'adblock:reset-count', 'settings:update',
  'downloads:action', 'find:query', 'find:next', 'find:close', 'extension:confirm-response'
];
const INVOKE_CHANNELS = ['downloads:choose-folder', 'downloads:clear', 'extensions:install', 'extensions:install-store', 'extensions:remove', 'data:clear', 'menu:data', 'tabs:preview'];

contextBridge.exposeInMainWorld('drift', {
  platform: process.platform,
  cmd: (name, arg) => ipcRenderer.send('cmd', name, arg),
  on: (channel, fn) => {
    if (RECEIVE_CHANNELS.includes(channel) && typeof fn === 'function') {
      ipcRenderer.on(channel, (_e, ...args) => fn(...args));
    }
  },
  manage: (channel, ...args) => {
    if (MANAGE_CHANNELS.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.includes(channel)) return Promise.reject(new Error('Unsupported browser action.'));
    return ipcRenderer.invoke(channel, ...args);
  },
  query: (q) => ipcRenderer.invoke('palette:query', q),
  run: (act) => ipcRenderer.send('palette:run', act),
  windowAction: (action) => { if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('window:action', action); }
});
