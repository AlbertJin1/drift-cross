const $ = (id) => document.getElementById(id);
let state = {
  tabs: [], url: '', internalPage: '', bookmarks: [], history: [], downloads: [], extensions: [],
  blockedHosts: [], blocked: 0, adBlockEnabled: true,
  settings: { appearance: 'system', colorTheme: 'violet', searchEngine: 'duckduckgo', startupMode: 'previous', startupPages: [], homepage: '', showHomeButton: false, newTabOpens: 'newtab', newTabShortcuts: 'smart', newTabClock: true, windowStart: 'default', launchAtLogin: false, showBookmarksBar: true, askWhereToSave: false },
  version: '1.3.0', find: { visible: false, activeMatchOrdinal: 0, matches: 0 }
};
document.body.classList.toggle('is-windows', drift.platform === 'win32');
const tabEls = new Map();
let lastActiveId = null;
let lastBookmarkBarSignature = '';
let currentSettingsSection = 'general';
let bookmarkFilter = '';
let bookmarkFolderFilter = '';
let historyFilter = '';
let lastPageRenderKey = '';
let contextTarget = null;
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
systemLight.addEventListener('change', () => applySettings());
const COLOR_THEMES = [
  { id: 'violet', name: 'Violet', primary: '#a58bff', secondary: '#61e3dc' },
  { id: 'ocean', name: 'Ocean', primary: '#67c9ef', secondary: '#54e6d3' },
  { id: 'forest', name: 'Forest', primary: '#5bd6a4', secondary: '#b2e875' },
  { id: 'rose', name: 'Rose', primary: '#ff8da8', secondary: '#ffc0d0' },
  { id: 'sunset', name: 'Sunset', primary: '#ffad72', secondary: '#f277a8' },
  { id: 'indigo', name: 'Indigo', primary: '#8ea4ff', secondary: '#7cd4f1' },
  { id: 'graphite', name: 'Graphite', primary: '#aab4c4', secondary: '#8bc8bf' },
  { id: 'mint', name: 'Mint', primary: '#61d4d1', secondary: '#8bbcff' }
];
const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 2.8z"/></svg>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function formatDate(value, withTime = true) {
  if (!value) return 'Unknown date';
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  return date.toLocaleString([], withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
function isCompleted(download) { return ['completed', 'cancelled', 'interrupted'].includes(download.state); }

function makeTab(id) {
  const element = document.createElement('div');
  element.className = 'tab';
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  const icon = document.createElement('div'); icon.className = 'tab-ico';
  const title = document.createElement('span'); title.className = 'tab-title';
  const close = document.createElement('button'); close.className = 'tab-close'; close.title = 'Close tab'; close.setAttribute('aria-label', 'Close tab'); close.innerHTML = X_SVG;
  element.append(icon, title, close);
  element._id = id; element._ico = icon; element._title = title;
  element.addEventListener('click', (event) => drift.cmd(event.target.closest('.tab-close') ? 'close' : 'activate', element._id));
  element.addEventListener('auxclick', (event) => { if (event.button === 1) drift.cmd('close', element._id); });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); drift.cmd('activate', element._id); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); drift.cmd('close', element._id); }
  });
  return element;
}
function fallbackTabIcon(tab) {
  const node = document.createElement('div'); node.className = 'tab-dot';
  node.textContent = (tab.title || '?').trim().charAt(0).toUpperCase();
  return node;
}
function updateTab(element, tab) {
  element.className = 'tab' + (tab.active ? ' active' : '') + (tab.loading ? ' is-loading' : '');
  element._title.textContent = tab.title || 'New tab';
  element.title = tab.title || '';
  const stamp = `${tab.loading ? 1 : 0}|${tab.favicon || ''}|${(tab.title || '?').slice(0, 1)}`;
  if (element._iconStamp !== stamp) {
    element._ico.replaceChildren();
    if (tab.loading) {
      const spinner = document.createElement('div'); spinner.className = 'tab-spinner'; element._ico.append(spinner);
    } else if (tab.favicon) {
      const image = document.createElement('img'); image.src = tab.favicon; image.alt = '';
      image.onerror = () => image.replaceWith(fallbackTabIcon(tab));
      element._ico.append(image);
    } else element._ico.append(fallbackTabIcon(tab));
    element._iconStamp = stamp;
  }
}
function renderTabs() {
  const box = $('tabs'); const seen = new Set();
  (state.tabs || []).forEach((tab, index) => {
    let element = tabEls.get(tab.id);
    if (!element) { element = makeTab(tab.id); tabEls.set(tab.id, element); }
    updateTab(element, tab);
    if (box.children[index] !== element) box.insertBefore(element, box.children[index] || null);
    seen.add(tab.id);
  });
  for (const [id, element] of tabEls) if (!seen.has(id)) { element.remove(); tabEls.delete(id); }
  const active = (state.tabs || []).find((tab) => tab.active);
  if (active && active.id !== lastActiveId) {
    tabEls.get(active.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    lastActiveId = active.id;
  }
}

function makeBookmarkButton(bookmark) {
  const button = document.createElement('button');
  button.className = 'bookmark-link';
  button.dataset.url = bookmark.url;
  button.title = `${bookmark.title || bookmark.url}\n${bookmark.url}`;
  button.addEventListener('click', () => drift.cmd('go', bookmark.url));
  const mark = document.createElement('span'); mark.className = 'bookmark-mark'; mark.textContent = (bookmark.title || bookmark.url || '•').trim().charAt(0).toUpperCase();
  const label = document.createElement('span'); label.className = 'bookmark-label'; label.textContent = bookmark.title || bookmark.url;
  button.append(mark, label);
  return button;
}
function renderBookmarkBar() {
  const box = $('bookmark-items');
  const bookmarks = state.bookmarks || [];
  const items = bookmarks.slice(0, 12);
  const signature = items.map((bookmark) => `${bookmark.url}\u0000${bookmark.title || ''}`).join('\u0001') + `|${state.bookmarksCount ?? bookmarks.length}`;
  if (signature === lastBookmarkBarSignature) return;
  lastBookmarkBarSignature = signature;
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('span'); empty.className = 'bookmark-empty';
    empty.textContent = 'Save your favorite pages with the star button'; fragment.append(empty);
  } else items.forEach((bookmark) => fragment.append(makeBookmarkButton(bookmark)));
  box.replaceChildren(fragment);
  const total = Number(state.bookmarksCount ?? bookmarks.length);
  $('manage-bookmarks').textContent = total > 12 ? `All bookmarks · ${total}` : 'All bookmarks';
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
    const empty = document.createElement('span'); empty.className = 'muted-note'; empty.textContent = 'No blocked requests yet in this session.'; hosts.replaceChildren(empty);
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
  const preferences = state.settings || {};
  const mode = ['system', 'light', 'dark'].includes(preferences.appearance) ? preferences.appearance : 'system';
  // Always resolve to a concrete light/dark so every theme palette applies, and keep following the OS in "system" mode.
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = mode === 'system' ? (systemLight.matches ? 'light' : 'dark') : mode;
  $('home')?.classList.toggle('hidden', preferences.showHomeButton !== true);
  const colorTheme = COLOR_THEMES.some((item) => item.id === preferences.colorTheme) ? preferences.colorTheme : 'violet';
  document.documentElement.dataset.colorTheme = colorTheme;
  document.body.classList.toggle('hide-bookmarks', preferences.showBookmarksBar === false);
  const isWindows = drift.platform === 'win32';
  document.documentElement.style.setProperty('--chrome-height', `${preferences.showBookmarksBar === false ? 82 : 108}px`);
  if ($('window-version')) $('window-version').textContent = (state.version || '1.3.0').split('.').slice(0, 2).join('.');
  if ($('win-maximize')) {
    $('win-maximize').innerHTML = state.isMaximized
      ? '<svg viewBox="0 0 24 24"><path d="M8 8V5h11v11h-3M5 8h11v11H5z"/></svg>'
      : '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx=".5"/></svg>';
    $('win-maximize').title = state.isMaximized ? 'Restore' : 'Maximize';
    $('win-maximize').setAttribute('aria-label', state.isMaximized ? 'Restore window' : 'Maximize window');
  }
  if ($('window-actions')) $('window-actions').classList.toggle('hidden', !isWindows);
}

