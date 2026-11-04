'use strict';
/* -----------------------------------------------------------------------------
   Drift menu: the three-dot dropdown.
   A purpose-built panel (not a plain context menu): quick-action tiles, a zoom
   strip, icon rows and side flyouts with live data (recent bookmarks, history,
   downloads, extensions, privacy controls). Fully keyboard operable, clamped to
   the window, and flyouts flip/stack automatically on narrow windows.
   ----------------------------------------------------------------------------- */

const DM = { open: false, lifted: false, data: null, sub: null, subTimer: 0, leaveTimer: 0, suppress: '' };
const dmEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dmIcon = (name) => (window.fa ? window.fa(name) : '');
const dmHost = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; } };
const dmLetter = (text) => dmEsc((text || '?').trim().charAt(0).toUpperCase() || '?');

const dmRoot = document.createElement('div');
dmRoot.id = 'drift-menu'; dmRoot.className = 'drift-menu hidden'; dmRoot.setAttribute('role', 'menu'); dmRoot.setAttribute('aria-label', 'Drift menu');
const dmFly = document.createElement('div');
dmFly.id = 'drift-submenu'; dmFly.className = 'drift-menu drift-flyout hidden'; dmFly.setAttribute('role', 'menu');
document.body.append(dmRoot, dmFly);

function dmPinBtn(pin) {
  const on = typeof isPinned === 'function' && isPinned(pin);
  return `<button type="button" class="dm-pin${on ? ' on' : ''}" data-pin-toggle="${dmEsc(pin)}" tabindex="-1" aria-pressed="${on}" aria-label="${on ? 'Unpin from' : 'Pin to'} toolbar" title="${on ? 'Unpin from toolbar' : 'Pin to toolbar'}">${typeof PIN_SVG !== 'undefined' ? PIN_SVG : ''}</button>`;
}
function dmRow({ icon, label, hint = '', kbd = '', sub = '', act = '', badge = '', disabled = false, danger = false, arg = '', pin = '' }) {
  const html = dmRowButton({ icon, label, hint, kbd, sub, act, badge, disabled, danger, arg, pin });
  return pin ? `<div class="dm-item" data-pin-id="${dmEsc(pin)}">${html}${dmPinBtn(pin)}</div>` : html;
}
function dmRowButton({ icon, label, hint = '', kbd = '', sub = '', act = '', badge = '', disabled = false, danger = false, arg = '', pin = '' }) {
  return `<button type="button" class="dm-row${danger ? ' danger' : ''}${pin ? ' has-pin' : ''}" role="menuitem" ${sub ? `data-sub="${sub}" aria-haspopup="menu"` : ''} data-act="${dmEsc(act)}" data-arg="${dmEsc(arg)}" ${disabled ? 'disabled' : ''}>
    <span class="dm-ico">${dmIcon(icon)}</span>
    <span class="dm-text"><span class="dm-label">${dmEsc(label)}</span>${hint ? `<small>${dmEsc(hint)}</small>` : ''}</span>
    ${badge ? `<span class="dm-badge">${dmEsc(badge)}</span>` : ''}
    ${kbd ? `<kbd>${dmEsc(kbd)}</kbd>` : ''}
    ${sub ? `<span class="dm-chev">${dmIcon('arrowRight')}</span>` : ''}
  </button>`;
}
const dmSep = () => '<div class="dm-sep" role="separator"></div>';
const dmHead = (text) => `<div class="dm-head">${dmEsc(text)}</div>`;

