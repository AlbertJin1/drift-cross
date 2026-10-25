const { app, BaseWindow, WebContentsView, Menu, ipcMain, session, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------- config
const IS_WINDOWS = process.platform === 'win32';
const CHROME_H_WITH_BOOKMARKS = IS_WINDOWS ? 142 : 120; // browser chrome rows, including the custom Windows titlebar
const CHROME_H_WITHOUT_BOOKMARKS = IS_WINDOWS ? 114 : 92;
const IDLE_DISCARD_MS = 5 * 60 * 1000;
const NEWTAB = pathToFileURL(path.join(__dirname, 'ui', 'newtab.html')).href;
const SETTINGS_FILE = 'settings.json';

// Network-level block rules. Keep these as host rules (rather than broad URL
// substrings) to reduce false positives and avoid breaking first-party assets.
const BLOCKED_HOSTS = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'adservice.google.com', 'adservice.google.co.uk', 'ads.google.com',
  'pagead2.googlesyndication.com', 'partner.googleadservices.com', 'adnxs.com', 'adsrvr.org',
  'advertising.com', 'adform.net', 'adform.com', 'adroll.com', 'adroll.net', 'amazon-adsystem.com',
  'amplitude.com', 'analytics.tiktok.com', 'app-measurement.com', 'bidswitch.net', 'bluekai.com',
  'branch.io', 'casalemedia.com', 'chartbeat.com', 'clickagy.com', 'clicktale.net',
  'criteo.com', 'criteo.net', 'demdex.net', 'everesttech.net', 'exelator.com', 'eyeota.net',
  'facebook.net', 'fastclick.net', 'flashtalking.com', 'getclicky.com',
  'hotjar.com', 'hotjar.io', 'imrworldwide.com', 'lijit.com', 'liveintent.com',
  'mathtag.com', 'mixpanel.com', 'moatads.com', 'monetate.net', 'mookie1.com',
  'nielsen.com', 'omtrdc.net', 'openx.net', 'outbrain.com', 'parsely.com', 'perfectmarket.com',
  'pippio.com', 'pixel.quantserve.com', 'pubmatic.com', 'quantserve.com', 'realsrv.com',
  'rlcdn.com', 'scorecardresearch.com', 'segment.io', 'segment.com', 'serving-sys.com',
  'sharethrough.com', 'simpli.fi', 'sitescout.com', 'smartadserver.com', 'smaato.net',
  'snap.licdn.com', 'taboola.com', 'teads.tv', 'triplelift.com',
  'uciservice.com', 'visualrevenue.com', 'w55c.net', 'webengage.com', 'yieldmo.com',
  'zedo.com', 'zemanta.com', 'addthis.com', 'adcolony.com', 'adgrx.com', 'adition.com',
  'adkernel.com', 'admanmedia.com', 'admixer.net', 'adpushup.com', 'adsafeprotected.com',
  'ad-stir.com', 'advertising.naver.com', 'adzerk.net', 'appsflyer.com', 'adjust.com',
  'branch.io', 'burt.com', 'commander1.com', 'conversantmedia.com', 'dianomi.com',
  'districtm.io', 'doubleverify.com', 'fout.jp', 'geniee.jp', 'inmobi.com',
  'innovid.com', 'integralads.com', 'justpremium.com', 'kochava.com', 'krxd.net',
  'loopme.com', 'mgid.com', 'onetag-sys.com', 'owneriq.net', 'powerlinks.com', 'revcontent.com',
  'rubiconproject.com', 'shareaholic.com', 'springserve.com', 'undertone.com', 'unrulymedia.com',
  'videologygroup.com', 'zedo.com', 'ad.360yield.com', 'ads.yahoo.com', 'analytics.yahoo.com'
]);

const READER_JS = String.raw`(() => {
  const src = document.querySelector('article') || document.querySelector('main') || document.body;
  const box = document.createElement('div');
  src.querySelectorAll('h1,h2,h3,p,blockquote,li,img').forEach(e => {
    let n;
    if (e.tagName === 'IMG') { n = document.createElement('img'); n.src = e.src; n.alt = e.alt || ''; }
    else { if (!e.innerText.trim()) return; n = document.createElement(e.tagName); n.textContent = e.innerText; }
    box.appendChild(n);
  });
  document.querySelectorAll('link[rel=stylesheet],style').forEach(x => x.remove());
  document.body.replaceChildren(box);
  const s = document.createElement('style');
  s.textContent = 'body{max-width:720px;margin:40px auto;padding:0 24px;font:19px/1.75 Georgia,serif;background:#faf8f3;color:#20212a}img{max-width:100%;height:auto}h1,h2,h3{line-height:1.25}';
  document.head.appendChild(s);
})();`;

