'use strict';
// Minimal isolated-world gesture signal for Drift's built-in popup blocker.
// The page cannot access ipcRenderer because contextIsolation remains enabled.
const { ipcRenderer } = require('electron');
let lastSignalAt = 0;
const signal = (event) => {
  if (!event?.isTrusted) return;
  const now = Date.now();
  if (now - lastSignalAt < 100) return;
  lastSignalAt = now;
  ipcRenderer.send('page:trusted-input');
};
for (const type of ['pointerdown', 'touchstart', 'keydown']) {
  document.addEventListener(type, signal, { capture: true, passive: true });
}