function renderDriftMenu() {
  const d = DM.data || {};
  const hasPage = !!state.url;
  const blocked = Number(state.blocked || 0);
  const zoom = d.zoom || 100;
  const canZoom = d.canZoom !== false && hasPage;
  dmRoot.innerHTML = `
    <div class="dm-brand">
      <img src="../shared/assets/drift-mark.svg" alt="" width="26" height="26">
      <div class="dm-brand-text"><span class="wm" role="img" aria-label="Drift">Dr<span class="wm-i" aria-hidden="true">ı</span>ft</span><small>${hasPage ? dmEsc(dmHost(state.url)) : 'Move at your own pace'}</small></div>
      <button type="button" class="dm-shield${state.adBlockEnabled ? '' : ' off'}" data-sub="privacy" aria-haspopup="menu" title="Privacy protection">
        ${dmIcon('shield')}<span>${blocked.toLocaleString()}</span>
      </button>
    </div>
    <div class="dm-tiles">
      <button type="button" class="dm-tile" data-act="new" role="menuitem">${dmIcon('newtab')}<span>New tab</span></button>
      <button type="button" class="dm-tile" data-act="reopen-tab" role="menuitem" ${d.closedTabs && !d.closedTabs.length ? 'disabled' : ''}>${dmIcon('restore')}<span>Reopen</span></button>
      <button type="button" class="dm-tile${state.bookmarked ? ' on' : ''}" data-act="bookmark" role="menuitem" ${hasPage ? '' : 'disabled'}>${dmIcon(state.bookmarked ? 'starFill' : 'star')}<span>${state.bookmarked ? 'Saved' : 'Save page'}</span></button>
      <button type="button" class="dm-tile" data-act="find" role="menuitem" ${hasPage ? '' : 'disabled'}>${dmIcon('search')}<span>Find</span></button>
    </div>
    <div class="dm-zoom" role="group" aria-label="Zoom">
      <span class="dm-zoom-label">Zoom</span>
      <div class="dm-zoom-ctl">
        <button type="button" class="dm-zbtn" data-act="zoom-out" aria-label="Zoom out" ${canZoom ? '' : 'disabled'}>${dmIcon('minus')}</button>
        <button type="button" class="dm-zval" data-act="zoom-reset" title="Reset zoom" ${canZoom ? '' : 'disabled'}>${zoom}%</button>
        <button type="button" class="dm-zbtn" data-act="zoom-in" aria-label="Zoom in" ${canZoom ? '' : 'disabled'}>${dmIcon('plus')}</button>
        <button type="button" class="dm-zbtn dm-full" data-act="fullscreen" aria-label="Full screen" title="Full screen (F11)">${dmIcon('square')}</button>
      </div>
    </div>
    ${dmSep()}
    ${dmRow({ icon: 'bookmark', label: 'Bookmarks', sub: 'bookmarks', kbd: 'Ctrl+Shift+B', pin: 'bookmarks' })}
    ${dmRow({ icon: 'history', label: 'History', sub: 'history', kbd: 'Ctrl+H', pin: 'history' })}
    ${dmRow({ icon: 'download', label: 'Downloads', sub: 'downloads', kbd: 'Ctrl+J', pin: 'downloads' })}
    ${dmRow({ icon: 'puzzle', label: 'Extensions', sub: 'extensions', kbd: 'Ctrl+Shift+E', pin: 'extensions' })}
    ${dmSep()}
    ${dmRow({ icon: 'shield', label: 'Privacy & protection', sub: 'privacy', badge: state.adBlockEnabled ? `${blocked.toLocaleString()} blocked` : 'Off', pin: 'privacy' })}
    ${dmRow({ icon: 'sliders', label: 'More tools', sub: 'tools' })}
    ${dmSep()}
    ${dmRow({ icon: 'gear', label: 'Settings', act: 'settings', kbd: 'Ctrl+,', pin: 'settings' })}
    ${dmRow({ icon: 'star', label: 'Rate Drift', hint: 'Write a review', act: 'review' })}
  `;
}