// ---------------------------------------------------------------- storage
const file = (f) => path.join(app.getPath('userData'), f);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(file(f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const target = file(f);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(v, null, 2));
    fs.renameSync(temp, target);
  } catch { /* non-fatal: a browser session should remain usable if storage is read-only */ }
};

// ---------------------------------------------------------------- state
let win, ui, palette;
let nextId = 1;
let lastWindowTitle = '';
let paletteOpen = false;
let uiOverlayOpen = false;
let blockedCount = 0;
let bookmarks = [];
let bookmarksSortedCache = null;
let history = [];
let adBlockEnabled = true;
let allowlistedSites = [];
let appearance = 'system';
let searchEngine = 'duckduckgo';
let restoreSession = true;
let showBookmarksBar = true;
let blockedHostCounts = Object.create(null);
const spaces = ['Home', 'Work', 'Fun'].map((name) => ({ name, tabs: [], active: null }));
let cur = spaces[0];
const activeTab = () => cur.active;

// ---------------------------------------------------------------- helpers
function resolve(input) {
  const t = String(input || '').trim();
  if (!t) return NEWTAB;
  if (/^(https?|file|about|data):/i.test(t)) return t;
  if (/^localhost(?::\d+)?(?:\/|$)/i.test(t) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/i.test(t)) return 'http://' + t;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && t.includes('.')) return 'https://' + t;
  const engines = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    google: 'https://www.google.com/search?q=',
    bing: 'https://www.bing.com/search?q=',
    brave: 'https://search.brave.com/search?q='
  };
  return (engines[searchEngine] || engines.duckduckgo) + encodeURIComponent(t);
}

function hostnameOf(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

function hostMatches(host, domain) {
  return !!host && (host === domain || host.endsWith('.' + domain));
}

function isSiteAllowed(host) {
  return allowlistedSites.some((site) => hostMatches(host, site));
}

function liveUrl(tab) {
  if (!tab) return '';
  try {
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      const url = tab.view.webContents.getURL();
      if (url && url !== 'about:blank') {
        tab.url = url;
        return url;
      }
    }
  } catch { /* the tab may be in the process of being discarded */ }
  return tab.url || '';
}

function currentHost() {
  const url = liveUrl(activeTab());
  return url && url !== NEWTAB ? hostnameOf(url) : '';
}

function chromeHeight() {
  return showBookmarksBar ? CHROME_H_WITH_BOOKMARKS : CHROME_H_WITHOUT_BOOKMARKS;
}

function tabBounds() {
  const { width, height } = win.getContentBounds();
  const chromeHeightNow = chromeHeight();
  return { x: 0, y: chromeHeightNow, width: Math.max(0, width), height: Math.max(0, height - chromeHeightNow) };
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  ui?.setBounds({ x: 0, y: 0, width, height });
  palette?.setBounds({ x: 0, y: 0, width, height });
  for (const s of spaces) for (const t of s.tabs) t.view?.setBounds(tabBounds());
}

// ---------------------------------------------------------------- state -> UI
function snapshot() {
  const t = activeTab();
  const activeUrl = liveUrl(t);
  const nav = t?.view?.webContents.navigationHistory;
  const host = currentHost();
  return {
    spaces: spaces.map((s) => s.name),
    space: cur.name,
    tabs: cur.tabs.map((x) => ({ id: x.id, title: x.title, favicon: x.favicon, loading: x.loading, active: x === cur.active })),
    url: activeUrl && activeUrl !== NEWTAB ? activeUrl : '',
    loading: !!t?.loading,
    canBack: !!nav?.canGoBack(),
    canForward: !!nav?.canGoForward(),
    bookmarked: !!t && bookmarks.some((b) => b.url === activeUrl),
    bookmarks: sortedBookmarks(),
    blocked: blockedCount,
    adBlockEnabled,
    currentHost: host,
    siteAllowed: isSiteAllowed(host),
    blockedHosts: Object.entries(blockedHostCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hostName, count]) => ({ host: hostName, count })),
    settings: { appearance, searchEngine, restoreSession, showBookmarksBar },
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    isMaximized: !!win?.isMaximized?.()
  };
}

