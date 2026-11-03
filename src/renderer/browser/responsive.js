'use strict';
/* -----------------------------------------------------------------------------
   Drift responsive layer.

   Everything here reacts to the *actual* space available (ResizeObserver), not
   to a handful of fixed breakpoints:

   1. Window size tiers      -> <html data-w="xs|sm|md|lg|xl" data-h="short|tall">
   2. Toolbar priority       -> least-important buttons move into a "More" menu
                                until the address bar keeps a usable width.
   3. Bookmarks bar overflow -> bookmarks that don't fit move into a "»" menu.
   4. Menus / dialogs        -> always clamped to the window and scrollable.
   ----------------------------------------------------------------------------- */

let respFrame = 0;
const respRoot = document.documentElement;

// ---- 1. Window tiers ---------------------------------------------------------
function widthTier(w) { return w < 520 ? 'xs' : w < 760 ? 'sm' : w < 1000 ? 'md' : w < 1360 ? 'lg' : 'xl'; }
function applyTiers() {
  const w = respRoot.clientWidth || window.innerWidth;
  const h = respRoot.clientHeight || window.innerHeight;
  const tier = widthTier(w);
  if (respRoot.dataset.w !== tier) respRoot.dataset.w = tier;
  const hTier = h < 520 ? 'short' : 'tall';
  if (respRoot.dataset.h !== hTier) respRoot.dataset.h = hTier;
  respRoot.style.setProperty('--vw', `${w}px`);
  respRoot.style.setProperty('--vh', `${h}px`);
  return tier;
}

// ---- 2. Toolbar menu -----------------------------------------------------------
// Utility buttons live in one three-dot dropdown instead of the toolbar row.
const tbOverflow = $('toolbar-overflow');
function tbEl(id) { return $(id); }
function layoutToolbar() { applyTiers(); }
tbOverflow.setAttribute('aria-expanded', 'false');
tbOverflow.addEventListener('click', (event) => {
  event.preventDefault(); event.stopPropagation();
  toggleDriftMenu(); // defined in menu.js
});

// ---- 3. Bookmarks bar overflow ------------------------------------------------
const bmOverflow = $('bookmarks-overflow');
function layoutBookmarksBar() {
  const box = $('bookmark-items');
  if (!box || document.body.classList.contains('hide-bookmarks')) return;
  const links = Array.from(box.querySelectorAll('.bookmark-link'));
  links.forEach((link) => link.classList.remove('bm-hidden'));
  bmOverflow.classList.add('hidden');
  bmOverflow._items = [];
  if (!links.length) return;
  const fits = () => box.scrollWidth <= box.clientWidth + 1;
  if (fits()) return;
  bmOverflow.classList.remove('hidden'); // reserve room for the » button first
  for (let i = links.length - 1; i >= 0 && !fits(); i--) {
    links[i].classList.add('bm-hidden');
    bmOverflow._items.unshift(links[i]);
  }
  // Even one bookmark doesn't fit: let it shrink instead of vanishing.
  if (bmOverflow._items.length === links.length) {
    links[0].classList.remove('bm-hidden'); bmOverflow._items.shift();
  }
}
bmOverflow.addEventListener('click', (event) => {
  event.preventDefault(); event.stopPropagation();
  const hidden = bmOverflow._items || [];
  if (!hidden.length) return;
  const items = hidden.map((link) => {
    const label = (link.querySelector('.bookmark-label')?.textContent || link.dataset.url || 'Bookmark').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return contextItem(label, `bm:${link.dataset.url || ''}`);
  });
  const rect = bmOverflow.getBoundingClientRect();
  showContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: rect.right, clientY: rect.bottom + 4, anchorRight: true }, items, { type: 'bookmark-overflow' });
});

// ---- 4. Menu actions for the two overflow menus -------------------------------
contextMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-context-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.contextAction || '';
  if (action.startsWith('tb:')) { const el = tbEl(action.slice(3)); closeContextMenu(); el?.click(); event.stopImmediatePropagation(); }
  else if (action.startsWith('bm:')) { const url = action.slice(3); closeContextMenu(); if (url) drift.cmd('go', url); event.stopImmediatePropagation(); }
}, true);

// ---- Scheduling ---------------------------------------------------------------
const respMutationObservers = [];
function watchMutations(node, options) {
  if (!node) return;
  const observer = new MutationObserver(scheduleResponsive);
  observer.observe(node, options);
  respMutationObservers.push(observer);
}
function scheduleResponsive() {
  if (respFrame) return;
  respFrame = requestAnimationFrame(() => {
    respFrame = 0;
    layoutToolbar();
    layoutBookmarksBar();
    scheduleTabLayout();
    // Our own class toggles must not re-trigger a layout pass (would loop forever).
    for (const observer of respMutationObservers) observer.takeRecords();
  });
}
new ResizeObserver(scheduleResponsive).observe(respRoot);
new ResizeObserver(scheduleResponsive).observe($('toolbar'));
new ResizeObserver(scheduleResponsive).observe($('bookmarksbar'));
window.addEventListener('resize', scheduleResponsive);
// Re-measure on anything that changes content width: DPI/zoom, fonts, state pushes, settings.
(function watchDpr() {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener('change', () => { scheduleResponsive(); watchDpr(); }, { once: true });
})();
document.fonts?.ready.then(scheduleResponsive);
watchMutations($('blocked'), { childList: true, characterData: true, subtree: true });
watchMutations($('manage-bookmarks'), { childList: true, characterData: true });
watchMutations($('bookmark-items'), { childList: true });
watchMutations(document.body, { attributes: true, attributeFilter: ['class'] });
scheduleResponsive();
