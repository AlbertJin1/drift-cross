'use strict';
/* -----------------------------------------------------------------------------
   Drift pinned tools.
   Any item from the three-dot menu can be pinned next to the address bar.
   - Pin / unpin from the menu (pin icon on each row) or Settings > Appearance.
   - Drag pinned buttons to reorder them, right in the toolbar or in Settings.
     Keyboard: focus a pinned item and press Alt+Left / Alt+Right (Alt+Up / Alt+Down
     in the Settings list).
   - The list is saved in settings.json by the main process (settings:update) and
     comes back with every state push, so it survives restarts.
   ----------------------------------------------------------------------------- */

const PIN_DEFS = {
  bookmarks: { label: 'Bookmarks', icon: 'bookmark', run: () => drift.cmd('bookmarks') },
  history: { label: 'History', icon: 'history', run: () => drift.cmd('history') },
  downloads: { label: 'Downloads', icon: 'download', run: () => drift.cmd('downloads') },
  extensions: { label: 'Extensions', icon: 'puzzle', run: () => drift.cmd('extensions') },
  privacy: { label: 'Privacy & protection', icon: 'shield', badge: true, run: () => openDialog('adblockDialog') },
  find: { label: 'Find in page', icon: 'search', needsPage: true, run: () => drift.cmd('find') },
  reader: { label: 'Reader mode', icon: 'book', needsPage: true, run: () => drift.cmd('reader') },
  palette: { label: 'Command palette', icon: 'terminal', run: () => drift.cmd('palette') },
  print: { label: 'Print', icon: 'file', needsPage: true, run: () => drift.cmd('print') },
  devtools: { label: 'Developer tools', icon: 'sliders', needsPage: true, run: () => drift.cmd('devtools') },
  'reopen-tab': { label: 'Reopen closed tab', icon: 'restore', run: () => drift.cmd('reopen-tab') },
  'clear-data': { label: 'Clear browsing data', icon: 'close', run: () => drift.cmd('clear-data') },
  fullscreen: { label: 'Full screen', icon: 'square', run: () => drift.cmd('fullscreen') },
  settings: { label: 'Settings', icon: 'gear', run: () => drift.cmd('settings') }
};
const PIN_IDS = Object.keys(PIN_DEFS);
const PIN_GRIP = window.fa('grip', 'pin-grip-svg');
const PIN_SVG = window.fa('pin', 'pin-svg');

const pinBox = document.createElement('div');
pinBox.id = 'toolbar-pins';
pinBox.className = 'toolbar-pins hidden';
pinBox.setAttribute('role', 'toolbar');
pinBox.setAttribute('aria-label', 'Pinned tools');
$('toolbar').insertBefore(pinBox, $('toolbar-overflow'));

let pinDragId = null;
let pinJustDragged = false;
let pinSig = '';

function getPins() {
  const saved = state?.settings?.toolbarPins;
  return Array.isArray(saved) ? [...new Set(saved.filter((id) => PIN_DEFS[id]))] : [];
}
function isPinned(id) { return getPins().includes(id); }

// Optimistic update + save. The main process validates, writes settings.json and
// pushes the confirmed list back, so the UI and the file can never disagree for long.
function setPins(next) {
  const clean = [...new Set(next.filter((id) => PIN_DEFS[id]))];
  state.settings = { ...(state.settings || {}), toolbarPins: clean };
  saveSetting({ toolbarPins: clean });
  renderPins();
  if (typeof DM !== 'undefined' && DM.open && typeof refreshMenuPins === 'function') refreshMenuPins();
  renderPinSettings();
}
function togglePin(id) {
  if (!PIN_DEFS[id]) return;
  const pins = getPins();
  setPins(pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id]);
}
// Move `id` before/after `targetId` (or to the end when targetId is null).
function movePin(id, targetId, after) {
  const pins = getPins().filter((x) => x !== id);
  if (!getPins().includes(id)) return;
  let index = targetId ? pins.indexOf(targetId) : pins.length;
  if (index < 0) index = pins.length;
  if (targetId && after) index += 1;
  pins.splice(index, 0, id);
  setPins(pins);
}
function nudgePin(id, delta) {
  const pins = getPins(); const from = pins.indexOf(id); const to = from + delta;
  if (from < 0 || to < 0 || to >= pins.length) return false;
  pins.splice(to, 0, pins.splice(from, 1)[0]);
  setPins(pins);
  return true;
}