let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('state', snapshot());
    const t = activeTab();
    const title = (t?.title || 'New tab') + ' — Drift';
    if (win && !win.isDestroyed() && title !== lastWindowTitle) {
      lastWindowTitle = title;
      win.setTitle(title);
    }
  }, 50);
}

let sessionTimer = null;
function saveSessionNow() {
  writeJson('session.json', {
    space: cur.name,
    spaces: spaces.map((s) => ({
      name: s.name,
      active: s.tabs.indexOf(s.active),
      tabs: s.tabs.map((t) => ({ title: t.title, url: t.url, favicon: t.favicon }))
    }))
  });
}
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSessionNow, 350);
}

function addHistory(title, url) {
  if (!/^https?:/i.test(url || '')) return;
  history = history.filter((h) => h.url !== url);
  history.push({ title: title || url, url });
  if (history.length > 500) history.shift();
  writeJson('history.json', history);
}

function sortedBookmarks() {
  if (!bookmarksSortedCache) bookmarksSortedCache = bookmarks.slice().sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url));
  return bookmarksSortedCache;
}
function persistBookmarks() { bookmarksSortedCache = null; writeJson('bookmarks.json', bookmarks); }
function persistSettings() { writeJson(SETTINGS_FILE, { adBlockEnabled, allowlistedSites, appearance, searchEngine, restoreSession, showBookmarksBar }); }

// ---------------------------------------------------------------- tabs
function attachView(tab) {
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: true } });
  tab.view = view;
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  view.setBounds(tabBounds());
  view.setVisible(false);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => { createTab(url); return { action: 'deny' }; });
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title || 'New tab';
    let changedBookmark = false;
    for (const b of bookmarks) {
      if (b.url === tab.url && b.title !== tab.title) { b.title = tab.title; changedBookmark = true; }
    }
    if (changedBookmark) persistBookmarks();
    const h = history.find((x) => x.url === tab.url);
    if (h) { h.title = tab.title; writeJson('history.json', history); }
    push();
    saveSession();
  });
  wc.on('page-favicon-updated', (_e, favicons) => { tab.favicon = favicons?.[0] || ''; push(); saveSession(); });
  wc.on('did-start-loading', () => { tab.loading = true; push(); });
  wc.on('did-stop-loading', () => { tab.url = wc.getURL() || tab.url; tab.title = wc.getTitle() || tab.title; tab.loading = false; push(); saveSession(); });
  wc.on('did-start-navigation', (_e, url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = url;
    tab.loading = true;
    push();
    saveSession();
  });
  wc.on('did-redirect-navigation', (_e, url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = url;
    if (tab === activeTab()) push();
    saveSession();
  });
  wc.on('did-navigate', (_e, url) => {
    tab.url = wc.getURL() || url;
    tab.title = wc.getTitle() || tab.title;
    addHistory(tab.title, url);
    push();
    saveSession();
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) { tab.url = wc.getURL() || url; push(); saveSession(); }
  });
  wc.on('did-fail-load', (_e, errorCode, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    tab.loading = false;
    tab.title = 'Could not load page';
    push();
    saveSession();
  });
  wc.on('render-process-gone', () => {
    tab.loading = false;
    tab.title = 'Page stopped responding';
    push();
    saveSession();
  });
  return wc;
}

function safelyLoad(wc, url) {
  wc.loadURL(url).catch(() => { /* did-fail-load updates the chrome; avoid unhandled rejections */ });
}

function createTab(input) {
  const tab = { id: nextId++, title: 'New tab', url: input ? resolve(input) : NEWTAB, favicon: '', loading: false, lastActive: Date.now(), view: null };
  cur.tabs.push(tab);
  activateTab(tab);
  saveSession();
  if (!input) focusAddress();
  return tab;
}

function activateTab(tab) {
  if (!cur.tabs.includes(tab)) return;
  for (const t of cur.tabs) t.view?.setVisible(false);
  if (!tab.view) safelyLoad(attachView(tab), tab.url || NEWTAB);
  cur.active = tab;
  tab.url = liveUrl(tab) || tab.url;
  tab.lastActive = Date.now();
  tab.view.setBounds(tabBounds());
  tab.view.setVisible(true);
  if (!paletteOpen) tab.view.webContents.focus();
  push();
  saveSession();
}

