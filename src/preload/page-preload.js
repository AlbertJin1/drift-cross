'use strict';
// Minimal isolated-world gesture signal for Drift's built-in popup blocker.
// The page cannot access ipcRenderer because contextIsolation remains enabled.
const { ipcRenderer, webFrame } = require('electron');
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

// Once a tab has been in the background for a while, hand back decoded images and other
// cached resources this page is not showing. They are re-decoded on demand if it returns.
let releaseTimer = 0;
document.addEventListener('visibilitychange', () => {
  clearTimeout(releaseTimer);
  if (document.visibilityState !== 'hidden') return;
  releaseTimer = setTimeout(() => { try { webFrame.clearCache(); } catch { /* frame is going away */ } }, 20000);
});
