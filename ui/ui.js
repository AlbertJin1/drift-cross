const $ = (id) => document.getElementById(id);
const mod = drift.platform === 'darwin' ? '\u2318' : 'Ctrl+';

let state = { spaces: [], tabs: [], url: '', bookmarks: [], blockedHosts: [], blocked: 0, adBlockEnabled: true, settings: { appearance: 'system', searchEngine: 'duckduckgo', restoreSession: true, showBookmarksBar: true }, version: '1.1.0' };
document.body.classList.toggle('is-windows', drift.platform === 'win32');
const tabEls = new Map();
let lastActiveId = null;
let lastBookmarkSignature = null;
let lastBookmarkBarSignature = null;
const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 2.8z"/></svg>';

$('back') && ( $('back').disabled = true );
$('forward') && ( $('forward').disabled = true );
$('star').innerHTML = STAR_SVG;

function makeTab(id) {
  const e = document.createElement('div');
  e.className = 'tab';
  e.tabIndex = 0;
  e.setAttribute('role', 'button');
  const ico = document.createElement('div'); ico.className = 'tab-ico';
  const title = document.createElement('span'); title.className = 'tab-title';
  const x = document.createElement('button'); x.className = 'tab-close'; x.title = 'Close tab'; x.setAttribute('aria-label', 'Close tab'); x.innerHTML = X_SVG;
  e.append(ico, title, x);
  e._id = id; e._ico = ico; e._title = title;
  e.addEventListener('click', (ev) => drift.cmd(ev.target.closest('.tab-close') ? 'close' : 'activate', e._id));
  e.addEventListener('auxclick', (ev) => { if (ev.button === 1) drift.cmd('close', e._id); });
  e.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); drift.cmd('activate', e._id); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); drift.cmd('close', e._id); }
  });
  return e;
}

function dot(t) {
  const d = document.createElement('div'); d.className = 'tab-dot';
  d.textContent = (t.title || '?').trim().charAt(0).toUpperCase();
  return d;
}

function updateTab(e, t) {
  e.className = 'tab' + (t.active ? ' active' : '') + (t.loading ? ' is-loading' : '');
  e._title.textContent = t.title || 'New tab';
  e.title = t.title || '';
  const stamp = `${t.loading ? 1 : 0}|${t.favicon || ''}|${(t.title || '?').slice(0, 1)}`;
  if (e._iconStamp !== stamp) {
    e._ico.replaceChildren();
    if (t.loading) {
      const s = document.createElement('div'); s.className = 'tab-spinner'; e._ico.append(s);
    } else if (t.favicon) {
      const img = document.createElement('img'); img.src = t.favicon; img.alt = '';
      img.onerror = () => img.replaceWith(dot(t));
      e._ico.append(img);
    } else e._ico.append(dot(t));
    e._iconStamp = stamp;
  }
}

function renderSpaces() {
  const sp = $('spaces');
  const existing = new Map([...sp.children].map((el) => [el.dataset.space, el]));
  state.spaces.forEach((name, i) => {
    let b = existing.get(name);
    if (!b) {
      b = document.createElement('button'); b.className = 'space'; b.dataset.space = name;
      b.addEventListener('click', () => drift.cmd('space', b.dataset.space));
    }
    b.textContent = name;
    b.classList.toggle('on', name === state.space);
    b.title = `${name} (${mod}${i + 1})`;
    b.setAttribute('aria-pressed', String(name === state.space));
    sp.appendChild(b);
    existing.delete(name);
  });
  existing.forEach((el) => el.remove());
}