function destroyView(tab) {
  if (!tab.view) return;
  try { win.contentView.removeChildView(tab.view); } catch { /* already detached */ }
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  tab.view = null;
}

function closeTab(tab) {
  const i = cur.tabs.indexOf(tab);
  if (i < 0) return;
  cur.tabs.splice(i, 1);
  destroyView(tab);
  if (!cur.tabs.length) { cur.active = null; createTab(); return; }
  if (cur.active === tab) activateTab(cur.tabs[Math.min(i, cur.tabs.length - 1)]);
  else { push(); saveSession(); }
}

function switchSpace(space) {
  if (space === cur) return;
  for (const t of cur.tabs) t.view?.setVisible(false);
  cur = space;
  if (!cur.tabs.length) createTab(); else activateTab(cur.active || cur.tabs[0]);
  push();
  saveSession();
}

function go(text) {
  const url = resolve(text);
  const t = activeTab();
  if (t?.view) {
    t.url = url; // update the address bar immediately rather than waiting for redirect events
    t.title = 'Loading…';
    t.loading = true;
    t.lastActive = Date.now();
    push();
    saveSession();
    safelyLoad(t.view.webContents, url);
    t.view.webContents.focus();
  } else createTab(text);
}

function toggleBookmark() {
  const t = activeTab();
  if (!t || !t.url || t.url === NEWTAB || !/^https?:/i.test(t.url)) return;
  const i = bookmarks.findIndex((b) => b.url === t.url);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.push({ title: t.title && t.title !== 'Loading…' ? t.title : hostnameOf(t.url), url: t.url, addedAt: Date.now() });
  persistBookmarks();
  push();
}

function updateBookmark(url, title, newUrl) {
  const b = bookmarks.find((item) => item.url === url);
  if (!b) return;
  const cleanTitle = String(title || '').trim().slice(0, 240);
  let cleanUrl = String(newUrl || url).trim();
  try {
    const parsed = new URL(cleanUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return;
    cleanUrl = parsed.href;
  } catch { return; }
  if (bookmarks.some((item) => item !== b && item.url === cleanUrl)) return;
  if (cleanTitle) b.title = cleanTitle;
  b.url = cleanUrl;
  persistBookmarks();
  push();
}

function removeBookmark(url) {
  const before = bookmarks.length;
  bookmarks = bookmarks.filter((item) => item.url !== url);
  if (bookmarks.length !== before) { persistBookmarks(); push(); }
}

// Free memory by discarding inactive, silent tabs. Their URL/session metadata
// remains, and the WebContents is recreated only when that tab is selected.
function discardIdleTabs() {
  for (const s of spaces) {
    for (const t of s.tabs) {
      const visible = s === cur && t === cur.active;
      if (t.view && !visible && Date.now() - t.lastActive > IDLE_DISCARD_MS && !t.view.webContents.isCurrentlyAudible()) {
        destroyView(t);
      }
    }
  }
}

// ---------------------------------------------------------------- palette
function openPalette() {
  paletteOpen = true;
  if (!palette) {
    // Load the palette only on first use to reduce cold-start WebContents work.
    const palettePrefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true };
    palette = new WebContentsView({ webPreferences: palettePrefs });
    palette.setBackgroundColor('#00000000');
    palette.webContents.on('will-navigate', (e) => e.preventDefault());
    palette.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.contentView.addChildView(palette);
    const { width, height } = win.getContentBounds();
    palette.setBounds({ x: 0, y: 0, width, height });
    palette.setVisible(false);
    palette.webContents.once('did-finish-load', () => {
      if (!paletteOpen || !palette) return;
      win.contentView.addChildView(palette);
      layout();
      palette.setVisible(true);
      palette.webContents.focus();
      palette.webContents.send('palette:open');
    });
    palette.webContents.loadFile(path.join(__dirname, 'ui', 'palette.html')).catch(() => {
      paletteOpen = false;
    });
    return;
  }
  win.contentView.addChildView(palette);
  layout();
  if (palette.webContents.isLoading()) {
    palette.webContents.once('did-finish-load', () => {
      if (!paletteOpen) return;
      palette.setVisible(true);
      palette.webContents.focus();
      palette.webContents.send('palette:open');
    });
  } else {
    palette.setVisible(true);
    palette.webContents.focus();
    palette.webContents.send('palette:open');
  }
}
function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  palette?.setVisible(false);
  activeTab()?.view?.webContents.focus();
}