// ---- Flyouts --------------------------------------------------------------------
function flyBuild(kind) {
  const d = DM.data || {};
  const empty = (text) => `<div class="dm-empty">${dmEsc(text)}</div>`;
  const link = (item, icon) => `<button type="button" class="dm-row dm-link" role="menuitem" data-act="open-url" data-arg="${dmEsc(item.url)}" title="${dmEsc(item.url)}"><span class="dm-ico dm-fav">${icon || dmLetter(item.title)}</span><span class="dm-text"><span class="dm-label">${dmEsc(item.title)}</span><small>${dmEsc(dmHost(item.url))}</small></span></button>`;
  switch (kind) {
    case 'bookmarks':
      return [
        dmRow({ icon: state.bookmarked ? 'bookmarkFill' : 'bookmark', label: state.bookmarked ? 'Remove bookmark' : 'Bookmark this page', act: 'bookmark', kbd: 'Ctrl+D', disabled: !state.url }),
        dmRow({ icon: 'list', label: 'Manage bookmarks', act: 'bookmarks' }),
        dmSep(), dmHead('Recently saved'),
        (d.bookmarks || []).length ? d.bookmarks.map((b) => link(b)).join('') : empty('Nothing saved yet')
      ].join('');
    case 'history':
      return [
        dmRow({ icon: 'history', label: 'Show full history', act: 'history', kbd: 'Ctrl+H' }),
        dmRow({ icon: 'restore', label: 'Reopen closed tab', act: 'reopen-tab', kbd: 'Ctrl+Shift+T', disabled: !(d.closedTabs || []).length, pin: 'reopen-tab' }),
        dmRow({ icon: 'close', label: 'Clear browsing data…', act: 'clear-data', pin: 'clear-data' }),
        (d.closedTabs || []).length ? dmSep() + dmHead('Recently closed') + d.closedTabs.map((c) => link(c)).join('') : '',
        dmSep(), dmHead('Recently visited'),
        (d.history || []).length ? d.history.map((h) => link(h)).join('') : empty('No history yet')
      ].join('');
    case 'downloads':
      return [
        dmRow({ icon: 'download', label: 'Show all downloads', act: 'downloads', kbd: 'Ctrl+J' }),
        dmSep(), dmHead('Recent'),
        (d.downloads || []).length ? d.downloads.map((x) => {
          const pct = x.total > 0 ? Math.round((x.received / x.total) * 100) : 0;
          const status = x.state === 'progressing' ? `${pct}% · downloading` : x.state === 'completed' ? 'Open file' : x.state;
          return `<button type="button" class="dm-row dm-link" role="menuitem" data-act="download-open" data-arg="${dmEsc(x.id)}" ${x.state === 'completed' ? '' : 'disabled'}><span class="dm-ico">${dmIcon('file')}</span><span class="dm-text"><span class="dm-label">${dmEsc(x.filename)}</span><small>${dmEsc(status)}</small></span></button>`;
        }).join('') : empty('No downloads yet')
      ].join('');
    case 'extensions':
      return [
        dmRow({ icon: 'puzzle', label: 'Manage extensions', act: 'extensions', kbd: 'Ctrl+Shift+E' }),
        dmRow({ icon: 'external', label: 'Add from Chrome Web Store…', act: 'store-install' }),
        dmSep(), dmHead('Installed'),
        (d.extensions || []).length ? d.extensions.map((e) => `<button type="button" class="dm-row dm-link" role="menuitem" data-act="extensions"><span class="dm-ico dm-fav">${dmLetter(e.name)}</span><span class="dm-text"><span class="dm-label">${dmEsc(e.name)}</span><small>v${dmEsc(e.version || '—')}</small></span></button>`).join('') : empty('No extensions installed')
      ].join('');
    case 'privacy': {
      const on = !!state.adBlockEnabled; const host = state.currentHost || '';
      return [
        `<div class="dm-stat"><strong>${Number(state.blocked || 0).toLocaleString()}</strong><span>requests blocked this session</span></div>`,
        dmRow({ icon: 'shield', label: on ? 'Turn protection off' : 'Turn protection on', hint: on ? 'Ads and trackers are blocked' : 'Ads and trackers are allowed', act: 'adblock-toggle' }),
        dmRow({ icon: 'lock', label: state.siteAllowed ? 'Resume protection on this site' : 'Pause on this site', hint: host || 'Open a website first', act: 'adblock-site', disabled: !host || !on }),
        dmSep(),
        dmRow({ icon: 'info', label: 'Protection details…', act: 'adblock-settings' }),
        dmRow({ icon: 'close', label: 'Clear browsing data…', act: 'clear-data' })
      ].join('');
    }
    case 'tools':
      return [
        dmRow({ icon: 'search', label: 'Find in page', act: 'find', kbd: 'Ctrl+F', disabled: !state.url, pin: 'find' }),
        dmRow({ icon: 'book', label: 'Reader mode', act: 'reader', kbd: 'Ctrl+Shift+R', disabled: !state.url, pin: 'reader' }),
        dmRow({ icon: 'file', label: 'Print…', act: 'print', kbd: 'Ctrl+P', disabled: !state.url, pin: 'print' }),
        dmSep(),
        dmRow({ icon: 'square', label: 'Full screen', act: 'fullscreen', kbd: 'F11', pin: 'fullscreen' }),
        dmRow({ icon: 'terminal', label: 'Command palette', act: 'palette', kbd: 'Ctrl+K', pin: 'palette' }),
        dmRow({ icon: 'sliders', label: 'Developer tools', act: 'devtools', kbd: 'F12', disabled: !state.url, pin: 'devtools' }),
        dmSep(),
        dmRow({ icon: 'close', label: 'Close window', act: 'close-window', danger: true })
      ].join('');
  }
  return '';
}