function renderTabs() {
  const box = $('tabs'); const seen = new Set();
  state.tabs.forEach((t, i) => {
    let e = tabEls.get(t.id);
    if (!e) { e = makeTab(t.id); tabEls.set(t.id, e); }
    updateTab(e, t);
    if (box.children[i] !== e) box.insertBefore(e, box.children[i] || null);
    seen.add(t.id);
  });
  for (const [id, e] of tabEls) if (!seen.has(id)) { e.remove(); tabEls.delete(id); }
  const active = state.tabs.find((t) => t.active);
  if (active && active.id !== lastActiveId) {
    tabEls.get(active.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    lastActiveId = active.id;
  }
}

function makeBookmarkButton(bookmark) {
  const b = document.createElement('button');
  b.className = 'bookmark-link';
  b.title = `${bookmark.title || bookmark.url}\n${bookmark.url}`;
  b.addEventListener('click', () => drift.cmd('go', bookmark.url));
  const mark = document.createElement('span'); mark.className = 'bookmark-mark'; mark.textContent = (bookmark.title || bookmark.url || '•').trim().charAt(0).toUpperCase();
  const label = document.createElement('span'); label.className = 'bookmark-label'; label.textContent = bookmark.title || bookmark.url;
  b.append(mark, label);
  return b;
}

function renderBookmarkBar() {
  const box = $('bookmark-items');
  const allBookmarks = state.bookmarks || [];
  const items = allBookmarks.slice(0, 12);
  const signature = items.map((b) => `${b.url}\u0000${b.title || ''}`).join('\u0001') + `|${allBookmarks.length}`;
  if (signature === lastBookmarkBarSignature) return;
  lastBookmarkBarSignature = signature;
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('span'); empty.className = 'bookmark-empty';
    empty.textContent = 'Bookmark your favorite pages with the star button';
    fragment.append(empty);
  } else items.forEach((b) => fragment.append(makeBookmarkButton(b)));
  box.replaceChildren(fragment);
  $('manage-bookmarks').textContent = allBookmarks.length > 12 ? `Manage (${allBookmarks.length})` : 'Manage';
}