function focusAddress() {
  ui?.webContents.focus();
  ui?.webContents.send('focus-address');
}

ipcMain.handle('palette:query', (_e, query) => {
  const q = String(query || '').trim();
  const needle = q.toLowerCase();
  const hit = (...fields) => !q || fields.some((f) => f && String(f).toLowerCase().includes(needle));
  const out = [];
  if (q) out.push({ kind: 'go', label: `Go or search “${q}”`, sub: resolve(q), act: { type: 'go', text: q } });
  for (const s of spaces) for (const t of s.tabs)
    if (hit(t.title, t.url)) out.push({ kind: 'tab', label: t.title || t.url, sub: `${s.name} · open tab`, act: { type: 'tab', id: t.id } });
  bookmarks.filter((b) => hit(b.title, b.url)).slice(0, 6)
    .forEach((b) => out.push({ kind: 'bookmark', label: b.title || b.url, sub: b.url, act: { type: 'go', text: b.url } }));
  if (q) [...history].reverse().filter((h) => hit(h.title, h.url)).slice(0, 5)
    .forEach((h) => out.push({ kind: 'history', label: h.title, sub: h.url, act: { type: 'go', text: h.url } }));
  const commands = [
    ['New tab', 'new'], ['Close tab', 'close'], ['Reader mode', 'reader'],
    ['Bookmark or unbookmark this page', 'bookmark'], ['Open bookmarks manager', 'bookmarks'],
    ['Toggle ad blocker', 'adblock'], ['Developer tools', 'devtools'],
    ...spaces.map((s) => [`Switch to ${s.name}`, 'space:' + s.name])
  ];
  commands.filter(([label]) => hit(label)).forEach(([label, name]) => out.push({ kind: 'command', label, sub: 'Command', act: { type: 'cmd', name } }));
  return out.slice(0, 14);
});

ipcMain.on('palette:run', (_e, act) => {
  closePalette();
  if (!act) return;
  if (act.type === 'go') go(act.text);
  else if (act.type === 'tab') {
    for (const s of spaces) {
      const t = s.tabs.find((x) => x.id === act.id);
      if (t) { switchSpace(s); activateTab(t); break; }
    }
  } else if (act.type === 'cmd') {
    if (act.name.startsWith('space:')) command('space', act.name.slice(6)); else command(act.name);
  }
});

function setUIOverlay(open) {
  if (!win || !ui || ui.webContents.isDestroyed()) return;
  uiOverlayOpen = !!open;
  if (uiOverlayOpen) {
    // The chrome WebContents is normally below the page views. Lift it above
    // the active page only while a modal is open; its transparent background
    // lets the page show through the scrim instead of being painted over.
    win.contentView.addChildView(ui);
    const { width, height } = win.getContentBounds();
    ui.setBounds({ x: 0, y: 0, width, height });
    ui.webContents.focus();
  } else {
    const active = activeTab();
    if (active?.view) {
      win.contentView.addChildView(active.view);
      active.view.setBounds(tabBounds());
      active.view.setVisible(true);
      active.view.webContents.focus();
    }
  }
}

// ---------------------------------------------------------------- commands
function command(name, arg) {
  const t = activeTab();
  const wc = t?.view?.webContents;
  switch (name) {
    case 'new': createTab(arg); break;
    case 'close': { const target = arg ? cur.tabs.find((x) => x.id === arg) : t; if (target) closeTab(target); break; }
    case 'activate': { const target = cur.tabs.find((x) => x.id === arg); if (target) activateTab(target); break; }
    case 'space': { const s = spaces.find((x) => x.name === arg); if (s) switchSpace(s); break; }
    case 'go': go(arg); break;
    case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': wc?.reload(); break;
    case 'reader': wc?.executeJavaScript(READER_JS).catch(() => {}); break;
    case 'bookmark': toggleBookmark(); break;
    case 'bookmarks': ui?.webContents.send('open-bookmarks'); break;
    case 'settings': ui?.webContents.send('open-settings'); break;
    case 'adblock': adBlockEnabled = !adBlockEnabled; persistSettings(); push(); break;
    case 'adblock-settings': ui?.webContents.send('open-adblock'); break;
    case 'overlay-open': setUIOverlay(true); break;
    case 'overlay-close': setUIOverlay(false); break;
    case 'devtools': wc?.toggleDevTools(); break;
    case 'palette': if (paletteOpen) closePalette(); else openPalette(); break;
    case 'closePalette': closePalette(); break;
    case 'address': focusAddress(); break;
  }
}
ipcMain.on('cmd', (_e, name, arg) => command(name, arg));