function openFlyout(kind, anchor) {
  clearTimeout(DM.subTimer);
  if (DM.sub === kind && !dmFly.classList.contains('hidden')) return;
  DM.sub = kind;
  dmRoot.querySelectorAll('.dm-row.open, .dm-shield.open').forEach((el) => el.classList.remove('open'));
  anchor.classList.add('open');
  dmFly.innerHTML = `<div class="dm-fly-back"><button type="button" data-act="fly-back" aria-label="Back">${dmIcon('back')}</button><strong>${dmEsc(({ bookmarks: 'Bookmarks', history: 'History', downloads: 'Downloads', extensions: 'Extensions', privacy: 'Privacy & protection', tools: 'More tools' })[kind] || '')}</strong></div>` + flyBuild(kind);
  dmFly.classList.remove('hidden');
  positionFlyout(anchor);
}
function closeFlyout() {
  clearTimeout(DM.subTimer); clearTimeout(DM.leaveTimer);
  DM.sub = null;
  dmFly.classList.add('hidden'); dmFly.classList.remove('stacked'); dmFly.innerHTML = '';
  dmRoot.querySelectorAll('.open').forEach((el) => el.classList.remove('open'));
}
function positionFlyout(anchor) {
  const vw = window.innerWidth; const vh = window.innerHeight; const m = 8;
  const main = dmRoot.getBoundingClientRect();
  dmFly.style.maxHeight = `${Math.max(140, vh - m * 2)}px`;
  const w = dmFly.offsetWidth; const h = dmFly.offsetHeight;
  const rowTop = anchor.getBoundingClientRect().top;
  let top = Math.min(Math.max(m, rowTop - 6), Math.max(m, vh - h - m));
  let left;
  dmFly.classList.remove('stacked');
  if (main.left - w - 6 >= m) left = main.left - w - 6;          // room on the left (menu hugs the right edge)
  else if (main.right + 6 + w <= vw - m) left = main.right + 6;   // room on the right
  else { dmFly.classList.add('stacked'); left = Math.max(m, Math.min(main.left, vw - w - m)); top = Math.max(m, main.top); } // narrow window: stack over the menu with a back button
  dmFly.style.left = `${left}px`; dmFly.style.top = `${top}px`;
}

// ---- Open / close ----------------------------------------------------------------
async function refreshMenuData() {
  try { DM.data = await drift.invoke('menu:data'); } catch { DM.data = DM.data || {}; }
  if (DM.open) {
    const keepSub = DM.sub; const keepScroll = dmRoot.scrollTop;
    const anchor = keepSub && dmRoot.querySelector(`[data-sub="${keepSub}"]`);
    renderDriftMenu(); dmRoot.scrollTop = keepScroll;
    if (keepSub && anchor) { const a = dmRoot.querySelector(`[data-sub="${keepSub}"]`); DM.sub = null; if (a) openFlyout(keepSub, a); }
  }
}
function positionMenu() {
  const btn = $('toolbar-overflow').getBoundingClientRect();
  const vw = window.innerWidth; const vh = window.innerHeight; const m = 8;
  dmRoot.style.maxHeight = `${Math.max(160, vh - btn.bottom - 12)}px`;
  const w = dmRoot.offsetWidth;
  dmRoot.style.left = `${Math.max(m, Math.min(btn.right - w, vw - w - m))}px`;
  dmRoot.style.top = `${btn.bottom + 6}px`;
}
function openDriftMenu() {
  if (DM.open) return;
  if (typeof closeContextMenu === 'function') closeContextMenu();
  if (typeof closeTabList === 'function') closeTabList();
  DM.open = true;
  renderDriftMenu();
  dmRoot.classList.remove('hidden');
  positionMenu();
  $('toolbar-overflow').classList.add('menu-open');
  $('toolbar-overflow').setAttribute('aria-expanded', 'true');
  syncOverlay(true);
  refreshMenuData();
}
function closeDriftMenu() {
  if (!DM.open) return;
  DM.open = false;
  closeFlyout();
  dmRoot.classList.add('hidden'); dmRoot.innerHTML = '';
  $('toolbar-overflow').classList.remove('menu-open');
  $('toolbar-overflow').setAttribute('aria-expanded', 'false');
  syncOverlay();
}
function toggleDriftMenu() { DM.open ? closeDriftMenu() : openDriftMenu(); }