// ---- Toolbar buttons -----------------------------------------------------------
function pinDisabled(def) { return !!def.needsPage && !state.url; }
function pinButtonHtml(id) {
  const def = PIN_DEFS[id];
  const count = def.badge ? `<span class="pin-count">${Number(state.blocked || 0).toLocaleString()}</span>` : '';
  return `<button type="button" class="icon pin-btn${def.badge ? ' pin-chip' : ''}" data-pin="${id}" draggable="true" title="${def.label} (drag to reorder)" aria-label="${def.label}" ${pinDisabled(def) ? 'disabled' : ''}>${window.fa(def.icon)}${count}</button>`;
}
function renderPins() {
  const pins = getPins();
  const dyn = pins.map((id) => `${id}:${pinDisabled(PIN_DEFS[id]) ? 0 : 1}:${PIN_DEFS[id].badge ? state.blocked || 0 : ''}:${PIN_DEFS[id].badge ? (state.adBlockEnabled ? 1 : 0) : ''}`).join('|');
  const sig = pins.join(',') + '#' + dyn;
  if (sig === pinSig || pinDragId) return;
  pinSig = sig;
  const focused = document.activeElement?.dataset?.pin;
  pinBox.innerHTML = pins.map(pinButtonHtml).join('');
  pinBox.classList.toggle('hidden', !pins.length);
  pinBox.querySelectorAll('[data-pin="privacy"]').forEach((el) => el.classList.toggle('off', state.adBlockEnabled === false));
  if (focused) pinBox.querySelector(`[data-pin="${focused}"]`)?.focus();
}