ipcMain.on('bookmark:update', (_e, url, title, newUrl) => updateBookmark(String(url || ''), title, newUrl));
ipcMain.on('bookmark:remove', (_e, url) => removeBookmark(String(url || '')));
ipcMain.on('adblock:toggle', (_e, enabled) => {
  adBlockEnabled = !!enabled;
  persistSettings();
  push();
});
ipcMain.on('adblock:toggle-site', (_e, rawHost) => {
  const host = String(rawHost || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return;
  if (isSiteAllowed(host)) allowlistedSites = allowlistedSites.filter((site) => !hostMatches(site, host) && !hostMatches(host, site));
  else allowlistedSites.push(host);
  allowlistedSites = [...new Set(allowlistedSites)].slice(-300);
  persistSettings();
  push();
});
ipcMain.on('adblock:reset-count', () => { blockedCount = 0; blockedHostCounts = Object.create(null); push(); });

ipcMain.on('settings:update', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  if (['system', 'light', 'dark'].includes(patch.appearance)) appearance = patch.appearance;
  if (['duckduckgo', 'google', 'bing', 'brave'].includes(patch.searchEngine)) searchEngine = patch.searchEngine;
  if (typeof patch.restoreSession === 'boolean') restoreSession = patch.restoreSession;
  if (typeof patch.showBookmarksBar === 'boolean') showBookmarksBar = patch.showBookmarksBar;
  persistSettings();
  layout();
  push();
});

ipcMain.on('window:action', (_e, action) => {
  if (!win || win.isDestroyed() || !IS_WINDOWS) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
  push();
});

function buildMenu() {
  const mac = process.platform === 'darwin';
  const item = (label, accelerator, name, arg) => ({ label, accelerator, click: () => command(name, arg) });
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'Browser', submenu: [
      item('Command palette', 'CmdOrCtrl+K', 'palette'), item('New tab', 'CmdOrCtrl+T', 'new'),
      item('Close tab', 'CmdOrCtrl+W', 'close'), item('Address bar', 'CmdOrCtrl+L', 'address'),
      item('Bookmark page', 'CmdOrCtrl+D', 'bookmark'), item('Bookmarks manager', 'CmdOrCtrl+Shift+B', 'bookmarks'),
      item('Reload', 'CmdOrCtrl+R', 'reload'), item('Back', mac ? 'Cmd+[' : 'Alt+Left', 'back'),
      item('Forward', mac ? 'Cmd+]' : 'Alt+Right', 'forward'), item('Reader mode', 'CmdOrCtrl+Shift+R', 'reader'),
      item('Toggle ad blocker', 'CmdOrCtrl+Shift+A', 'adblock'), { type: 'separator' },
      ...spaces.map((s, i) => item(`Space: ${s.name}`, `CmdOrCtrl+${i + 1}`, 'space', s.name)),
      { type: 'separator' }, item('Settings', 'CmdOrCtrl+,', 'settings'), item('Developer tools', 'F12', 'devtools')
    ]},
    { role: 'editMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app
function setupSession() {
  const ses = session.defaultSession;
  // Remove the Electron product token, leaving Chromium's platform UA intact.
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sdrift\/\S+/i, ''));
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission)));
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!adBlockEnabled || details.resourceType === 'mainFrame') return callback({});
    let targetHost = '';
    try { targetHost = new URL(details.url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return callback({}); }
    const initiatorHost = hostnameOf(details.initiator || details.referrer || '');
    if (initiatorHost && isSiteAllowed(initiatorHost)) return callback({});
    let blockedHost = '';
    for (const host of BLOCKED_HOSTS) { if (hostMatches(targetHost, host)) { blockedHost = host; break; } }
    if (!blockedHost) return callback({});
    blockedCount += 1;
    blockedHostCounts[blockedHost] = (blockedHostCounts[blockedHost] || 0) + 1;
    // Network-heavy pages can make hundreds of requests. A short UI debounce
    // keeps the counter responsive without forcing a render for each request.
    push();
    callback({ cancel: true });
  });
}