// ---- Actions ---------------------------------------------------------------------
const DM_KEEP_OPEN = new Set(['zoom-in', 'zoom-out', 'zoom-reset']);
function runMenuAction(act, arg) {
  if (!act) return;
  if (DM_KEEP_OPEN.has(act)) { drift.cmd(act); setTimeout(refreshMenuData, 90); return; }
  closeDriftMenu();
  switch (act) {
    case 'open-url': if (arg) drift.cmd('new', arg); break;
    case 'download-open': drift.manage('downloads:action', arg, 'open'); break;
    case 'adblock-toggle': drift.manage('adblock:toggle', !state.adBlockEnabled); break;
    case 'adblock-site': if (state.currentHost) drift.manage('adblock:toggle-site', state.currentHost); break;
    case 'review': if (typeof openReviewManually === 'function') openReviewManually(); break;
    case 'store-install': if (typeof openDialog === 'function') openDialog('storeInstallDialog'); break;
    default: drift.cmd(act);
  }
}

// Pin / unpin from the menu: the menu stays open so several tools can be pinned in one go.
function handlePinClick(event) {
  const pinBtn = event.target.closest('[data-pin-toggle]');
  if (!pinBtn) return false;
  event.preventDefault(); event.stopPropagation();
  togglePin(pinBtn.dataset.pinToggle);
  return true;
}
function refreshMenuPins() {
  const keep = DM.sub; const scroll = dmRoot.scrollTop; const flyScroll = dmFly.scrollTop;
  const focusedPin = document.activeElement?.closest?.('.dm-item')?.dataset.pinId || '';
  const inFly = dmFly.contains(document.activeElement);
  renderDriftMenu(); dmRoot.scrollTop = scroll;
  if (keep) { const a = dmRoot.querySelector(`[data-sub="${keep}"]`); DM.sub = null; if (a) { openFlyout(keep, a); dmFly.scrollTop = flyScroll; } }
  if (focusedPin) (inFly ? dmFly : dmRoot).querySelector(`.dm-item[data-pin-id="${focusedPin}"] .dm-row`)?.focus();
}
// Clicking a row (or the shield) toggles its flyout: first click opens, second click closes.
function toggleFlyout(kind, anchor) {
  if (DM.sub === kind && !dmFly.classList.contains('hidden')) { closeFlyout(); DM.suppress = kind; } // stay closed until the cursor leaves this row
  else openFlyout(kind, anchor);
}
dmRoot.addEventListener('click', (event) => {
  if (handlePinClick(event)) return;
  const sub = event.target.closest('[data-sub]');
  if (sub && !sub.disabled) { toggleFlyout(sub.dataset.sub, sub); return; }
  const btn = event.target.closest('[data-act]');
  if (btn && !btn.disabled) runMenuAction(btn.dataset.act, btn.dataset.arg);
});
dmFly.addEventListener('click', (event) => {
  if (handlePinClick(event)) return;
  const btn = event.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.act === 'fly-back') { closeFlyout(); return; }
  runMenuAction(btn.dataset.act, btn.dataset.arg);
});
// Hovering a submenu row opens its flyout (after a short pause); hovering a plain row closes it.
// Clicking an open row closes it, and it stays closed until the cursor leaves that row.
dmRoot.addEventListener('pointerover', (event) => {
  if (event.pointerType === 'touch') return;
  const row = event.target.closest('.dm-row, .dm-shield');
  clearTimeout(DM.subTimer);
  if (!row) return;
  const kind = row.dataset.sub || '';
  if (DM.suppress && DM.suppress !== kind) DM.suppress = '';
  if (kind) {
    if (kind === DM.sub || kind === DM.suppress || row.disabled) return;
    DM.subTimer = setTimeout(() => { if (DM.open && DM.suppress !== kind) openFlyout(kind, row); }, 120);
  } else if (DM.sub) DM.subTimer = setTimeout(() => { if (DM.open) closeFlyout(); }, 260);
});
// Close the flyout once the cursor is over neither the main menu nor the flyout.
// The short delay lets the cursor cross the small gap between the two panels.
function cancelFlyoutLeave() { clearTimeout(DM.leaveTimer); }
function scheduleFlyoutLeave(event) {
  clearTimeout(DM.subTimer);
  if (event.pointerType === 'touch' || !DM.sub) return;
  clearTimeout(DM.leaveTimer);
  DM.leaveTimer = setTimeout(() => { if (DM.open && DM.sub) closeFlyout(); }, 220);
}
for (const panel of [dmRoot, dmFly]) {
  panel.addEventListener('pointerenter', cancelFlyoutLeave);
  panel.addEventListener('pointerleave', scheduleFlyoutLeave);
}
dmFly.addEventListener('pointerover', () => clearTimeout(DM.subTimer));