pinBox.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-pin]');
  if (!btn || btn.disabled || pinJustDragged) return;
  PIN_DEFS[btn.dataset.pin]?.run();
});
pinBox.addEventListener('keydown', (event) => {
  const btn = event.target.closest('[data-pin]');
  if (!btn || !event.altKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    if (nudgePin(btn.dataset.pin, event.key === 'ArrowLeft' ? -1 : 1)) pinBox.querySelector(`[data-pin="${btn.dataset.pin}"]`)?.focus();
  }
});
pinBox.addEventListener('dragstart', (event) => {
  const btn = event.target.closest('[data-pin]');
  if (!btn) return;
  pinDragId = btn.dataset.pin;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', pinDragId);
  requestAnimationFrame(() => btn.classList.add('dragging'));
});
pinBox.addEventListener('dragover', (event) => {
  if (!pinDragId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const over = event.target.closest('[data-pin]');
  pinBox.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  if (!over || over.dataset.pin === pinDragId) return;
  const rect = over.getBoundingClientRect();
  over.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
});
pinBox.addEventListener('drop', (event) => {
  if (!pinDragId) return;
  event.preventDefault();
  const over = event.target.closest('[data-pin]');
  const id = pinDragId;
  pinDragId = null;
  if (over && over.dataset.pin !== id) {
    const rect = over.getBoundingClientRect();
    movePin(id, over.dataset.pin, event.clientX >= rect.left + rect.width / 2);
  } else if (!over) movePin(id, null, false);
});
pinBox.addEventListener('dragend', () => {
  pinDragId = null;
  pinJustDragged = true; setTimeout(() => { pinJustDragged = false; }, 120);
  pinBox.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  pinSig = ''; renderPins();
});

// ---- Settings > Appearance > Toolbar list ---------------------------------------
function pinSettingsMarkup() {
  const pins = getPins();
  const rest = PIN_IDS.filter((id) => !pins.includes(id));
  const row = (id, pinned) => {
    const def = PIN_DEFS[id];
    return `<li class="pin-row${pinned ? ' is-pinned' : ''}" data-pin-row="${id}" ${pinned ? 'draggable="true" tabindex="0"' : ''}>
      ${pinned ? `<span class="pin-grip" title="Drag to reorder">${PIN_GRIP}</span>` : '<span class="pin-grip spacer"></span>'}
      <span class="pin-row-ico">${window.fa(def.icon)}</span>
      <span class="pin-row-name">${def.label}</span>
      <button type="button" class="pin-toggle${pinned ? ' on' : ''}" data-pin-toggle="${id}" role="switch" aria-checked="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${def.label}" title="${pinned ? 'Unpin from toolbar' : 'Pin to toolbar'}">${PIN_SVG}<span>${pinned ? 'Pinned' : 'Pin'}</span></button>
    </li>`;
  };
  return `<div class="pin-settings">
    <p class="pin-help">Pinned tools appear next to the address bar. Drag the handle (or press <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>) to change their order. You can also pin from the <strong>⋯</strong> menu.</p>
    <div class="pin-group-title">Pinned${pins.length ? ` · ${pins.length}` : ''}</div>
    ${pins.length ? `<ul class="pin-list" id="pin-list-pinned">${pins.map((id) => row(id, true)).join('')}</ul>` : '<div class="pin-empty">Nothing pinned yet. Pin a tool below to show it in the toolbar.</div>'}
    ${rest.length ? `<div class="pin-group-title">Available</div><ul class="pin-list">${rest.map((id) => row(id, false)).join('')}</ul>` : ''}
    ${pins.length ? '<button type="button" class="small-action pin-reset" data-pin-clear>Unpin all</button>' : ''}
  </div>`;
}
function renderPinSettings(focusId) {
  if (state.internalPage !== 'settings' || typeof currentSettingsSection === 'undefined' || currentSettingsSection !== 'appearance') return;
  const scroller = $('page-main'); const top = scroller.scrollTop;
  renderSettingsContent();
  scroller.scrollTop = top;
  if (typeof currentPageRenderKey === 'function') lastPageRenderKey = currentPageRenderKey();
  if (focusId) $('page-main').querySelector(`[data-pin-row="${focusId}"]`)?.focus();
}

let pinRowDrag = null;
const pageMain = $('page-main');
pageMain.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-pin-toggle]');
  if (toggle) { togglePin(toggle.dataset.pinToggle); return; }
  if (event.target.closest('[data-pin-clear]')) setPins([]);
});
pageMain.addEventListener('keydown', (event) => {
  const row = event.target.closest('.pin-row.is-pinned');
  if (!row || event.target !== row) return;
  const id = row.dataset.pinRow;
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    if (nudgePin(id, event.key === 'ArrowUp' ? -1 : 1)) renderPinSettings(id);
  } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); togglePin(id); }
});
pageMain.addEventListener('dragstart', (event) => {
  const row = event.target.closest?.('.pin-row.is-pinned');
  if (!row) return;
  pinRowDrag = row.dataset.pinRow;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', pinRowDrag);
  requestAnimationFrame(() => row.classList.add('dragging'));
});
pageMain.addEventListener('dragover', (event) => {
  if (!pinRowDrag) return;
  const list = event.target.closest('#pin-list-pinned');
  if (!list) return;
  event.preventDefault();
  list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  const over = event.target.closest('.pin-row.is-pinned');
  if (!over || over.dataset.pinRow === pinRowDrag) return;
  const rect = over.getBoundingClientRect();
  over.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
});
pageMain.addEventListener('drop', (event) => {
  if (!pinRowDrag) return;
  const list = event.target.closest('#pin-list-pinned');
  if (!list) return;
  event.preventDefault();
  const id = pinRowDrag; pinRowDrag = null;
  const over = event.target.closest('.pin-row.is-pinned');
  if (over && over.dataset.pinRow !== id) {
    const rect = over.getBoundingClientRect();
    movePin(id, over.dataset.pinRow, event.clientY >= rect.top + rect.height / 2);
  } else if (!over) movePin(id, null, false);
});
pageMain.addEventListener('dragend', () => {
  if (!pinRowDrag) return;
  pinRowDrag = null;
  pageMain.querySelectorAll('.pin-row.dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
});

// Keep the pinned buttons in step with every state push (saved list, block count, page).
drift.on('state', () => renderPins());
renderPins();