async function start() {
  const savedBookmarks = readJson('bookmarks.json', []);
  bookmarks = Array.isArray(savedBookmarks) ? savedBookmarks.filter((b) => b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url)).map((b) => ({
    title: typeof b.title === 'string' && b.title.trim() ? b.title : b.url,
    url: b.url,
    ...(Number.isFinite(b.addedAt) ? { addedAt: b.addedAt } : {})
  })) : [];
  const savedHistory = readJson('history.json', []);
  history = Array.isArray(savedHistory) ? savedHistory.filter((h) => h && typeof h.url === 'string' && /^https?:\/\//i.test(h.url)).slice(-500) : [];
  const settings = readJson(SETTINGS_FILE, {});
  adBlockEnabled = settings.adBlockEnabled !== false;
  appearance = ['system', 'light', 'dark'].includes(settings.appearance) ? settings.appearance : 'system';
  searchEngine = ['duckduckgo', 'google', 'bing', 'brave'].includes(settings.searchEngine) ? settings.searchEngine : 'duckduckgo';
  restoreSession = settings.restoreSession !== false;
  showBookmarksBar = settings.showBookmarksBar !== false;
  allowlistedSites = Array.isArray(settings.allowlistedSites)
    ? [...new Set(settings.allowlistedSites.filter((x) => typeof x === 'string' && /^[a-z0-9.-]+$/i.test(x)).map((x) => x.toLowerCase()))].slice(-300)
    : [];
  setupSession();
  buildMenu();

  win = new BaseWindow({
    width: 1360, height: 860, minWidth: 760, minHeight: 480, title: 'Drift', show: false,
    frame: !IS_WINDOWS, resizable: true, maximizable: true, minimizable: true, closable: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11131b' : '#f5f6fa'
  });
  win.setMenuBarVisibility(false);

  const uiPrefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true };
  ui = new WebContentsView({ webPreferences: uiPrefs });
  ui.setBackgroundColor('#00000000');
  ui.webContents.on('will-navigate', (e) => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.contentView.addChildView(ui);

  // Ensure local browser chrome is ready before display. The command palette
  // is created only on demand, reducing cold-start work and memory use.
  await ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));

  win.on('resize', layout);
  win.on('maximize', push);
  win.on('unmaximize', push);
  win.on('closed', () => {
    saveSessionNow();
    clearTimeout(sessionTimer);
    clearTimeout(pushTimer);
    for (const s of spaces) for (const t of s.tabs) if (t.view && !t.view.webContents.isDestroyed()) t.view.webContents.close();
  });

  // Restore metadata, but only instantiate the selected tab's WebContents.
  const saved = restoreSession ? readJson('session.json', null) : null;
  for (const s of saved?.spaces || []) {
    const sp = spaces.find((x) => x.name === s.name);
    if (!sp) continue;
    for (const t of s.tabs || []) {
      const url = !t.url || t.url.endsWith('/ui/newtab.html') ? NEWTAB : t.url;
      sp.tabs.push({ id: nextId++, title: t.title || 'New tab', url, favicon: t.favicon || '', loading: false, lastActive: Date.now(), view: null });
    }
    sp.active = sp.tabs[s.active] || sp.tabs[0] || null;
  }
  cur = spaces.find((s) => s.name === saved?.space) || spaces[0];

  layout();
  if (cur.tabs.length) {
    const initialTab = cur.active || cur.tabs[0];
    activateTab(initialTab);
    if (initialTab.url === NEWTAB) focusAddress();
  } else createTab();
  win.show();
  const discardTimer = setInterval(discardIdleTabs, 60 * 1000);
  discardTimer.unref?.();
}

app.setName('Drift');
if (process.platform === 'win32') app.setAppUserModelId('org.drift.browser');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start).catch((error) => {
    console.error('Drift failed to start:', error);
    app.quit();
  });
  app.on('before-quit', () => { if (win && !win.isDestroyed()) saveSessionNow(); });
  app.on('window-all-closed', () => app.quit());
}