document.addEventListener('pointerdown', (event) => {
  if (!DM.open) return;
  if (event.target.closest('#drift-menu, #drift-submenu, #toolbar-overflow')) return;
  closeDriftMenu();
}, true);
window.addEventListener('resize', () => { if (DM.open) { positionMenu(); if (DM.sub) { const a = dmRoot.querySelector(`[data-sub="${DM.sub}"]`); if (a) positionFlyout(a); } } });
// Keep the shield count and checkmarks live if state updates while the menu is open.
let dmLastSig = '';
setInterval(() => {
  if (!DM.open) return;
  const sig = `${state.blocked}|${state.adBlockEnabled}|${state.bookmarked}|${state.url}|${state.siteAllowed}|${(state.settings?.toolbarPins || []).join(',')}`;
  if (sig !== dmLastSig) { dmLastSig = sig; const keep = DM.sub; const scroll = dmRoot.scrollTop; renderDriftMenu(); dmRoot.scrollTop = scroll; if (keep) { const a = dmRoot.querySelector(`[data-sub="${keep}"]`); DM.sub = null; if (a) openFlyout(keep, a); } }
}, 700);

// ---- Keyboard --------------------------------------------------------------------
document.addEventListener('keydown', (event) => {
  if (!DM.open) return;
  const inFly = !dmFly.classList.contains('hidden') && dmFly.contains(document.activeElement);
  const scope = inFly ? dmFly : dmRoot;
  const items = [...scope.querySelectorAll('.dm-row:not(:disabled), .dm-tile:not(:disabled), .dm-zbtn:not(:disabled), .dm-zval:not(:disabled), .dm-shield')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (inFly) { const a = dmRoot.querySelector('.open'); closeFlyout(); a?.focus(); } else { closeDriftMenu(); $('toolbar-overflow').focus(); } }
  else if (event.key === 'ArrowDown') { event.preventDefault(); (items[index + 1] || items[0])?.focus(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); (items[index - 1] || items[items.length - 1])?.focus(); }
  else if (event.key === 'ArrowRight' && document.activeElement?.dataset?.sub) { event.preventDefault(); const el = document.activeElement; openFlyout(el.dataset.sub, el); setTimeout(() => dmFly.querySelector('.dm-row:not(:disabled)')?.focus(), 0); }
  else if (event.key === 'ArrowLeft' && inFly) { event.preventDefault(); const a = dmRoot.querySelector('.open'); closeFlyout(); a?.focus(); }
  else if ((event.key === 'p' || event.key === 'P') && !event.ctrlKey && !event.metaKey && !event.altKey && document.activeElement?.closest?.('.dm-item')) { event.preventDefault(); togglePin(document.activeElement.closest('.dm-item').dataset.pinId); }
  else if (event.key === 'Tab') { event.preventDefault(); (event.shiftKey ? items[index - 1] || items[items.length - 1] : items[index + 1] || items[0])?.focus(); }
}, true);