function renderBookmarkManager(force = false) {
  const list = $('bookmark-list');
  const bookmarks = state.bookmarks || [];
  const signature = bookmarks.map((b) => `${b.url}\u0000${b.title || ''}`).join('\u0001');
  if (!force && signature === lastBookmarkSignature) return;
  lastBookmarkSignature = signature;
  $('bookmark-count').textContent = `${bookmarks.length} ${bookmarks.length === 1 ? 'bookmark' : 'bookmarks'}`;
  if (!bookmarks.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<div class="empty-state-icon">☆</div><strong>No bookmarks yet</strong><span>Open a page and select the star in the address bar to save it here.</span>';
    list.replaceChildren(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  bookmarks.forEach((bookmark) => {
    const row = document.createElement('div'); row.className = 'bookmark-row';
    const fields = document.createElement('div'); fields.className = 'bookmark-fields';
    const title = document.createElement('input'); title.className = 'bookmark-edit-title'; title.type = 'text'; title.value = bookmark.title || ''; title.maxLength = 240; title.setAttribute('aria-label', 'Bookmark title');
    const url = document.createElement('input'); url.className = 'bookmark-edit-url'; url.type = 'url'; url.value = bookmark.url; url.setAttribute('aria-label', 'Bookmark URL');
    fields.append(title, url);
    const actions = document.createElement('div'); actions.className = 'bookmark-actions';
    const open = document.createElement('button'); open.className = 'small-action primary-action'; open.textContent = 'Open'; open.title = 'Open bookmark in a new tab';
    open.addEventListener('click', () => { drift.cmd('new', bookmark.url); closeDialog('bookmarksDialog'); });
    const save = document.createElement('button'); save.className = 'small-action'; save.textContent = 'Save'; save.title = 'Save bookmark changes';
    save.addEventListener('click', () => {
      const candidateUrl = url.value.trim();
      const invalidUrl = !/^https?:\/\//i.test(candidateUrl);
      const duplicateUrl = state.bookmarks.some((item) => item.url === candidateUrl && item.url !== bookmark.url);
      if (invalidUrl || duplicateUrl || !title.value.trim()) {
        url.classList.toggle('invalid', invalidUrl || duplicateUrl);
        if (!title.value.trim()) title.focus(); else url.focus();
        return;
      }
      url.classList.remove('invalid');
      drift.manage('bookmark:update', bookmark.url, title.value, candidateUrl);
      save.textContent = 'Saved';
      setTimeout(() => { if (save.isConnected) save.textContent = 'Save'; }, 900);
    });
    const remove = document.createElement('button'); remove.className = 'small-action remove-action'; remove.textContent = 'Remove'; remove.title = 'Remove bookmark';
    remove.addEventListener('click', () => drift.manage('bookmark:remove', bookmark.url));
    actions.append(open, save, remove);
    row.append(fields, actions);
    frag.append(row);
  });
  list.replaceChildren(frag);
}

function renderProtection() {
  const enabled = !!state.adBlockEnabled;
  $('adblock-enabled').checked = enabled;
  $('blocked-total').textContent = Number(state.blocked || 0).toLocaleString();
  $('blocked').textContent = Number(state.blocked || 0).toLocaleString();
  $('protection').classList.toggle('disabled', !enabled);
  $('protection').classList.toggle('site-paused', !!state.siteAllowed);
  $('protection').title = enabled ? 'Ad and tracker protection is on' : 'Ad and tracker protection is paused';
  const host = state.currentHost || '';
  $('exception-host').textContent = host || 'Open a website to manage its exception.';
  $('exception-title').textContent = host ? `Protection for ${host}` : 'This website';
  $('site-exception-toggle').disabled = !host;
  $('site-exception-toggle').textContent = state.siteAllowed ? 'Resume on this site' : 'Pause on this site';
  $('site-exception-toggle').classList.toggle('danger-action', !state.siteAllowed && !!host);
  const hosts = $('blocked-hosts');
  if (!state.blockedHosts?.length) {
    const empty = document.createElement('span'); empty.className = 'muted-note'; empty.textContent = 'No blocked requests yet in this session.';
    hosts.replaceChildren(empty);
  } else {
    hosts.replaceChildren(...state.blockedHosts.map((item) => {
      const row = document.createElement('div'); row.className = 'blocked-host-row';
      const label = document.createElement('span'); label.textContent = item.host;
      const count = document.createElement('span'); count.className = 'blocked-host-count'; count.textContent = Number(item.count).toLocaleString();
      row.append(label, count); return row;
    }));
  }
}

function applySettings() {
  const prefs = state.settings || {};
  const theme = ['system', 'light', 'dark'].includes(prefs.appearance) ? prefs.appearance : 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('hide-bookmarks', prefs.showBookmarksBar === false);
  const isWindows = drift.platform === 'win32';
  document.documentElement.style.setProperty('--chrome-height', `${isWindows ? (prefs.showBookmarksBar === false ? 114 : 142) : (prefs.showBookmarksBar === false ? 92 : 120)}px`);
  if ($('theme-setting')) $('theme-setting').value = theme;
  if ($('search-setting')) $('search-setting').value = prefs.searchEngine || 'duckduckgo';
  if ($('restore-session-setting')) $('restore-session-setting').checked = prefs.restoreSession !== false;
  if ($('show-bookmarks-setting')) $('show-bookmarks-setting').checked = prefs.showBookmarksBar !== false;
  if ($('app-version')) $('app-version').textContent = `Drift ${state.version || '1.1.0'}`;
  if ($('runtime-version')) $('runtime-version').textContent = state.electronVersion ? `Electron ${state.electronVersion}` : 'Electron runtime';
  if ($('chromium-version')) $('chromium-version').textContent = state.chromiumVersion ? `Chromium ${state.chromiumVersion}` : 'Chromium engine';
  if ($('window-version')) $('window-version').textContent = (state.version || '1.1.0').split('.').slice(0, 2).join('.');
  const activeTab = (state.tabs || []).find((t) => t.active);
  if ($('window-title')) $('window-title').textContent = activeTab?.title ? `${activeTab.title} · Drift` : 'A calmer way to browse';
  if ($('win-maximize')) {
    $('win-maximize').innerHTML = state.isMaximized
      ? '<svg viewBox="0 0 24 24"><path d="M8 8V5h11v11h-3M5 8h11v11H5z"/></svg>'
      : '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx=".5"/></svg>';
    $('win-maximize').title = state.isMaximized ? 'Restore' : 'Maximize';
    $('win-maximize').setAttribute('aria-label', state.isMaximized ? 'Restore window' : 'Maximize window');
  }
}

function saveSettingsFromControls() {
  drift.manage('settings:update', {
    appearance: $('theme-setting').value,
    searchEngine: $('search-setting').value,
    restoreSession: $('restore-session-setting').checked,
    showBookmarksBar: $('show-bookmarks-setting').checked
  });
}

function render() {
  applySettings();
  document.body.classList.toggle('loading', !!state.loading);
  renderSpaces();
  renderTabs();
  if (document.activeElement !== $('addr')) $('addr').value = state.url || '';
  $('omni').classList.toggle('secure', (state.url || '').startsWith('https:'));
  $('back').disabled = !state.canBack;
  $('forward').disabled = !state.canForward;
  $('star').classList.toggle('on', !!state.bookmarked);
  $('star').setAttribute('aria-pressed', String(!!state.bookmarked));
  renderBookmarkBar();
  renderBookmarkManager(false);
  renderProtection();
}

function openDialog(id) {
  $(id).classList.remove('hidden');
  document.body.classList.add('dialog-open');
  if (id === 'bookmarksDialog') renderBookmarkManager(true);
  if (id === 'adblockDialog') renderProtection();
  drift.cmd('overlay-open');
}
function closeDialog(id) {
  $(id).classList.add('hidden');
  if (![...document.querySelectorAll('.dialog-overlay')].some((el) => !el.classList.contains('hidden'))) {
    document.body.classList.remove('dialog-open');
    drift.cmd('overlay-close');
  }
}

// Main-process events are whitelisted in preload.js.
drift.on('state', (next) => { state = next; render(); });
drift.on('focus-address', () => { $('addr').focus(); $('addr').select(); });
drift.on('open-bookmarks', () => openDialog('bookmarksDialog'));
drift.on('open-adblock', () => openDialog('adblockDialog'));
drift.on('open-settings', () => openDialog('settingsDialog'));

$('omni').addEventListener('submit', (e) => { e.preventDefault(); drift.cmd('go', $('addr').value); $('addr').blur(); });
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('addr').value = state.url || ''; $('addr').blur(); } });
$('addr').addEventListener('focus', () => setTimeout(() => $('addr').select(), 0));
for (const [id, name] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload'], ['reader', 'reader'],
  ['star', 'bookmark'], ['palette', 'palette'], ['newtab', 'new']]) {
  $(id).addEventListener('click', () => drift.cmd(name));
}
$('bookmarks-toggle').addEventListener('click', () => openDialog('bookmarksDialog'));
$('manage-bookmarks').addEventListener('click', () => openDialog('bookmarksDialog'));
$('protection').addEventListener('click', () => openDialog('adblockDialog'));
$('settings').addEventListener('click', () => openDialog('settingsDialog'));
$('theme-setting').addEventListener('change', saveSettingsFromControls);
$('search-setting').addEventListener('change', saveSettingsFromControls);
$('restore-session-setting').addEventListener('change', saveSettingsFromControls);
$('show-bookmarks-setting').addEventListener('change', saveSettingsFromControls);
$('win-minimize').addEventListener('click', () => drift.windowAction('minimize'));
$('win-maximize').addEventListener('click', () => drift.windowAction('maximize'));
$('window-drag-region').addEventListener('dblclick', () => drift.windowAction('maximize'));
$('win-close').addEventListener('click', () => drift.windowAction('close'));
$('adblock-enabled').addEventListener('change', (e) => drift.manage('adblock:toggle', e.target.checked));
$('reset-blocked').addEventListener('click', () => drift.manage('adblock:reset-count'));
$('site-exception-toggle').addEventListener('click', () => {
  if (state.currentHost) drift.manage('adblock:toggle-site', state.currentHost);
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
document.querySelectorAll('.dialog-overlay').forEach((overlay) => overlay.addEventListener('mousedown', (e) => {
  if (e.target === overlay) closeDialog(overlay.id);
}));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.dialog-overlay:not(.hidden)').forEach((overlay) => closeDialog(overlay.id));
  }
});

// Render immediately so the chrome remains stable even before the first state event.
render();