function settingRow(label, hint, control) {
  return `<div class="page-setting-row"><div class="page-setting-copy"><strong>${label}</strong><small>${hint}</small></div>${control}</div>`;
}
function selectSetting(id, value, options) {
  return `<select id="${id}" class="page-select">${options.map(([optionValue, label]) => `<option value="${optionValue}" ${value === optionValue ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
}
function switchSetting(id, checked) {
  return `<label class="switch-wrap page-switch"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><span class="switch-track"></span></label>`;
}
const STARTUP_OPTIONS = [
  ['newtab', 'Open the New Tab page', 'Start fresh with a clean tab.', '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M12 9.5v5M9.5 12h5"/></svg>'],
  ['previous', 'Continue where you left off', 'Reopen the tabs from your last session.', '<svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5M12 7.8V12l3 1.8"/></svg>'],
  ['specific', 'Open specific pages', 'Always start with the pages you choose.', '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>'],
  ['homepage', 'Open your home page', 'Start on a single page you pick below.', '<svg viewBox="0 0 24 24"><path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.8 9.8V20h12.4V9.8"/><path d="M10 20v-5.5h4V20"/></svg>']
];
function looksLikeUrl(value) {
  const text = String(value || '').trim();
  if (!text || /\s/.test(text)) return false;
  return /^about:blank$/i.test(text) || /^https?:\/\/[^/]+/i.test(text) || /^localhost(?::\d+)?(?:[/?#]|$)/i.test(text) || /^[^/\s]+\.[^/\s.]{2,}(?::\d+)?(?:[/?#]|$)/.test(text);
}
function startupOptionsMarkup(prefs) {
  const mode = STARTUP_OPTIONS.some(([id]) => id === prefs.startupMode) ? prefs.startupMode : 'previous';
  const pages = Array.isArray(prefs.startupPages) ? prefs.startupPages : [];
  const cards = STARTUP_OPTIONS.map(([id, title, hint, icon]) => {
    const detail = id === 'homepage'
      ? (prefs.homepage ? `Opens ${escapeHtml(prefs.homepage)}` : 'No home page set — the New Tab page will open. Set one under “Home page” below.')
      : (id === 'specific' && mode === 'specific' ? `${pages.length} page${pages.length === 1 ? '' : 's'} saved` : hint);
    return `<label class="choice-card ${mode === id ? 'selected' : ''}"><input type="radio" name="startup-mode" value="${id}" ${mode === id ? 'checked' : ''}><span class="choice-icon">${icon}</span><span class="choice-copy"><strong>${title}</strong><small>${detail}</small></span><span class="choice-radio" aria-hidden="true"></span></label>`;
  }).join('');
  const editor = mode !== 'specific' ? '' : `
    <div class="startup-pages">
      <div class="startup-pages-head"><div><strong>Pages to open</strong><small>Up to 12 pages, opened in order as tabs.</small></div><button type="button" class="small-action" data-action="startup-use-open-tabs">Use open tabs</button></div>
      ${pages.length ? `<ul class="startup-page-list">${pages.map((url, index) => {
        let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
        return `<li><span class="startup-page-mark">${escapeHtml((host || url).charAt(0).toUpperCase())}</span><span class="startup-page-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span><button type="button" class="icon sm" data-action="remove-startup-page" data-index="${index}" title="Remove" aria-label="Remove ${escapeHtml(host || url)}">${X_SVG}</button></li>`;
      }).join('')}</ul>` : '<p class="startup-empty">No pages yet — Drift will open the New Tab page until you add one.</p>'}
      ${pages.length >= 12 ? '' : '<form id="startup-add-form" class="startup-add" autocomplete="off"><input id="startup-add-input" class="page-input" type="text" placeholder="Add a page, e.g. github.com" spellcheck="false" aria-label="Page address"><button type="submit" class="primary-button">Add page</button></form>'}
    </div>`;
  return `<div class="choice-list" role="radiogroup" aria-label="When Drift starts">${cards}</div>${editor}`;
}
function modePickerMarkup(current) {
  const pane = (kind) => `<span class="mp-pane mp-${kind}"><i></i><i></i><i></i></span>`;
  const modes = [
    ['system', 'System', 'Match your device', pane('light') + pane('dark')],
    ['light', 'Light', 'Bright and clear', pane('light')],
    ['dark', 'Dark', 'Easy on the eyes', pane('dark')]
  ];
  return `<div class="mode-picker" role="radiogroup" aria-label="Interface mode">${modes.map(([id, name, hint, preview]) => `<label class="mode-option ${current === id ? 'selected' : ''}"><input type="radio" name="appearance-mode" value="${id}" ${current === id ? 'checked' : ''}><span class="mode-preview">${preview}</span><span class="mode-name">${name}</span><small>${hint}</small></label>`).join('')}</div>`;
}
function renderSettingsContent() {
  const prefs = state.settings || {};
  const sections = {
    general: {
      title: 'General', intro: 'Control how Drift starts and behaves.', cards: [
        ['When Drift starts', 'Choose what you see each time you open the browser.', startupOptionsMarkup(prefs), 'startup-card'],
        ['Home page', 'Used by the Home button and the “home page” options.', [
          settingRow('Home page address', 'Leave empty to use the New Tab page.', `<input id="homepage-setting" class="page-input" type="text" value="${escapeHtml(prefs.homepage || '')}" placeholder="New Tab page" spellcheck="false" autocomplete="off" aria-label="Home page address">`),
          settingRow('Show Home button', 'Add a Home button next to Reload.', switchSetting('show-home-setting', prefs.showHomeButton === true))
        ].join('')],
        ['Window and system', 'How the Drift window appears when it opens.', [
          settingRow('Window on startup', 'Pick the size Drift opens at.', selectSetting('window-start-setting', prefs.windowStart || 'default', [['default', 'Default size'], ['maximized', 'Maximized'], ['remember', 'Remember last size and position']])),
          state.canLaunchAtLogin === false ? '' : settingRow('Launch Drift when you sign in', 'Start the browser automatically when your computer starts.', switchSetting('launch-login-setting', prefs.launchAtLogin === true))
        ].join('')]
      ]
    },
    appearance: {
      title: 'Appearance', intro: 'Make the browser comfortable to use, day or night.', cards: [
        ['Interface mode', 'Light, dark, or follow your operating system automatically.', modePickerMarkup(prefs.appearance || 'system'), 'mode-card'],
        ['Color theme', 'An accent palette for tabs, controls, highlights, and browser pages.',
          `<div class="theme-picker-block"><div class="theme-grid">${COLOR_THEMES.map((theme) => `<button type="button" class="theme-option ${((prefs.colorTheme || 'violet') === theme.id) ? 'selected' : ''}" data-color-theme="${theme.id}" aria-pressed="${(prefs.colorTheme || 'violet') === theme.id}" title="${theme.name} theme"><span class="theme-preview theme-preview-${theme.id}"><i></i><i></i><i></i></span><span class="theme-option-name">${theme.name}</span>${(prefs.colorTheme || 'violet') === theme.id ? '<span class="theme-check">✓</span>' : ''}</button>`).join('')}</div></div>`],
        ['Toolbar', '', settingRow('Bookmarks bar', 'Keep favorite websites one click below the address bar.', switchSetting('show-bookmarks-setting', prefs.showBookmarksBar !== false))]
      ]
    },
    newtab: {
      title: 'New tab', intro: 'Shape what opens when you start a new tab.', cards: [
        ['New tab behavior', '', [
          settingRow('New tabs open with', 'What appears when you press Ctrl+T or the + button.', selectSetting('newtab-opens-setting', prefs.newTabOpens || 'newtab', [['newtab', 'New Tab page'], ['homepage', 'Home page'], ['blank', 'Blank page']])),
          (prefs.newTabOpens === 'homepage' && !prefs.homepage) ? `<div class="setting-note">No home page is set, so new tabs will show the New Tab page. <button class="link-action" data-setting-section-link="general">Set a home page</button></div>` : ''
        ].join('')],
        ['New Tab page', 'Applies when the New Tab page is shown.', [
          settingRow('Shortcuts', 'Which sites appear under the search box.', selectSetting('newtab-shortcuts-setting', prefs.newTabShortcuts || 'smart', [['smart', 'Most visited sites'], ['bookmarks', 'Recent bookmarks'], ['hidden', 'Hidden']])),
          settingRow('Show date and time', 'Display the clock and date at the top of the page.', switchSetting('newtab-clock-setting', prefs.newTabClock !== false))
        ].join('')]
      ]
    },
    search: {
      title: 'Search engine', intro: 'Choose the provider used for address-bar searches.', body: [
        settingRow('Default search engine', 'Used when your address-bar entry is not a web address.', selectSetting('search-setting', prefs.searchEngine || 'duckduckgo', [['duckduckgo', 'DuckDuckGo'], ['google', 'Google'], ['bing', 'Bing'], ['brave', 'Brave Search']]))
      ].join('')
    },
    privacy: {
      title: 'Privacy and security', intro: 'Manage built-in protection and site exceptions.', body: [
        settingRow('Block ads and trackers', 'Filter a bundled list of common advertising and analytics hosts.', switchSetting('settings-adblock', state.adBlockEnabled !== false)),
        `<div class="settings-inline-card"><div><strong>Clear browsing data</strong><small>Delete history, cookies, cached files and more for a chosen time range.</small></div><button class="small-action" data-action="clear-data">Clear data…</button></div>`,
        `<div class="settings-inline-card"><div><strong>Site exceptions and activity</strong><small>${Number(state.blocked || 0).toLocaleString()} requests blocked this session</small></div><button class="small-action" data-action="open-protection">Manage protection</button></div>`
      ].join('')
    },
    downloads: {
      title: 'Downloads', intro: 'Choose where downloaded files are saved.', body: [
        settingRow('Download location', 'Files are saved to this folder by default.', `<div class="folder-control"><span class="folder-path">${escapeHtml(prefs.downloadDirectory || 'System Downloads')}</span><button class="small-action" data-action="choose-download-folder">Change</button></div>`),
        settingRow('Ask where to save each file', 'Show a Save dialog before every download.', switchSetting('ask-save-setting', prefs.askWhereToSave === true))
      ].join('')
    },
    about: {
      title: 'About Drift', intro: 'Browser build and runtime information.', body: `
        <div class="about-page-card"><img src="../shared/assets/drift-mark.svg" alt=""><div><strong>Drift ${escapeHtml(state.version || '1.3.0')}</strong><small>A focused browser built for fast, comfortable browsing.</small><small>Electron ${escapeHtml(state.electronVersion || '—')} · Chromium ${escapeHtml(state.chromiumVersion || '—')}</small></div><span class="version-status">Installed build</span></div>
        <div class="settings-inline-card profile-location-card"><div><strong>Browser profile location</strong><small class="profile-path">${escapeHtml(state.profileDirectory || 'AppData/Drift')}</small><small>Settings, bookmarks, history, session data, and installed extensions are stored here.</small></div><button class="small-action" data-action="open-profile-folder">Open folder</button></div>
        <p class="page-muted-copy">Drift uses the Chromium engine through Electron. Extensions are copied into your Drift profile so they remain available after the original folder is moved.</p>`
    }
  };
  const section = sections[currentSettingsSection] || sections.general;
  const body = section.cards
    ? section.cards.map(([title, hint, html, cls = '']) => `<section class="settings-group"><div class="group-head"><h2 class="group-title">${title}</h2>${hint ? `<p>${hint}</p>` : ''}</div><div class="page-card settings-card ${cls}">${html}</div></section>`).join('')
    : `<div class="page-card settings-card">${section.body}</div>`;
  $('page-main').innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">PREFERENCES</span><h1>${section.title}</h1><p>${section.intro}</p></div></div>
    ${body}
    <div class="page-footnote">Settings are saved automatically on this device.</div>`;
}
function renderBookmarksPage() {
  const all = (state.bookmarks || []).filter((bookmark) => `${bookmark.title} ${bookmark.url} ${bookmark.folder || ''}`.toLowerCase().includes(bookmarkFilter.toLowerCase()) && (!bookmarkFolderFilter || (bookmark.folder || '') === bookmarkFolderFilter));
  const folders = [...new Set((state.bookmarks || []).map((bookmark) => bookmark.folder).filter(Boolean))].sort();
  $('page-main').innerHTML = `
    <div class="page-heading page-heading-row"><div><span class="eyebrow">YOUR LIBRARY</span><h1>Bookmarks</h1><p>Saved pages, organized and ready whenever you need them.</p></div><button class="primary-button" data-action="focus-add-bookmark">＋ Add bookmark</button></div>
    <div class="page-toolbar"><div class="page-search"><svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="7.5"/><path d="m16.4 16.4 4.2 4.2"/></svg><input id="bookmark-search" value="${escapeHtml(bookmarkFilter)}" placeholder="Search bookmarks"></div>${folders.length ? `<select id="bookmark-folder-filter" class="page-select" aria-label="Filter by bookmark folder"><option value="">All folders</option>${folders.map((folder) => `<option value="${escapeHtml(folder)}" ${bookmarkFolderFilter === folder ? 'selected' : ''}>${escapeHtml(folder)}</option>`).join('')}</select>` : ''}<span class="toolbar-count">${all.length} of ${(state.bookmarks || []).length}</span></div>
    <form id="add-bookmark-form" class="add-bookmark-form hidden"><input id="new-bookmark-title" placeholder="Name"><input id="new-bookmark-url" type="url" placeholder="https://example.com" required><input id="new-bookmark-folder" placeholder="Folder (optional)"><button class="primary-button" type="submit">Save bookmark</button></form>
    <div class="page-card manager-card">
      ${all.length ? all.map((bookmark) => `
        <div class="manager-row bookmark-manager-row" data-bookmark-url="${escapeHtml(bookmark.url)}">
          <div class="manager-favicon">${escapeHtml((bookmark.title || bookmark.url).charAt(0).toUpperCase())}</div>
          <div class="manager-fields"><input class="manager-title bookmark-title" aria-label="Bookmark title" value="${escapeHtml(bookmark.title || '')}"><input class="manager-url bookmark-url" aria-label="Bookmark URL" value="${escapeHtml(bookmark.url)}"><div class="manager-meta"><input class="bookmark-folder" aria-label="Bookmark folder" placeholder="Folder" value="${escapeHtml(bookmark.folder || '')}">${bookmark.addedAt ? `<span>Added ${formatDate(bookmark.addedAt, false)}</span>` : ''}</div></div>
          <div class="manager-actions"><button class="small-action primary-action" data-action="open-bookmark" data-url="${escapeHtml(bookmark.url)}">Open</button><button class="small-action" data-action="save-bookmark" data-url="${escapeHtml(bookmark.url)}">Save</button><button class="small-action remove-action" data-action="remove-bookmark" data-url="${escapeHtml(bookmark.url)}">Remove</button></div>
        </div>`).join('') : `<div class="empty-state"><div class="empty-state-icon">☆</div><strong>${bookmarkFilter ? 'No matching bookmarks' : 'No bookmarks yet'}</strong><span>${bookmarkFilter ? 'Try a different search.' : 'Use the star in the address bar or add a bookmark here.'}</span></div>`}
    </div>
    <div class="page-footnote">${folders.length ? `Folders: ${folders.map(escapeHtml).join(' · ')}` : 'Tip: enter a folder name while saving to organize your bookmarks.'}</div>`;
  const form = $('add-bookmark-form');
  form?.classList.toggle('hidden', !form.dataset.open);
}
function renderHistoryPage() {
  const history = (state.history || []).filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(historyFilter.toLowerCase()));
  $('page-main').innerHTML = `
    <div class="page-heading page-heading-row"><div><span class="eyebrow">YOUR ACTIVITY</span><h1>History</h1><p>Pages you have visited in Drift.</p></div><button class="secondary-button" data-action="clear-history" ${(state.history || []).length ? '' : 'disabled'}>Clear history</button></div>
    <div class="page-toolbar"><div class="page-search"><svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="7.5"/><path d="m16.4 16.4 4.2 4.2"/></svg><input id="history-search" value="${escapeHtml(historyFilter)}" placeholder="Search history"></div><span class="toolbar-count">${history.length} visits</span></div>
    <div class="page-card manager-card">${history.length ? history.map((entry) => `
      <div class="manager-row history-manager-row"><div class="history-date">${escapeHtml(formatDate(entry.visitedAt || 0))}</div><div class="manager-fields"><strong>${escapeHtml(entry.title || entry.url)}</strong><span class="manager-url-text">${escapeHtml(entry.url)}</span></div><div class="manager-actions"><button class="small-action primary-action" data-action="open-history" data-url="${escapeHtml(entry.url)}">Open</button><button class="small-action remove-action" data-action="remove-history" data-id="${escapeHtml(entry.id || '')}" title="Remove this visit">Remove</button></div></div>`).join('') : `<div class="empty-state"><div class="empty-state-icon">◷</div><strong>${historyFilter ? 'No matching pages' : 'Your history is empty'}</strong><span>${historyFilter ? 'Try a different search.' : 'Pages you visit will appear here.'}</span></div>`}</div>`;
}
function renderDownloadsPage() {
  const downloads = state.downloads || [];
  $('page-main').innerHTML = `
    <div class="page-heading page-heading-row"><div><span class="eyebrow">FILE ACTIVITY</span><h1>Downloads</h1><p>Track files saved from your browsing sessions.</p></div><button class="secondary-button" data-action="clear-downloads" ${downloads.some(isCompleted) ? '' : 'disabled'}>Clear completed</button></div>
    <div class="page-card manager-card downloads-card">${downloads.length ? downloads.map((download) => {
      const total = Number(download.totalBytes || 0); const received = Number(download.receivedBytes || 0);
      const progress = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
      const complete = download.state === 'completed';
      const terminal = isCompleted(download);
      const paused = download.state === 'paused';
      const status = complete ? 'Completed' : paused ? 'Paused' : download.state === 'cancelled' ? 'Cancelled' : download.state === 'interrupted' ? 'Interrupted' : 'Downloading';
      return `<div class="manager-row download-row"><div class="download-file-icon"><svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v6h5M9 14h6M9 17h6"/></svg></div><div class="manager-fields"><strong>${escapeHtml(download.filename || 'Download')}</strong><span class="manager-url-text">${escapeHtml(download.url || '')}</span><div class="download-progress-meta"><span>${status} · ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''}</span><span>${complete ? '100%' : total ? `${progress}%` : ''}</span></div>${!isCompleted(download) ? `<progress class="download-progress ${total ? '' : 'indeterminate'}" ${total ? `value="${received}" max="${total}"` : ''} aria-label="Download progress"></progress>` : ''}<small class="download-date">${formatDate(download.startedAt)}</small></div><div class="manager-actions download-actions">${complete ? `<button class="small-action primary-action" data-action="download-open" data-id="${escapeHtml(download.id)}">Open</button>` : !terminal ? `<button class="small-action" data-action="download-${paused ? 'resume' : 'pause'}" data-id="${escapeHtml(download.id)}">${paused ? 'Resume' : 'Pause'}</button><button class="small-action remove-action" data-action="download-cancel" data-id="${escapeHtml(download.id)}">Cancel</button>` : ''}${download.savePath ? `<button class="small-action" data-action="download-show" data-id="${escapeHtml(download.id)}">Show</button>` : ''}</div></div>`;
    }).join('') : `<div class="empty-state"><div class="empty-state-icon">↓</div><strong>No downloads yet</strong><span>Files you download will appear here with their progress and save location.</span></div>`}</div>`;
}
function renderExtensionsPage() {
  const extensions = state.extensions || [];
  $('page-main').innerHTML = `
    <div class="page-heading page-heading-row"><div><span class="eyebrow">BROWSER TOOLS</span><h1>Extensions</h1><p>Add Chrome-compatible extensions to customize your browsing experience.</p></div><div class="manager-actions"><button class="small-action" data-action="browse-web-store">Browse Web Store</button><button class="small-action" data-action="install-extension">＋ Install unpacked</button><button class="primary-button" data-action="open-store-dialog">Add from Chrome Web Store</button></div></div>
    <div class="extension-notice"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7h.01"/></svg><span>Drift installs extensions from the Chrome Web Store (updated automatically) or from an unpacked folder containing <code>manifest.json</code>. Manifest V3 extensions are supported from the store; Electron implements only part of the Chrome extension API, so some extensions may not work fully.</span></div>
    <div class="page-card manager-card">${extensions.length ? extensions.map((extension) => `
      <div class="manager-row extension-row"><div class="extension-mark">${escapeHtml((extension.name || 'E').charAt(0).toUpperCase())}</div><div class="manager-fields"><strong>${escapeHtml(extension.name)}</strong><span class="manager-url-text">${escapeHtml(extension.description || 'No description provided.')}</span><div class="manager-meta"><span>Version ${escapeHtml(extension.version || '—')}</span><span>${extension.source === 'chrome-web-store' ? 'Chrome Web Store' : 'Unpacked'}</span><span>${escapeHtml(extension.id || '')}</span></div></div><div class="manager-actions"><button class="small-action remove-action" data-action="remove-extension" data-id="${escapeHtml(extension.id)}">Remove</button></div></div>`).join('') : `<div class="empty-state"><div class="empty-state-icon">◇</div><strong>No extensions installed</strong><span>Add one from the Chrome Web Store or install an unpacked extension folder.</span></div>`}</div>
    <div class="page-footnote">Only install extensions from sources you trust. Extensions may be able to read and modify website data according to their permissions.</div>`;
}
function pageNavigation() {
  const icons = {
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.3 13.5a7.7 7.7 0 0 0 0-3l1.4-1.1-1.6-2.8-1.7.7a7.3 7.3 0 0 0-2.5-1.4L14.7 4h-3.4l-.2 1.9a7.3 7.3 0 0 0-2.5 1.4l-1.7-.7-1.6 2.8 1.4 1.1a7.7 7.7 0 0 0 0 3l-1.4 1.1 1.6 2.8 1.7-.7a7.3 7.3 0 0 0 2.5 1.4l.2 1.9h3.4l.2-1.9a7.3 7.3 0 0 0 2.5-1.4l1.7.7 1.6-2.8z"/></svg>',
    bookmarks: '<svg viewBox="0 0 24 24"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H19v19l-6.5-3.8L6 21z"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M3.5 11.5A8.5 8.5 0 1 1 5 17.1"/><path d="M3 4v5h5M12 7v5l3 2"/></svg>',
    downloads: '<svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>',
    extensions: '<svg viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 0 0-2 2v4h3a2 2 0 1 1 0 4H3v4a2 2 0 0 0 2 2h4v-3a3 3 0 1 1 6 0v3h3a2 2 0 0 0 2-2v-4h-3a2 2 0 1 1 0-4h3V5a2 2 0 0 0-2-2h-4v3a3 3 0 1 1-6 0z"/></svg>',
    general: '<svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
    appearance: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z"/></svg>',
    newtab: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 9.5h17M12 12.2v4.6M9.7 14.5h4.6"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="7.3"/><path d="m16.2 16.2 4.3 4.3"/></svg>',
    privacy: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    about: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7h.01"/></svg>'
  };
  const links = [['settings', 'Settings'], ['bookmarks', 'Bookmarks'], ['history', 'History'], ['downloads', 'Downloads'], ['extensions', 'Extensions']];
  const settingsLinks = [['general','General'],['appearance','Appearance'],['newtab','New tab'],['search','Search'],['privacy','Privacy'],['downloads','Downloads'],['about','About']];
  const subnav = state.internalPage === 'settings' ? `<div class="sidebar-caption settings-caption">SETTINGS</div><nav class="page-nav settings-subnav">${settingsLinks.map(([key,label]) => `<button class="page-nav-item setting-nav-item ${currentSettingsSection === key ? 'active' : ''}" data-setting-section="${key}"><span class="page-nav-icon">${icons[key]}</span>${label}</button>`).join('')}</nav>` : '';
  return `<div class="page-sidebar-brand"><img src="../shared/assets/drift-mark.svg" alt=""><div><strong>Drift</strong><small>Browser</small></div></div>
    <div class="sidebar-caption">LIBRARY & PREFERENCES</div>
    <nav class="page-nav">${links.map(([page, label]) => `<button class="page-nav-item ${state.internalPage === page ? 'active' : ''}" data-page="${page}"><span class="page-nav-icon">${icons[page]}</span>${label}</button>`).join('')}</nav>${subnav}
    <div class="sidebar-bottom"><span>Drift ${escapeHtml(state.version || '1.3.0')}</span><small>Changes save automatically</small></div>`;
}
function currentPageRenderKey() {
  const page = state.internalPage || '';
  if (page === 'settings') return JSON.stringify([page, currentSettingsSection, state.settings, state.adBlockEnabled, currentSettingsSection === 'privacy' ? state.blocked : 0, state.canLaunchAtLogin, state.version, state.electronVersion, state.chromiumVersion, state.profileDirectory]);
  if (page === 'bookmarks') return JSON.stringify([page, bookmarkFilter, bookmarkFolderFilter, state.bookmarks]);
  if (page === 'history') return JSON.stringify([page, historyFilter, state.history]);
  if (page === 'downloads') return JSON.stringify([page, state.downloads]);
  if (page === 'extensions') return JSON.stringify([page, state.extensions]);
  return page;
}
function renderInternalPage(force = false) {
  const page = state.internalPage || '';
  const container = $('internalPage');
  container.classList.toggle('hidden', !page);
  if (!page) { lastPageRenderKey = ''; return; }
  const key = currentPageRenderKey();
  if (!force && key === lastPageRenderKey && $('page-main').childElementCount) return;
  lastPageRenderKey = key;
  $('page-sidebar').innerHTML = pageNavigation();
  if (page === 'settings') renderSettingsContent();
  else if (page === 'bookmarks') renderBookmarksPage();
  else if (page === 'history') renderHistoryPage();
  else if (page === 'downloads') renderDownloadsPage();
  else if (page === 'extensions') renderExtensionsPage();
}

function renderFind() {
  const visible = !!state.find?.visible;
  $('findbar').classList.toggle('hidden', !visible);
  if (!visible || document.activeElement !== $('find-input')) $('find-input').value = state.find?.query || '';
  $('find-case').checked = !!state.find?.matchCase;
  $('find-count').textContent = `${state.find?.activeMatchOrdinal || 0} / ${state.find?.matches || 0}`;
}
function render() {
  applySettings();
  document.body.classList.toggle('loading', !!state.loading);
  renderTabs();
  if (document.activeElement !== $('addr') || !document.hasFocus()) $('addr').value = state.url || '';
  $('omni').classList.toggle('secure', (state.url || '').startsWith('https:'));
  $('back').disabled = !state.canBack;
  $('forward').disabled = !state.canForward;
  $('star').classList.toggle('on', !!state.bookmarked);
  $('star').setAttribute('aria-pressed', String(!!state.bookmarked));
  renderBookmarkBar();
  renderProtection();
  renderInternalPage();
  renderFind();
}

const dialogCloseHooks = {};

// ---- Clear browsing data ------------------------------------------------
const CLEAR_OPTIONS = [
  { id: 'history', label: 'Browsing history', hint: 'Pages you visited, and the address bar and palette suggestions built from them.', advanced: false },
  { id: 'cookies', label: 'Cookies and other site data', hint: 'Signs you out of most websites. Also removes local storage, IndexedDB and offline data.', advanced: false },
  { id: 'cache', label: 'Cached images and files', hint: 'Frees up space; some sites may load more slowly the first time you revisit.', advanced: false },
  { id: 'downloads', label: 'Download history', hint: 'Removes the entries from the Downloads list. The files themselves are kept.', advanced: true },
  { id: 'siteSettings', label: 'Site settings', hint: 'Ad-blocker exceptions you added for individual websites (always applies to all time).', advanced: true }
];
const clearUi = { tab: 'basic', selected: new Set(['history', 'cookies', 'cache']), range: 'hour', busy: false };
function visibleClearOptions() { return CLEAR_OPTIONS.filter((o) => clearUi.tab === 'advanced' || !o.advanced); }
function renderClearData() {
  for (const tab of ['basic', 'advanced']) $(`clear-tab-${tab}`).setAttribute('aria-selected', String(clearUi.tab === tab));
  $('clear-range').value = clearUi.range;
  $('clear-options').innerHTML = visibleClearOptions().map((o) => `<label class="clear-option"><input type="checkbox" data-clear-type="${o.id}" ${clearUi.selected.has(o.id) ? 'checked' : ''}><span><strong>${o.label}</strong><small>${o.hint}</small></span></label>`).join('');
  const picked = visibleClearOptions().filter((o) => clearUi.selected.has(o.id));
  $('clear-submit').disabled = clearUi.busy || !picked.length;
  $('clear-submit').textContent = clearUi.busy ? 'Clearing…' : 'Clear data';
  $('clear-note').textContent = clearUi.range !== 'all' && picked.some((o) => o.id === 'cookies' || o.id === 'cache')
    ? 'For a time range, cookies and site data are removed for the sites you visited in that period, and cached files are cleared completely. Choose “All time” to wipe everything.'
    : '';
}
function openClearData(preset = {}) {
  clearUi.tab = 'basic';
  clearUi.busy = false;
  if (Array.isArray(preset.types)) clearUi.selected = new Set(preset.types);
  else if (!clearUi.selected.size) clearUi.selected = new Set(['history', 'cookies', 'cache']);
  $('clear-error').classList.add('hidden');
  renderClearData();
  openDialog('clearDataDialog');
  $('clear-range').focus();
}
function summarizeCleared(c = {}) {
  const parts = [];
  if (c.history !== undefined) parts.push(`${c.history} history ${c.history === 1 ? 'entry' : 'entries'}`);
  if (c.downloads !== undefined) parts.push(`${c.downloads} download ${c.downloads === 1 ? 'entry' : 'entries'}`);
  if (c.cookies) parts.push(`cookies and site data (${c.cookies})`);
  if (c.cache) parts.push('cached files');
  if (c.siteSettings !== undefined) parts.push(`${c.siteSettings} site ${c.siteSettings === 1 ? 'exception' : 'exceptions'}`);
  return parts.length ? `Removed: ${parts.join(', ')}.` : 'Nothing to remove.';
}
async function submitClearData() {
  const types = visibleClearOptions().filter((o) => clearUi.selected.has(o.id)).map((o) => o.id);
  if (!types.length || clearUi.busy) return;
  clearUi.busy = true; renderClearData();
  const result = await drift.invoke('data:clear', { range: clearUi.range, types }).catch((error) => ({ error: error.message }));
  clearUi.busy = false;
  if (result?.error) { renderClearData(); $('clear-error').textContent = result.error; $('clear-error').classList.remove('hidden'); return; }
  closeDialog('clearDataDialog');
  await showAlert(summarizeCleared(result.cleared), 'Browsing data cleared');
}

function openDialog(id) {
  $(id).classList.remove('hidden');
  document.body.classList.add('dialog-open');
  if (id === 'adblockDialog') renderProtection();
  drift.cmd('overlay-open');
}
function closeDialog(id) {
  const hook = dialogCloseHooks[id];
  delete dialogCloseHooks[id];
  $(id).classList.add('hidden');
  if (![...document.querySelectorAll('.dialog-overlay')].some((element) => !element.classList.contains('hidden'))) {
    document.body.classList.remove('dialog-open');
    drift.cmd('overlay-close');
  }
  if (hook) hook();
}
function visibleDialogs() {
  return [...document.querySelectorAll('.dialog-overlay:not(.hidden):not(.is-behind)')];
}

// ---- Themed confirm / alert (replaces window.confirm and window.alert)
let confirmChain = Promise.resolve();
function showConfirm({ title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, alertOnly = false } = {}) {
  const run = () => new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    const ok = $('confirm-ok'); const cancel = $('confirm-cancel');
    ok.textContent = confirmLabel; cancel.textContent = cancelLabel;
    ok.classList.toggle('danger', danger);
    cancel.style.display = alertOnly ? 'none' : '';
    let settled = false;
    const finish = (value) => {
      if (settled) return; settled = true;
      ok.onclick = null; cancel.onclick = null;
      if (!$('confirmDialog').classList.contains('hidden')) { delete dialogCloseHooks.confirmDialog; closeDialog('confirmDialog'); }
      resolve(value);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    dialogCloseHooks.confirmDialog = () => finish(false);
    openDialog('confirmDialog');
    (danger && !alertOnly ? cancel : ok).focus();
  });
  confirmChain = confirmChain.then(run, run);
  return confirmChain;
}
function showAlert(message, title = 'Drift') {
  return showConfirm({ title, message, confirmLabel: 'OK', alertOnly: true });
}

// ---- Add from Chrome Web Store (modal)
const EXTENSION_ID_RE = /\b[a-p]{32}\b/;
let storeBusy = false;
let storeAbandoned = false;
function setStoreError(message, info = false) {
  const box = $('store-error');
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
  box.classList.toggle('info', !!message && info);
  $('store-input-wrap').classList.toggle('invalid', !!message && !info);
}
function setStoreBusy(busy) {
  storeBusy = busy;
  $('store-input').disabled = busy;
  const submit = $('store-submit');
  submit.disabled = busy;
  submit.innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span><span>Fetching…</span>' : 'Continue';
  $('store-hint').textContent = busy ? 'Contacting the Chrome Web Store…' : 'You’ll review what the extension can access before it is added.';
}
function openStoreDialog() {
  storeAbandoned = false;
  setStoreError('');
  setStoreBusy(false);
  openDialog('storeInstallDialog');
  dialogCloseHooks.storeInstallDialog = () => { if (storeBusy) storeAbandoned = true; };
  setTimeout(() => { $('store-input').focus(); $('store-input').select(); }, 30);
}
async function submitStoreDialog() {
  if (storeBusy) return;
  const value = $('store-input').value.trim();
  if (!value) { setStoreError('Paste a Chrome Web Store link or extension ID.'); $('store-input').focus(); return; }
  if (!EXTENSION_ID_RE.test(value)) { setStoreError('That doesn’t look like a Chrome Web Store link or a 32-letter extension ID.'); $('store-input').focus(); return; }
  setStoreError('');
  setStoreBusy(true);
  const result = await drift.invoke('extensions:install-store', value).catch((error) => ({ error: error.message }));
  const stillOpen = !$('storeInstallDialog').classList.contains('hidden');
  setStoreBusy(false);
  if (result?.ok) {
    $('store-input').value = '';
    if (stillOpen) { delete dialogCloseHooks.storeInstallDialog; closeDialog('storeInstallDialog'); }
    lastPageRenderKey = ''; renderInternalPage(true);
    return;
  }
  if (!stillOpen) return;
  if (result?.cancelled) setStoreError('Nothing was added. You can paste a different link or try again.', true);
  else setStoreError(result?.error || 'The extension could not be installed.');
  $('store-input').focus();
}
$('store-submit').addEventListener('click', submitStoreDialog);
$('store-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submitStoreDialog(); } });
$('store-input').addEventListener('input', () => { if (!$('store-error').classList.contains('hidden')) setStoreError(''); });

// ---- Extension install confirmation (driven by the main process)
const extConfirmQueue = [];
let extConfirm = null;
function permissionIcon(level) {
  return level === 'broad'
    ? '<svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.5h.01"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7"/></svg>';
}
function presentExtensionConfirm(info) {
  extConfirm = info;
  const name = info.name || 'this extension';
  $('ext-confirm-title').textContent = `Add “${name}”?`;
  const meta = ['Chrome Web Store'];
  if (info.version) meta.push(`Version ${info.version}`);
  $('ext-confirm-meta').textContent = meta.join(' · ');
  $('ext-confirm-desc').textContent = info.description || '';
  const icon = $('ext-confirm-icon');
  icon.textContent = '';
  if (info.icon) { const img = document.createElement('img'); img.alt = ''; img.src = info.icon; icon.appendChild(img); }
  else icon.textContent = name.charAt(0).toUpperCase() || 'E';
  const list = $('ext-confirm-perms');
  list.textContent = '';
  const permissions = Array.isArray(info.permissions) ? info.permissions : [];
  if (!permissions.length) {
    const li = document.createElement('li'); li.className = 'ext-perm none'; li.innerHTML = permissionIcon('normal');
    const span = document.createElement('span'); span.textContent = 'It doesn’t ask for any special permissions.'; li.appendChild(span); list.appendChild(li);
  }
  for (const permission of permissions) {
    const li = document.createElement('li'); li.className = `ext-perm ${permission.level === 'broad' ? 'broad' : ''}`;
    li.innerHTML = permissionIcon(permission.level);
    const span = document.createElement('span'); span.textContent = permission.text; li.appendChild(span);
    list.appendChild(li);
  }
  const hasBroad = permissions.some((permission) => permission.level === 'broad');
  const note = $('ext-confirm-note');
  note.classList.toggle('warn', hasBroad);
  note.textContent = hasBroad ? 'Highlighted items give broad access to your browsing. Only add extensions from developers you trust.' : 'Only add extensions from developers you trust.';
  $('storeInstallDialog').classList.toggle('is-behind', !$('storeInstallDialog').classList.contains('hidden'));
  dialogCloseHooks.extensionConfirmDialog = () => answerExtensionConfirm(false);
  openDialog('extensionConfirmDialog');
  $('ext-confirm-allow').focus();
}
function answerExtensionConfirm(allowed) {
  if (!extConfirm) return;
  const { requestId } = extConfirm;
  extConfirm = null;
  drift.manage('extension:confirm-response', requestId, allowed === true);
  delete dialogCloseHooks.extensionConfirmDialog;
  if (!$('extensionConfirmDialog').classList.contains('hidden')) closeDialog('extensionConfirmDialog');
  $('storeInstallDialog').classList.remove('is-behind');
  if (extConfirmQueue.length) setTimeout(() => presentExtensionConfirm(extConfirmQueue.shift()), 60);
}
$('ext-confirm-allow').addEventListener('click', () => answerExtensionConfirm(true));
$('ext-confirm-cancel').addEventListener('click', () => answerExtensionConfirm(false));
drift.on('extension:confirm', (info) => {
  // The user closed the paste dialog while the download was running: treat as cancel.
  if (info?.source === 'pasted-link' && storeAbandoned) { drift.manage('extension:confirm-response', info.requestId, false); return; }
  if (extConfirm) extConfirmQueue.push(info); else presentExtensionConfirm(info);
});
function saveSetting(patch) { drift.manage('settings:update', patch); }
function refreshCurrentPage() { renderInternalPage(); }

// Main-process events are allow-listed by preload.js.
drift.on('state', (next) => { state = next; render(); });
drift.on('focus-address', () => { $('addr').focus(); $('addr').select(); });
// New tab page took focus: empty the address bar and drop its focus/selection.
drift.on('reset-address', () => { $('addr').value = ''; $('addr').blur(); });
drift.on('clear-data:show', () => openClearData());
drift.on('find:show', () => {
  if (!state.find) state.find = {};
  state.find.visible = true; renderFind(); $('find-input').focus(); $('find-input').select();
});

$('omni').addEventListener('submit', (event) => { event.preventDefault(); drift.cmd('go', $('addr').value); $('addr').blur(); });
$('addr').addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('addr').value = state.url || ''; $('addr').blur(); } });
$('addr').addEventListener('focus', () => setTimeout(() => $('addr').select(), 0));
for (const [id, command] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload'], ['reader', 'reader'], ['star', 'bookmark'], ['palette', 'palette'], ['newtab', 'new']]) $(id).addEventListener('click', () => drift.cmd(command));
$('brand').addEventListener('click', () => drift.cmd('new'));
$('tab-spacer').addEventListener('dblclick', () => drift.windowAction('maximize'));
$('bookmarks-toggle').addEventListener('click', () => drift.cmd('bookmarks'));
$('manage-bookmarks').addEventListener('click', () => drift.cmd('bookmarks'));
$('history-btn').addEventListener('click', () => drift.cmd('history'));
$('downloads-btn').addEventListener('click', () => drift.cmd('downloads'));
$('extensions-btn').addEventListener('click', () => drift.cmd('extensions'));
$('protection').addEventListener('click', () => openDialog('adblockDialog'));
$('settings').addEventListener('click', () => drift.cmd('settings'));
$('home').addEventListener('click', () => drift.cmd('home'));
$('find-btn').addEventListener('click', () => drift.cmd('find'));
$('win-minimize').addEventListener('click', () => drift.windowAction('minimize'));
$('win-maximize').addEventListener('click', () => drift.windowAction('maximize'));
$('win-close').addEventListener('click', () => drift.windowAction('close'));
$('adblock-enabled').addEventListener('change', (event) => drift.manage('adblock:toggle', event.target.checked));
$('reset-blocked').addEventListener('click', () => drift.manage('adblock:reset-count'));
$('site-exception-toggle').addEventListener('click', () => { if (state.currentHost) drift.manage('adblock:toggle-site', state.currentHost); });
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (contextMenu && !contextMenu.classList.contains('hidden')) { closeContextMenu(); return; }
    if (!$('findbar').classList.contains('hidden')) { drift.manage('find:close'); return; }
    const open = visibleDialogs();
    if (open.length) { event.preventDefault(); closeDialog(open[open.length - 1].id); }
  } else if (event.key === 'Tab') {
    const open = visibleDialogs();
    if (!open.length) return;
    const focusable = [...open[open.length - 1].querySelectorAll('button:not([disabled]):not(.hidden), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (!open[open.length - 1].contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

$('find-input').addEventListener('input', () => drift.manage('find:query', $('find-input').value, { matchCase: $('find-case').checked }));
$('find-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); drift.manage('find:next', !event.shiftKey); } else if (event.key === 'Escape') drift.manage('find:close'); });
$('find-case').addEventListener('change', () => drift.manage('find:query', $('find-input').value, { matchCase: $('find-case').checked }));
$('find-prev').addEventListener('click', () => drift.manage('find:next', false));
$('find-next').addEventListener('click', () => drift.manage('find:next', true));
$('find-close').addEventListener('click', () => drift.manage('find:close'));

$('page-sidebar').addEventListener('click', (event) => {
  const settingButton = event.target.closest('[data-setting-section]');
  if (settingButton) { currentSettingsSection = settingButton.dataset.settingSection; renderSettingsContent(); $('page-sidebar').innerHTML = pageNavigation(); return; }
  const button = event.target.closest('[data-page]');
  if (!button) return;
  drift.cmd('go', `drift://${button.dataset.page}`);
});
$('page-main').addEventListener('change', (event) => {
  const id = event.target.id;
  if (id === 'bookmark-folder-filter') { bookmarkFolderFilter = event.target.value; renderBookmarksPage(); lastPageRenderKey = currentPageRenderKey(); }
  else if (event.target.name === 'appearance-mode') {
    state.settings = { ...state.settings, appearance: event.target.value }; applySettings(); // instant preview, main confirms below
    saveSetting({ appearance: event.target.value });
  }
  else if (event.target.name === 'startup-mode') saveSetting({ startupMode: event.target.value });
  else if (id === 'homepage-setting') {
    const value = event.target.value.trim();
    event.target.classList.toggle('invalid', !!value && !looksLikeUrl(value));
    if (!value || looksLikeUrl(value)) saveSetting({ homepage: value });
  }
  else if (id === 'show-home-setting') saveSetting({ showHomeButton: event.target.checked });
  else if (id === 'window-start-setting') saveSetting({ windowStart: event.target.value });
  else if (id === 'launch-login-setting') saveSetting({ launchAtLogin: event.target.checked });
  else if (id === 'newtab-opens-setting') saveSetting({ newTabOpens: event.target.value });
  else if (id === 'newtab-shortcuts-setting') saveSetting({ newTabShortcuts: event.target.value });
  else if (id === 'newtab-clock-setting') saveSetting({ newTabClock: event.target.checked });
  else if (id === 'search-setting') saveSetting({ searchEngine: event.target.value });
  else if (id === 'show-bookmarks-setting') saveSetting({ showBookmarksBar: event.target.checked });
  else if (id === 'ask-save-setting') saveSetting({ askWhereToSave: event.target.checked });
  else if (id === 'settings-adblock') drift.manage('adblock:toggle', event.target.checked);
});
$('page-main').addEventListener('click', (event) => {
  const sectionLink = event.target.closest('[data-setting-section-link]');
  if (sectionLink) { currentSettingsSection = sectionLink.dataset.settingSectionLink; renderSettingsContent(); $('page-sidebar').innerHTML = pageNavigation(); return; }
  const themeButton = event.target.closest('button[data-color-theme]'); // not <html>, which also carries data-color-theme
  if (themeButton) {
    saveSetting({ colorTheme: themeButton.dataset.colorTheme });
    document.documentElement.dataset.colorTheme = themeButton.dataset.colorTheme;
    document.querySelectorAll('[data-color-theme]').forEach((button) => {
      const active = button.dataset.colorTheme === themeButton.dataset.colorTheme;
      button.classList.toggle('selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('.theme-check')?.remove();
      if (active) button.insertAdjacentHTML('beforeend', '<span class="theme-check">✓</span>');
    });
  }
});
$('page-main').addEventListener('input', (event) => {
  if (event.target.classList?.contains('page-input')) event.target.classList.remove('invalid');
  if (event.target.id === 'bookmark-search') { bookmarkFilter = event.target.value; const start = event.target.selectionStart; renderBookmarksPage(); lastPageRenderKey = currentPageRenderKey(); $('bookmark-search').focus(); $('bookmark-search').setSelectionRange(start, start); }
  if (event.target.id === 'history-search') { historyFilter = event.target.value; const start = event.target.selectionStart; renderHistoryPage(); lastPageRenderKey = currentPageRenderKey(); $('history-search').focus(); $('history-search').setSelectionRange(start, start); }
});
$('page-main').addEventListener('submit', (event) => {
  if (event.target.id === 'startup-add-form') {
    event.preventDefault();
    const input = $('startup-add-input');
    const value = input.value.trim();
    if (!value) return;
    if (!looksLikeUrl(value)) { input.classList.add('invalid'); input.focus(); return; }
    saveSetting({ startupPages: [...(state.settings.startupPages || []), value] });
    return;
  }
  if (event.target.id !== 'add-bookmark-form') return;
  event.preventDefault();
  const title = $('new-bookmark-title').value.trim();
  const url = $('new-bookmark-url').value.trim();
  const folder = $('new-bookmark-folder').value.trim();
  if (!/^https?:\/\//i.test(url)) { $('new-bookmark-url').focus(); return; }
  drift.manage('bookmark:add', title || url, url, folder);
  bookmarkFilter = '';
  bookmarkFolderFilter = folder;
  event.target.reset(); event.target.classList.add('hidden'); event.target.dataset.open = '';
});
$('page-main').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'open-protection') openDialog('adblockDialog');
  else if (action === 'startup-use-open-tabs') drift.cmd('startup-use-open-tabs');
  else if (action === 'remove-startup-page') {
    const pages = [...(state.settings.startupPages || [])];
    pages.splice(Number(button.dataset.index), 1);
    saveSetting({ startupPages: pages });
  }
  else if (action === 'open-profile-folder') drift.cmd('open-profile-folder');
  else if (action === 'choose-download-folder') {
    const folder = await drift.invoke('downloads:choose-folder').catch(() => null);
    if (folder) renderInternalPage();
  } else if (action === 'install-extension') {
    button.disabled = true; button.textContent = 'Selecting folder…';
    const result = await drift.invoke('extensions:install').catch((error) => ({ error: error.message }));
    if (result?.error) await showAlert(result.error, 'Couldn’t install extension');
    lastPageRenderKey = ''; renderInternalPage(true);
  } else if (action === 'browse-web-store') {
    drift.cmd('new', 'https://chromewebstore.google.com/category/extensions');
  } else if (action === 'open-store-dialog') {
    openStoreDialog();
  } else if (action === 'remove-extension') {
    const extension = (state.extensions || []).find((entry) => entry.id === button.dataset.id);
    const confirmed = await showConfirm({
      title: `Remove “${extension?.name || 'this extension'}”?`,
      message: 'It will be removed from Drift and stop running on your pages.',
      confirmLabel: 'Remove', danger: true
    });
    if (!confirmed) return;
    const result = await drift.invoke('extensions:remove', button.dataset.id).catch((error) => ({ error: error.message }));
    if (result?.error) await showAlert(result.error, 'Couldn’t remove extension');
  } else if (action === 'clear-history') {
    openClearData({ types: ['history'] });
  } else if (action === 'clear-data') {
    openClearData();
  } else if (action === 'remove-history') drift.manage('history:remove', button.dataset.id);
  else if (action === 'open-history' || action === 'open-bookmark') drift.cmd('new', button.dataset.url);
  else if (action === 'remove-bookmark') drift.manage('bookmark:remove', button.dataset.url);
  else if (action === 'save-bookmark') {
    const row = button.closest('.bookmark-manager-row');
    const title = row.querySelector('.bookmark-title').value.trim();
    const url = row.querySelector('.bookmark-url').value.trim();
    if (!title || !/^https?:\/\//i.test(url)) { await showAlert('Enter a title and a valid http or https URL.', 'Check the bookmark'); return; }
    drift.manage('bookmark:update', button.dataset.url, title, url, row.querySelector('.bookmark-folder')?.value || '');
  } else if (action === 'focus-add-bookmark') {
    const form = $('add-bookmark-form'); form.classList.toggle('hidden'); form.dataset.open = form.classList.contains('hidden') ? '' : '1';
    if (!form.classList.contains('hidden')) $('new-bookmark-url').focus();
  } else if (action === 'clear-downloads') await drift.invoke('downloads:clear');
  else if (action.startsWith('download-')) drift.manage('downloads:action', button.dataset.id, action.slice('download-'.length));
});

// Browser chrome context menus. Native web-content menus are handled by the
// Electron main process; these menus cover tabs, bookmarks, and browser chrome.
const contextMenu = $('browser-context-menu');
function closeContextMenu() {
  contextMenu.classList.add('hidden');
  contextMenu.replaceChildren();
  contextTarget = null;
}
function contextItem(label, action, options = {}) {
  if (options.separator) return '<div class="context-separator" role="separator"></div>';
  return `<button type="button" class="context-menu-item ${options.danger ? 'danger' : ''}" role="menuitem" data-context-action="${action}" ${options.disabled ? 'disabled' : ''}><span>${label}</span>${options.shortcut ? `<kbd>${options.shortcut}</kbd>` : ''}</button>`;
}
function showContextMenu(event, items, target = null) {
  event.preventDefault();
  event.stopPropagation();
  contextTarget = target;
  contextMenu.innerHTML = items.join('');
  contextMenu.classList.remove('hidden');
  const margin = 8;
  const width = contextMenu.offsetWidth;
  const height = contextMenu.offsetHeight;
  const x = Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin));
  const y = Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin));
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
}
function tabContextItems() {
  return [
    contextItem('New tab', 'new-tab', { shortcut: 'Ctrl+T' }),
    contextItem('Reload tab', 'reload-tab', { shortcut: 'Ctrl+R' }),
    contextItem('Duplicate tab', 'duplicate-tab'),
    contextItem('', '', { separator: true }),
    contextItem('Close tab', 'close-tab', { shortcut: 'Ctrl+W' }),
    contextItem('Close other tabs', 'close-other-tabs'),
    contextItem('Close tabs to the right', 'close-tabs-right')
  ];
}
function bookmarkContextItems() {
  return [
    contextItem('Open bookmark', 'open-bookmark'),
    contextItem('Open in new tab', 'open-bookmark-new'),
    contextItem('', '', { separator: true }),
    contextItem('Manage bookmarks', 'manage-bookmarks'),
    contextItem('Remove bookmark', 'remove-bookmark', { danger: true })
  ];
}
document.addEventListener('contextmenu', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) { showContextMenu(event, tabContextItems(), { type: 'tab', id: tab._id }); return; }
  // Keep the platform's native edit menu for address/search and manager fields.
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const bookmark = event.target.closest('.bookmark-link');
  if (bookmark) {
    const url = bookmark.dataset.url || bookmark.title.split('\n').at(-1);
    showContextMenu(event, bookmarkContextItems(), { type: 'bookmark', url });
    return;
  }
  const bookmarkRow = event.target.closest('.bookmark-manager-row');
  if (bookmarkRow) {
    showContextMenu(event, bookmarkContextItems(), { type: 'bookmark', url: bookmarkRow.dataset.bookmarkUrl });
    return;
  }
  if (event.target.closest('#browser-context-menu')) return;
  const pageItems = [
    contextItem('New tab', 'new-tab', { shortcut: 'Ctrl+T' }),
    contextItem('Reload page', 'reload-page', { shortcut: 'Ctrl+R' }),
    contextItem('', '', { separator: true }),
    contextItem('Back', 'go-back', { disabled: !state.canBack, shortcut: 'Alt+←' }),
    contextItem('Forward', 'go-forward', { disabled: !state.canForward, shortcut: 'Alt+→' }),
    contextItem(state.bookmarked ? 'Remove bookmark' : 'Bookmark this page', 'bookmark-page', { disabled: !state.url }),
    contextItem('', '', { separator: true }),
    contextItem('Bookmarks', 'manage-bookmarks'),
    contextItem('History', 'open-history'),
    contextItem('Downloads', 'open-downloads'),
    contextItem('Settings', 'open-settings')
  ];
  showContextMenu(event, pageItems, { type: 'page' });
});
contextMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-context-action]');
  if (!button || button.disabled) return;
  const target = contextTarget;
  const tab = target?.type === 'tab' ? state.tabs.find((item) => item.id === target.id) : null;
  const url = target?.url || '';
  closeContextMenu();
  switch (button.dataset.contextAction) {
    case 'new-tab': drift.cmd('new'); break;
    case 'reload-tab': if (tab) drift.cmd('reload', tab.id); break;
    case 'duplicate-tab': if (tab) drift.cmd('new', tab.url); break;
    case 'close-tab': if (tab) drift.cmd('close', tab.id); break;
    case 'close-other-tabs': if (tab) drift.cmd('close-others', tab.id); break;
    case 'close-tabs-right': if (tab) drift.cmd('close-right', tab.id); break;
    case 'open-bookmark': if (url) drift.cmd('go', url); break;
    case 'open-bookmark-new': if (url) drift.cmd('new', url); break;
    case 'remove-bookmark': if (url) drift.manage('bookmark:remove', url); break;
    case 'reload-page': drift.cmd('reload'); break;
    case 'go-back': drift.cmd('back'); break;
    case 'go-forward': drift.cmd('forward'); break;
    case 'bookmark-page': drift.cmd('bookmark'); break;
    case 'manage-bookmarks': drift.cmd('bookmarks'); break;
    case 'open-history': drift.cmd('history'); break;
    case 'open-downloads': drift.cmd('downloads'); break;
    case 'open-settings': drift.cmd('settings'); break;
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#browser-context-menu')) closeContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !contextMenu.classList.contains('hidden')) { closeContextMenu(); return; }
  if (contextMenu.classList.contains('hidden')) return;
  const items = [...contextMenu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
    items[nextIndex]?.focus();
  }
});

// Render immediately so the browser chrome never flashes an unstyled shell.
render();

// Clear browsing data dialog wiring
document.querySelectorAll('[data-clear-tab]').forEach((tab) => tab.addEventListener('click', () => { clearUi.tab = tab.dataset.clearTab; renderClearData(); }));
$('clear-range').addEventListener('change', (event) => { clearUi.range = event.target.value; renderClearData(); });
$('clear-options').addEventListener('change', (event) => {
  const box = event.target.closest('[data-clear-type]');
  if (!box) return;
  if (box.checked) clearUi.selected.add(box.dataset.clearType); else clearUi.selected.delete(box.dataset.clearType);
  renderClearData();
});
$('clear-submit').addEventListener('click', submitClearData);
