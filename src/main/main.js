const { app, BaseWindow, WebContentsView, Menu, ipcMain, session, nativeTheme, dialog, shell, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createExtensionManager } = require('./extensions');
const { matchShortcut } = require('./shortcuts');
const { createUpdater } = require('./updater');
const { createTelemetry } = require('./telemetry');
const { createStorage } = require('./storage');
const { planDiscards, measurePressure } = require('./memory-manager');

// Project layout: src/main (this file), src/preload, src/renderer/*, build/ (icons).
const ROOT_DIR = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');

// Keep Drift's writable profile in the current user's AppData (Windows),
// Application Support (macOS), or XDG config directory (Linux). The actual
// application binaries are installed separately by the per-user installer.
app.setName('Drift');
const LEGACY_USER_DATA_DIRECTORY = app.getPath('userData');
const APP_DATA_DIRECTORY = path.join(app.getPath('appData'), 'Drift');
app.setPath('userData', APP_DATA_DIRECTORY);

// ---------------------------------------------------------------- config
const IS_WINDOWS = process.platform === 'win32';
const CHROME_H_WITH_BOOKMARKS = 120; // tab strip (40) + navigation toolbar (42) + bookmarks bar (38)
const CHROME_H_WITHOUT_BOOKMARKS = 82;
const IDLE_DISCARD_MS = 5 * 60 * 1000;
const NEWTAB = pathToFileURL(path.join(RENDERER_DIR, 'newtab', 'newtab.html')).href;
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
const storage = createStorage({ getDir: () => app.getPath('userData') });
const { file, readJson, writeJson, writeJsonLater } = storage;

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function ensureUserDataDirectories() {
  fs.mkdirSync(APP_DATA_DIRECTORY, { recursive: true });
  fs.mkdirSync(path.join(APP_DATA_DIRECTORY, 'Logs'), { recursive: true });
  // One-time migration for profiles created by an earlier build using the
  // Electron default userData path. Existing files are never overwritten.
  const legacy = path.resolve(LEGACY_USER_DATA_DIRECTORY);
  const current = path.resolve(APP_DATA_DIRECTORY);
  if (legacy.toLowerCase() !== current.toLowerCase() && fs.existsSync(legacy)) {
    for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
      const source = path.join(legacy, entry.name);
      const destination = path.join(current, entry.name);
      if (!fs.existsSync(destination)) {
        try { fs.cpSync(source, destination, { recursive: true, errorOnExist: false, force: false }); }
        catch (error) { console.warn(`Drift could not migrate profile item ${entry.name}:`, error?.message || error); }
      }
    }
  }
}
// Chrome-compatible extensions: Chrome Web Store installs + unpacked folders.
const extensions = createExtensionManager({
  session: () => session.defaultSession,
  appDataDir: APP_DATA_DIRECTORY,
  readJson, writeJson,
  confirmInstall: (info) => requestExtensionConfirmation(info),
  onChange: () => push()
});

// Themed "Add extension" confirmation. The dialog lives in the browser chrome
// (renderer/browser); this promise resolves when the user answers it.
const pendingExtensionConfirms = new Map();
let extensionConfirmSeq = 0;
function requestExtensionConfirmation(info) {
  return new Promise((resolve) => {
    if (!ui || ui.webContents.isDestroyed()) { resolve(false); return; }
    const id = ++extensionConfirmSeq;
    const timer = setTimeout(() => finish(false), 10 * 60 * 1000);
    const finish = (allowed) => {
      clearTimeout(timer);
      if (!pendingExtensionConfirms.delete(id)) return;
      resolve(allowed === true);
    };
    pendingExtensionConfirms.set(id, finish);
    setUIOverlay(true);
    ui.webContents.send('extension:confirm', { ...info, requestId: id });
  });
}
ipcMain.on('extension:confirm-response', (_event, requestId, allowed) => {
  pendingExtensionConfirms.get(Number(requestId))?.(allowed === true);
});

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
let colorTheme = 'violet';
let searchEngine = 'duckduckgo';
// Startup + new-tab preferences.
//   startupMode: newtab (fresh New Tab page, the default) | previous (continue where you left off)
//                | specific (open a chosen set of pages) | homepage (open the home page)
let startupMode = 'newtab';
let startupPages = [];
let homepage = '';
let showHomeButton = false;
let newTabOpens = 'newtab';        // newtab | homepage | blank
let newTabShortcuts = 'smart';     // smart (most visited) | bookmarks | hidden
let newTabClock = true;
let windowStart = 'default';       // default | maximized | remember
let launchAtLogin = false;
let autoUpdate = true; // download updates quietly and install them when Drift closes (Windows installs)
let usageReports = true; // tell the developer's monitor that Drift is open (version, OS, PC name - never browsing data)
let showBookmarksBar = true;
let downloadDirectory = app.getPath('downloads');
let askWhereToSave = false;
// Silent updater. Uses its own in-memory session, so the ad blocker, cookies and extensions never see its requests.
let updaterSession = null;
const monitorFetch = (url, init) => (updaterSession ||= session.fromPartition('drift-updater')).fetch(url, init);
const updater = createUpdater({
  app,
  fetch: monitorFetch,
  isEnabled: () => autoUpdate
});
// Usage reporting to the same monitor (open / heartbeat / close). It shares the updater's session and install id.
const telemetry = createTelemetry({
  app,
  fetch: monitorFetch,
  isEnabled: () => usageReports,
  force: process.env.DRIFT_REPORT_DEV === '1', // lets `npm start` report to the monitor for testing (set DRIFT_REPORT_DEV=1)
  identity: { get: () => updater.installId(), set: (id) => updater.adoptInstallId(id) }
});
// Toolbar buttons the user pinned next to the address bar, in display order.
let toolbarPins = [];
let blockedHostCounts = Object.create(null);
let downloads = [];
let findState = { visible: false, query: '', matchCase: false, activeMatchOrdinal: 0, matches: 0 };
// A single browser workspace replaces the former Home / Work / Fun spaces.
const spaces = [{ name: 'Browser', tabs: [], active: null }];
let cur = spaces[0];
const activeTab = () => cur.active;

// ---------------------------------------------------------------- helpers
const SEARCH_ENGINES = ['duckduckgo', 'google', 'bing', 'brave'];
const COLOR_THEME_IDS = ['violet', 'ocean', 'forest', 'rose', 'sunset', 'indigo', 'graphite', 'mint'];
const APPEARANCES = ['system', 'light', 'dark'];
const STARTUP_MODES = ['newtab', 'previous', 'specific', 'homepage'];
const NEWTAB_OPEN_MODES = ['newtab', 'homepage', 'blank'];
const SHORTCUT_MODES = ['smart', 'bookmarks', 'hidden'];
const WINDOW_START_MODES = ['default', 'maximized', 'remember'];
const MAX_STARTUP_PAGES = 12;
const TOOLBAR_PIN_IDS = ['bookmarks', 'history', 'downloads', 'extensions', 'privacy', 'find', 'reader', 'palette', 'print', 'devtools', 'reopen-tab', 'clear-data', 'fullscreen', 'settings'];
// Keeps only known ids, removes duplicates, preserves the user's order.
function cleanToolbarPins(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && TOOLBAR_PIN_IDS.includes(id)))];
}

// Accepts "example.com", "https://example.com/x" or "about:blank"; returns '' when unusable.
function normalizeUrlSetting(value) {
  const raw = String(value || '').trim().slice(0, 2048);
  if (!raw || /\s/.test(raw)) return '';
  if (/^about:blank$/i.test(raw)) return 'about:blank';
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname ? u.href : '';
  } catch { return ''; }
}
function cleanStartupPages(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const url = normalizeUrlSetting(item);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= MAX_STARTUP_PAGES) break;
  }
  return out;
}

// The New Tab page is a sandboxed local file with no IPC, so the few things it
// personalises with (most-visited sites, recent bookmarks) travel in the URL.
function newTabData() {
  const clip = (text, max) => String(text || '').slice(0, max);
  const data = {};
  const recent = bookmarks.filter((b) => /^https?:/i.test(b.url)).slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 24);
  if (recent.length) data.b = recent.map((b) => [clip(b.title || hostnameOf(b.url), 40), clip(b.url, 160)]);
  if (newTabShortcuts === 'smart') {
    const sites = new Map();
    for (const h of history) {
      const host = hostnameOf(h.url);
      if (!host) continue;
      let entry = sites.get(host);
      if (!entry) { let origin = ''; try { origin = new URL(h.url).origin + '/'; } catch { continue; } entry = { n: 0, last: 0, origin }; sites.set(host, entry); }
      entry.n += 1; entry.last = Math.max(entry.last, Number(h.visitedAt) || 0);
    }
    const top = [...sites.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last).slice(0, 10);
    if (top.length) data.s = top.map(([host, entry]) => [clip(host.replace(/^www\./, ''), 40), clip(entry.origin, 160)]);
  }
  return data;
}
function newTabUrl() {
  const q = new URLSearchParams({ engine: searchEngine, theme: colorTheme, mode: appearance, sc: newTabShortcuts, clock: newTabClock ? '1' : '0' });
  const data = newTabData();
  if (data.b || data.s) q.set('d', Buffer.from(JSON.stringify(data)).toString('base64url'));
  return `${NEWTAB}?${q}`;
}
// What the Home button / Alt+Home opens, and what a brand-new tab opens.
function homeUrl() { return homepage || newTabUrl(); }
function newTabOpenUrl() {
  if (newTabOpens === 'blank') return 'about:blank';
  if (newTabOpens === 'homepage' && homepage) return homepage;
  return newTabUrl();
}
function applyAppearance() {
  nativeTheme.themeSource = appearance; // makes prefers-color-scheme (chrome, New Tab and websites) follow the choice
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#11131b' : '#f5f6fa');
}
function applyLoginItem() {
  if (!app.isPackaged || process.platform === 'linux') return;
  try { app.setLoginItemSettings({ openAtLogin: launchAtLogin }); } catch { /* unsupported on this platform */ }
}
function isNewTabUrl(value) { return !value || value === NEWTAB || String(value).startsWith(`${NEWTAB}?`); }

function resolve(input) {
  const t = String(input || '').trim();
  if (!t) return newTabUrl();
  if (/^(https?|file|about|data|blob|view-source):/i.test(t)) return t;
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

// Ad blocking runs for every sub-request, so it must stay O(1)-ish: parse the host with a
// regex, walk its domain suffixes against the Set, and remember the answer per host.
const blockLookupCache = new Map();
function requestHost(url) {
  const m = /^https?:\/\/([^/?#]*)/i.exec(url);
  if (!m) return '';
  let authority = m[1];
  if (authority.includes('@')) return hostnameOf(url); // credentials in the URL: use the real parser
  const colon = authority.lastIndexOf(':');
  if (colon > -1 && authority.indexOf(']') < colon) authority = authority.slice(0, colon);
  return authority.toLowerCase().replace(/\.$/, '');
}
function blockedDomainFor(host) {
  let hit = blockLookupCache.get(host);
  if (hit !== undefined) return hit;
  hit = '';
  for (let candidate = host; candidate;) {
    if (BLOCKED_HOSTS.has(candidate)) { hit = candidate; break; }
    const dot = candidate.indexOf('.');
    if (dot < 0) break;
    candidate = candidate.slice(dot + 1);
  }
  if (blockLookupCache.size >= 5000) blockLookupCache.clear();
  blockLookupCache.set(host, hit);
  return hit;
}
// Counter updates reach the UI at most a few times a second, however many requests are blocked.
let blockedPushTimer = null;
function pushBlockedSoon() {
  if (blockedPushTimer) return;
  blockedPushTimer = setTimeout(() => { blockedPushTimer = null; push(); }, 400);
  blockedPushTimer.unref?.();
}

function hostMatches(host, domain) {
  return !!host && (host === domain || host.endsWith('.' + domain));
}

function isSiteAllowed(host) {
  return allowlistedSites.some((site) => hostMatches(host, site));
}

function liveUrl(tab) {
  if (!tab) return '';
  if (isInternalUrl(tab.url)) return tab.url;
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

function isInternalUrl(value) { return /^drift:\/\/(settings|bookmarks|history|downloads|extensions)(?:\/)?$/i.test(String(value || '')); }
function internalPageName(value) { const match = String(value || '').match(/^drift:\/\/([a-z]+)/i); return isInternalUrl(value) ? match?.[1]?.toLowerCase() || '' : ''; }
function internalTitle(page) { return ({ settings: 'Settings', bookmarks: 'Bookmarks', history: 'History', downloads: 'Downloads', extensions: 'Extensions' })[page] || 'Drift'; }

function currentHost() {
  const url = liveUrl(activeTab());
  return url && !isNewTabUrl(url) && !isInternalUrl(url) ? hostnameOf(url) : '';
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
  // Resizing a hidden page makes its renderer re-layout for nothing (and can touch memory it
  // had released). Only the visible tab follows the window; activateTab() and setUIOverlay()
  // apply the current bounds to a tab at the moment it is shown.
  activeTab()?.view?.setBounds(tabBounds());
}

// ---------------------------------------------------------------- state -> UI
function snapshot() {
  const t = activeTab();
  const activeUrl = liveUrl(t);
  const activeInternalPage = internalPageName(activeUrl);
  const nav = t && !isInternalUrl(t.url) ? t.view?.webContents.navigationHistory : null;
  const host = currentHost();
  const allBookmarks = sortedBookmarks();
  return {
    spaces: spaces.map((s) => s.name),
    space: cur.name,
    tabs: cur.tabs.map((x) => ({ id: x.id, title: x.title, url: x.url, favicon: x.favicon, loading: x.loading, active: x === cur.active })),
    url: activeUrl && !isNewTabUrl(activeUrl) && !isInternalUrl(activeUrl) ? activeUrl : '',
    internalPage: internalPageName(activeUrl),
    loading: !!t?.loading,
    canBack: isInternalUrl(t?.url) ? !!t?.previousUrl : !!nav?.canGoBack(),
    canForward: !!nav?.canGoForward(),
    bookmarked: !!t && bookmarks.some((b) => b.url === activeUrl),
    // Full manager datasets are sent only while their page is open. This keeps
    // high-frequency tab/network state updates small on ordinary browsing.
    bookmarks: activeInternalPage === 'bookmarks' ? allBookmarks : allBookmarks.slice(0, 12),
    bookmarksCount: allBookmarks.length,
    history: activeInternalPage === 'history' ? history.slice().reverse() : [],
    downloads: activeInternalPage === 'downloads' ? downloads.slice().sort((a, b) => b.startedAt - a.startedAt) : [],
    extensions: activeInternalPage === 'extensions' ? extensions.list() : [],
    find: { ...findState },
    blocked: blockedCount,
    adBlockEnabled,
    currentHost: host,
    siteAllowed: isSiteAllowed(host),
    blockedHosts: Object.entries(blockedHostCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hostName, count]) => ({ host: hostName, count })),
    settings: { appearance, colorTheme, searchEngine, startupMode, startupPages, homepage, showHomeButton, newTabOpens, newTabShortcuts, newTabClock, windowStart, launchAtLogin, autoUpdate, usageReports, showBookmarksBar, downloadDirectory, askWhereToSave, toolbarPins },
    canAutoUpdate: updater.supported(),
    canReportUsage: telemetry.supported(),
    canLaunchAtLogin: process.platform !== 'linux',
    profileDirectory: app.getPath('userData'),
    extensionsDirectory: extensions.directory,
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
    const title = (t?.title || 'New tab') + ' — Drift Browser';
    if (win && !win.isDestroyed() && title !== lastWindowTitle) {
      lastWindowTitle = title;
      win.setTitle(title);
    }
  }, 50);
}

let sessionTimer = null;
const sessionData = () => ({
  active: cur.tabs.indexOf(cur.active),
  tabs: cur.tabs.map((t) => ({ title: t.title, url: t.url, favicon: t.favicon }))
});
function saveSessionNow() { writeJson('session.json', sessionData()); }
// Called on nearly every navigation/title event; the write is coalesced and runs off the main thread.
function saveSession() { writeJsonLater('session.json', sessionData, 800); }

function addHistory(title, url) {
  if (!/^https?:/i.test(url || '')) return;
  history.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: title || url, url, visitedAt: Date.now() });
  if (history.length > 1000) history.splice(0, history.length - 1000);
  writeJsonLater('history.json', () => history, 2000);
}

function sortedBookmarks() {
  if (!bookmarksSortedCache) bookmarksSortedCache = bookmarks.slice().sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url));
  return bookmarksSortedCache;
}
function persistBookmarks() { bookmarksSortedCache = null; writeJson('bookmarks.json', bookmarks); }
function persistSettings() { return writeJson(SETTINGS_FILE, { settingsVersion: 2, adBlockEnabled, allowlistedSites, appearance, colorTheme, searchEngine, startupMode, startupPages, homepage, showHomeButton, newTabOpens, newTabShortcuts, newTabClock, windowStart, launchAtLogin, autoUpdate, usageReports, showBookmarksBar, downloadDirectory, askWhereToSave, toolbarPins }); }


function persistDownloads(immediate = false) {
  if (immediate) { writeJson('downloads.json', downloads.slice(-300)); return; }
  writeJsonLater('downloads.json', () => downloads.slice(-300), 700); // progress events arrive many times a second
}
const activeDownloads = new Map();
const downloadOwners = new Map(); // webContents id -> running downloads it started
function recordDownload(item, id) {
  const found = downloads.find((entry) => entry.id === id);
  if (!found) return;
  found.filename = item.getFilename() || found.filename;
  found.url = item.getURL() || found.url;
  found.receivedBytes = item.getReceivedBytes();
  found.totalBytes = item.getTotalBytes();
  found.savePath = item.getSavePath() || found.savePath || '';
  found.state = item.isPaused?.() ? 'paused' : item.getState();
  found.mimeType = item.getMimeType() || found.mimeType || '';
  persistDownloads();
  push();
}

function handleDownloadAction(id, action) {
  const item = activeDownloads.get(id);
  const record = downloads.find((entry) => entry.id === id);
  if (action === 'pause' && item && item.getState() === 'progressing') item.pause();
  else if (action === 'resume' && item && item.isPaused()) item.resume();
  else if (action === 'cancel' && item) item.cancel();
  else if (action === 'open' && record?.savePath && fs.existsSync(record.savePath)) shell.openPath(record.savePath);
  else if (action === 'show' && record?.savePath) shell.showItemInFolder(record.savePath);
  else if (action === 'clear-completed') {
    downloads = downloads.filter((entry) => !['completed', 'cancelled', 'interrupted'].includes(entry.state));
    persistDownloads(true);
  }
  push();
}

// ---------------------------------------------------------------- tabs
function attachView(tab) {
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: true, spellcheck: false, enableWebSQL: false } });
  tab.view = view;
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  view.setBounds(tabBounds());
  view.setVisible(false);

  const wc = view.webContents;
  bindShortcuts(wc);
  // Ctrl + mouse wheel / pinch zoom, which Electron reports but does not apply.
  wc.on('zoom-changed', (_event, direction) => {
    const level = wc.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5);
    wc.setZoomLevel(Math.min(5, Math.max(-3, level)));
  });
  installWebContentsContextMenu(wc, 'page');
  wc.setWindowOpenHandler(({ url }) => { createTab(url); return { action: 'deny' }; });
  wc.on('found-in-page', (_event, result) => {
    findState.activeMatchOrdinal = result.activeMatchOrdinal || 0;
    findState.matches = result.matches || 0;
    push();
  });
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title || 'New tab';
    let changedBookmark = false;
    for (const b of bookmarks) {
      if (b.url === tab.url && b.title !== tab.title) { b.title = tab.title; changedBookmark = true; }
    }
    if (changedBookmark) persistBookmarks();
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].url === tab.url) { history[i].title = tab.title; writeJsonLater('history.json', () => history, 2000); break; }
    }
    push();
    saveSession();
  });
  wc.on('page-favicon-updated', (_e, favicons) => { tab.favicon = favicons?.[0] || ''; push(); saveSession(); });
  wc.on('did-start-loading', () => { tab.loading = true; push(); });
  wc.on('did-stop-loading', () => { tab.url = wc.getURL() || tab.url; tab.title = wc.getTitle() || tab.title; tab.loading = false; push(); saveSession(); });
  wc.on('did-start-navigation', (_e, url, inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    if (!inPlace) tab.thumb = null; // a thumbnail of the previous page would be misleading
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

function installWebContentsContextMenu(webContents, surface = 'page') {
  webContents.on('context-menu', (_event, params) => {
    if (webContents.isDestroyed() || !win || win.isDestroyed()) return;
    const menuItems = [];
    const flags = params.editFlags || {};
    const selectedText = String(params.selectionText || '').trim().slice(0, 500);
    const isEditable = !!params.isEditable;
    const addSeparator = () => { if (menuItems.length && menuItems[menuItems.length - 1].type !== 'separator') menuItems.push({ type: 'separator' }); };

    if (isEditable) {
      menuItems.push(
        { role: 'undo', enabled: !!flags.canUndo },
        { role: 'redo', enabled: !!flags.canRedo }
      );
      addSeparator();
      menuItems.push(
        { role: 'cut', enabled: !!flags.canCut },
        { role: 'copy', enabled: !!flags.canCopy },
        { role: 'paste', enabled: !!flags.canPaste },
        { role: 'selectAll' }
      );
      if (selectedText) addSeparator();
    }

    if (surface === 'page') {
      const linkProtocol = (() => { try { return new URL(params.linkURL).protocol; } catch { return ''; } })();
      const isWebLink = ['http:', 'https:'].includes(linkProtocol);
      if (params.linkURL) {
        menuItems.push(
          { label: 'Open link in new tab', enabled: isWebLink, click: () => { if (isWebLink) createTab(params.linkURL); } },
          { label: 'Open link in current tab', enabled: isWebLink, click: () => { if (isWebLink && !webContents.isDestroyed()) safelyLoad(webContents, params.linkURL); } },
          { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
          { label: 'Save link as…', enabled: isWebLink, click: () => { if (isWebLink && !webContents.isDestroyed()) webContents.downloadURL(params.linkURL); } }
        );
        addSeparator();
      }
      if (params.mediaType === 'image' && params.srcURL) {
        const imageProtocol = (() => { try { return new URL(params.srcURL).protocol; } catch { return ''; } })();
        const canOpenImage = ['http:', 'https:', 'blob:', 'data:'].includes(imageProtocol);
        menuItems.push(
          { label: 'Open image in new tab', enabled: canOpenImage, click: () => { if (canOpenImage) createTab(params.srcURL); } },
          { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
          { label: 'Save image as…', enabled: ['http:', 'https:'].includes(imageProtocol), click: () => { if (['http:', 'https:'].includes(imageProtocol) && !webContents.isDestroyed()) webContents.downloadURL(params.srcURL); } }
        );
        addSeparator();
      }
      if (selectedText) {
        menuItems.push(
          { label: 'Search for “' + (selectedText.length > 42 ? selectedText.slice(0, 39) + '…' : selectedText) + '”', click: () => createTab(resolve(selectedText)) },
          { role: 'copy', enabled: !!flags.canCopy || !isEditable }
        );
        addSeparator();
      }
      if (!isEditable) {
        const navigation = webContents.navigationHistory;
        menuItems.push(
          { label: 'Back', enabled: navigation.canGoBack(), click: () => navigation.goBack() },
          { label: 'Forward', enabled: navigation.canGoForward(), click: () => navigation.goForward() },
          { label: 'Reload', click: () => webContents.reload() }
        );
        addSeparator();
      }
      menuItems.push(
        { label: 'View page source', enabled: /^https?:/i.test(webContents.getURL()), click: () => createTab('view-source:' + webContents.getURL()) },
        { label: 'Print…', click: () => webContents.print() },
        { label: 'Inspect element', click: () => webContents.inspectElement(params.x, params.y) }
      );
    }

    while (menuItems[menuItems.length - 1]?.type === 'separator') menuItems.pop();
    if (!menuItems.length) return;
    try {
      let popupX = Number(params.x) || 0;
      let popupY = Number(params.y) || 0;
      if (surface === 'page') {
        const ownerTab = cur.tabs.find((tab) => tab.view?.webContents === webContents);
        const viewBounds = ownerTab?.view?.getBounds();
        if (viewBounds) { popupX += viewBounds.x; popupY += viewBounds.y; }
      }
      Menu.buildFromTemplate(menuItems).popup({ window: win, x: popupX, y: popupY });
    } catch (error) {
      console.warn('Drift could not open a context menu:', error?.message || error);
    }
  });
}

// ---------------------------------------------------------------- closed tabs
const MAX_CLOSED_TABS = 25;
const closedTabs = [];
function rememberClosedTab(tab, index) {
  const url = tab?.url || '';
  if (!url || isNewTabUrl(url) || url === 'about:blank') return; // Like Chrome, blank new tabs are not restorable.
  closedTabs.push({ url, title: tab.title || '', favicon: tab.favicon || '', index });
  if (closedTabs.length > MAX_CLOSED_TABS) closedTabs.shift();
}
function reopenClosedTab() {
  const entry = closedTabs.pop();
  if (!entry) return null;
  const tab = { id: nextId++, title: entry.title || 'New tab', url: entry.url, favicon: entry.favicon || '', loading: false, lastActive: Date.now(), view: null };
  cur.tabs.splice(Math.min(Math.max(entry.index, 0), cur.tabs.length), 0, tab);
  activateTab(tab);
  saveSession();
  return tab;
}

function createTab(input) {
  const tab = { id: nextId++, title: 'New tab', url: input ? resolve(input) : newTabOpenUrl(), favicon: '', loading: false, lastActive: Date.now(), view: null };
  cur.tabs.push(tab);
  activateTab(tab);
  saveSession();
  if (!input) focusNewTab(tab);
  return tab;
}

function clearFindState() {
  const previous = activeTab();
  if (previous?.view && !previous.view.webContents.isDestroyed()) previous.view.webContents.stopFindInPage('clearSelection');
  findState = { visible: false, query: '', matchCase: false, activeMatchOrdinal: 0, matches: 0 };
}

function activateTab(tab) {
  if (!cur.tabs.includes(tab)) return;
  clearFindState();
  const wasLifted = cardLifted;
  cardLifted = false;
  // Remember what the tab being left looked like (including its scroll position) so its
  // hover preview still works after the renderer is hidden or discarded.
  const leaving = cur.active;
  if (leaving && leaving !== tab && leaving.view && !isInternalUrl(leaving.url)) captureThumb(leaving, 800);
  for (const t of cur.tabs) t.view?.setVisible(false);
  cur.active = tab;
  tab.lastActive = Date.now();
  if (isInternalUrl(tab.url)) {
    tab.title = internalTitle(internalPageName(tab.url));
    tab.favicon = '';
    setUIOverlay(true);
    push();
    saveSession();
    return;
  }
  if (!tab.view) safelyLoad(attachView(tab), tab.url || newTabUrl());
  tab.url = liveUrl(tab) || tab.url;
  tab.view.setBounds(tabBounds());
  tab.view.setVisible(true);
  if (wasLifted) win.contentView.addChildView(tab.view); // put the page back above the chrome
  if (!paletteOpen) tab.view.webContents.focus();
  setUIOverlay(false);
  push();
  saveSession();
}

// ---------------------------------------------------------------- tab hover preview
// Hovering a tab shows a thumbnail of its page as it currently looks (so it follows the scroll
// position) and how much memory its renderer is using. The card is drawn by the browser chrome,
// so while it is visible the chrome is raised above the page - without taking keyboard focus.
const THUMB_WIDTH = 360;
let cardLifted = false;

function findTabById(id) {
  for (const s of spaces) {
    const found = s.tabs.find((x) => x.id === id);
    if (found) return found;
  }
  return null;
}

async function captureThumb(tab, timeoutMs = 500) {
  const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
  if (!wc) return tab.thumb || null;
  try {
    let timer;
    const image = await Promise.race([
      wc.capturePage(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
    clearTimeout(timer);
    if (image && !image.isEmpty()) {
      const small = image.getSize().width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image;
      tab.thumb = `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`;
    }
  } catch { /* the page may be mid-navigation or being discarded; keep the previous thumbnail */ }
  return tab.thumb || null;
}

function tabMemory(tab) {
  const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
  if (!wc) return { memoryKB: null, sharedWith: 0 };
  try {
    const pid = wc.getOSProcessId();
    const metrics = app.getAppMetrics();
    const mine = metrics.find((m) => m.pid === pid);
    const memory = mine?.memory || {};
    // privateBytes (Windows) avoids counting pages shared between Chromium processes.
    const memoryKB = Number(memory.privateBytes ?? memory.workingSetSize) || 0;
    // Chromium can host several tabs of the same site in one process; say so instead of lying.
    let sharedWith = 0;
    for (const s of spaces) {
      for (const other of s.tabs) {
        if (other === tab || !other.view || other.view.webContents.isDestroyed()) continue;
        if (other.view.webContents.getOSProcessId() === pid) sharedWith += 1;
      }
    }
    return { memoryKB, sharedWith };
  } catch { return { memoryKB: null, sharedWith: 0 }; }
}

function liftChromeForCard(on) {
  if (!win || !ui || ui.webContents.isDestroyed() || uiOverlayOpen || paletteOpen) return;
  const active = activeTab();
  if (on) {
    if (cardLifted || !active?.view || isInternalUrl(active.url)) return; // internal pages already sit under the chrome
    cardLifted = true;
    win.contentView.addChildView(ui);
    const { width, height } = win.getContentBounds();
    ui.setBounds({ x: 0, y: 0, width, height });
  } else {
    if (!cardLifted) return;
    cardLifted = false;
    if (active?.view && !isInternalUrl(active.url)) {
      win.contentView.addChildView(active.view);
      active.view.setBounds(tabBounds());
    }
  }
}

ipcMain.handle('tabs:preview', async (_e, rawId, withThumb = true) => {
  const tab = findTabById(Number(rawId));
  if (!tab) return null;
  const live = !!tab.view && !tab.view.webContents.isDestroyed();
  const internal = isInternalUrl(tab.url);
  let thumb = tab.thumb || null;
  if (live && !internal && withThumb) thumb = await captureThumb(tab);
  const { memoryKB, sharedWith } = live && !internal ? tabMemory(tab) : { memoryKB: null, sharedWith: 0 };
  return {
    id: tab.id,
    state: internal ? 'internal' : live ? 'loaded' : 'sleeping',
    thumb,
    memoryKB,
    sharedWith,
    host: hostnameOf(liveUrl(tab) || tab.url) || ''
  };
});

function destroyView(tab) {
  if (!tab.view) return;
  try { win.contentView.removeChildView(tab.view); } catch { /* already detached */ }
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  tab.view = null;
}

function closeTab(tab) {
  const i = cur.tabs.indexOf(tab);
  if (i < 0) return;
  tab.url = liveUrl(tab) || tab.url;
  rememberClosedTab(tab, i);
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
  clearFindState();
  const url = resolve(text);
  let t = activeTab();
  if (!t) { createTab(text); return; }
  if (isInternalUrl(url)) {
    if (!isInternalUrl(t.url)) { t.previousUrl = liveUrl(t) || t.url || newTabUrl(); t.webFavicon = t.favicon || ''; }
    t.favicon = ''; // internal pages get their own tab icon; never keep the previous site's
    t.url = url;
    t.title = internalTitle(internalPageName(url));
    t.loading = false;
    activateTab(t);
    return;
  }
  t.favicon = isInternalUrl(t.url) ? (t.webFavicon || '') : t.favicon; // leaving an internal page: restore the site icon until the new one arrives
  t.url = url; // update the address bar immediately rather than waiting for redirect events
  t.title = 'Loading…';
  t.loading = true;
  t.lastActive = Date.now();
  if (!t.view) {
    activateTab(t);
    return; // activateTab creates the WebContents and starts this navigation.
  }
  push();
  saveSession();
  safelyLoad(t.view.webContents, url);
  t.view.webContents.focus();
  setUIOverlay(false);
}

// Settings, Bookmarks, History, Downloads and Extensions always open in their own tab.
// If that page is already open in a tab, switch to it instead of piling up duplicates.
function openInternalPage(page, newTab = true) {
  const target = `drift://${page}`;
  const existing = cur.tabs.find((t) => internalPageName(t.url) === page);
  if (existing) { activateTab(existing); return; }
  if (newTab || !activeTab()) createTab(target);
  else go(target);
}

function toggleBookmark() {
  const t = activeTab();
  if (!t || !t.url || isNewTabUrl(t.url) || !/^https?:/i.test(t.url)) return;
  const i = bookmarks.findIndex((b) => b.url === t.url);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.push({ title: t.title && t.title !== 'Loading…' ? t.title : hostnameOf(t.url), url: t.url, addedAt: Date.now() });
  persistBookmarks();
  push();
}

function updateBookmark(url, title, newUrl, folder) {
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
  if (typeof folder === 'string') {
    const cleanFolder = folder.trim().slice(0, 80);
    if (cleanFolder) b.folder = cleanFolder; else delete b.folder;
  }
  persistBookmarks();
  push();
}

function removeBookmark(url) {
  const before = bookmarks.length;
  bookmarks = bookmarks.filter((item) => item.url !== url);
  if (bookmarks.length !== before) { persistBookmarks(); push(); }
}

// Free memory by discarding background tabs (see memory-manager.js for the policy). A
// discarded tab keeps its URL, title and favicon and gets a fresh WebContents when selected.
function discardIdleTabs() {
  const live = [];
  for (const s of spaces) {
    for (const t of s.tabs) {
      if (!t.view || t.view.webContents.isDestroyed()) continue;
      const wc = t.view.webContents;
      live.push({
        tab: t,
        id: t.id,
        lastActive: t.lastActive,
        visible: s === cur && t === cur.active,
        audible: wc.isCurrentlyAudible(),
        busy: downloadOwners.has(wc.id) || (wc.isBeingCaptured?.() ?? false),
        isNewTab: isNewTabUrl(liveUrl(t))
      });
    }
  }
  if (!live.some((entry) => !entry.visible)) return; // nothing in the background, skip the measurements
  const pressure = measurePressure({ getSystemMemoryInfo: () => process.getSystemMemoryInfo(), getAppMetrics: () => app.getAppMetrics(), isWindows: IS_WINDOWS });
  for (const entry of live) entry.memoryKB = pressure.byPid.get(entry.tab.view.webContents.getOSProcessId()) || 0;
  const doomed = new Set(planDiscards(live, { now: Date.now(), pressure: pressure.level }));
  let changed = false;
  for (const entry of live) {
    if (!doomed.has(entry.id)) continue;
    entry.tab.url = liveUrl(entry.tab) || entry.tab.url;
    entry.tab.loading = false;
    destroyView(entry.tab);
    changed = true;
  }
  if (changed) { push(); saveSession(); }
}

// ---------------------------------------------------------------- palette
function openPalette() {
  paletteOpen = true;
  clearTimeout(paletteReleaseTimer);
  paletteReleaseTimer = null;
  if (!palette) {
    // Load the palette only on first use to reduce cold-start WebContents work.
    const palettePrefs = { preload: PRELOAD_PATH, contextIsolation: true, sandbox: true };
    palette = new WebContentsView({ webPreferences: palettePrefs });
    bindShortcuts(palette.webContents);
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
    palette.webContents.loadFile(path.join(RENDERER_DIR, 'palette', 'palette.html')).catch(() => {
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
let paletteReleaseTimer = null;
function releasePalette() {
  clearTimeout(paletteReleaseTimer);
  paletteReleaseTimer = null;
  if (paletteOpen || !palette) return;
  const view = palette;
  palette = null;
  try { win?.contentView.removeChildView(view); } catch { /* already detached */ }
  if (!view.webContents.isDestroyed()) view.webContents.close();
}
function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  palette?.setVisible(false);
  clearTimeout(paletteReleaseTimer);
  paletteReleaseTimer = setTimeout(releasePalette, 60 * 1000); // its renderer process is only needed while the palette is in use
  paletteReleaseTimer.unref?.();
  if (isInternalUrl(activeTab()?.url)) ui?.webContents.focus();
  else activeTab()?.view?.webContents.focus();
}

function focusAddress() {
  ui?.webContents.focus();
  ui?.webContents.send('focus-address');
}

// A fresh tab: empty the address bar and focus it so you can type right away.
function focusNewTab(tab) {
  // Always put the cursor in the address bar at the top (never in the New Tab page's own search box).
  if (tab && isNewTabUrl(tab.url)) ui?.webContents.send('reset-address'); // empty it, then focus below
  focusAddress();
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
    ['New tab', 'new'], ['Close tab', 'close'], ['Next tab', 'next-tab'], ['Previous tab', 'previous-tab'], ['Reader mode', 'reader'],
    ['Bookmark or unbookmark this page', 'bookmark'], ['Open bookmarks manager', 'bookmarks'],
    ['Open home page', 'home'], ['Open history', 'history'], ['Clear browsing data', 'clear-data'], ['Open downloads', 'downloads'], ['Open extensions', 'extensions'], ['Open settings', 'settings'],
    ['Toggle ad blocker', 'adblock'], ['Developer tools', 'devtools'],
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
  cardLifted = false; // a full overlay supersedes the hover-card lift
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
    if (active && isInternalUrl(active.url)) {
      win.contentView.addChildView(ui);
      const { width, height } = win.getContentBounds();
      ui.setBounds({ x: 0, y: 0, width, height });
      ui.webContents.focus();
    } else if (active?.view) {
      win.contentView.addChildView(active.view);
      active.view.setBounds(tabBounds());
      active.view.setVisible(true);
      active.view.webContents.focus();
    }
  }
}

// ---------------------------------------------------------------- shortcuts
// Handled in the main process on every surface so they work whether focus is
// in a page, the address bar, the command palette, or an internal page.
function bindShortcuts(webContents) {
  webContents.on('before-input-event', (event, input) => {
    const match = matchShortcut(input);
    if (!match) return;
    // While the palette is open only its own toggle applies.
    if (paletteOpen && match.name !== 'palette') return;
    event.preventDefault();
    command(match.name, match.arg);
  });
}

// ---------------------------------------------------------------- commands
function command(name, arg) {
  const t = activeTab();
  const wc = t?.view?.webContents;
  switch (name) {
    case 'new': createTab(arg); break;
    case 'close': { const target = arg ? cur.tabs.find((x) => x.id === arg) : t; if (target) closeTab(target); break; }
    case 'activate': { const target = cur.tabs.find((x) => x.id === arg); if (target) activateTab(target); break; }
    case 'move-tab': {
      // Drag-reorder from the tab strip: { id, index } moves a tab to a new slot.
      const { id, index } = (arg && typeof arg === 'object') ? arg : {};
      const from = cur.tabs.findIndex((x) => x.id === id);
      if (from < 0) break;
      const to = Math.max(0, Math.min(cur.tabs.length - 1, Math.trunc(Number(index)) || 0));
      if (to !== from) {
        const [moved] = cur.tabs.splice(from, 1);
        cur.tabs.splice(to, 0, moved);
        saveSession();
      }
      push();
      break;
    }
    case 'tab-search': ui?.webContents.focus(); ui?.webContents.send('tabs:search'); break;
    case 'next-tab': if (cur.tabs.length > 1) activateTab(cur.tabs[(cur.tabs.indexOf(t) + 1 + cur.tabs.length) % cur.tabs.length]); break;
    case 'previous-tab': if (cur.tabs.length > 1) activateTab(cur.tabs[(cur.tabs.indexOf(t) - 1 + cur.tabs.length) % cur.tabs.length]); break;
    case 'go': go(arg); break;
    case 'home': go(homeUrl()); break;
    case 'startup-use-open-tabs':
      startupPages = cleanStartupPages(cur.tabs.map((x) => liveUrl(x) || x.url).filter((u) => /^https?:/i.test(u || '')));
      persistSettings(); push(); break;
    case 'reopen-tab': reopenClosedTab(); break;
    case 'select-tab': {
      if (!cur.tabs.length) break;
      const n = Number(arg);
      const target = n >= 9 ? cur.tabs[cur.tabs.length - 1] : cur.tabs[n - 1];
      if (target && target !== t) activateTab(target);
      break;
    }
    case 'close-window': win?.close(); break;
    case 'fullscreen': if (win) { win.setFullScreen(!win.isFullScreen()); } break;
    case 'print': if (wc && !isInternalUrl(t?.url)) wc.print(); break;
    case 'zoom-in': case 'zoom-out': case 'zoom-reset': {
      if (!wc || isInternalUrl(t?.url)) break;
      const level = name === 'zoom-reset' ? 0 : Math.min(5, Math.max(-3, wc.getZoomLevel() + (name === 'zoom-in' ? 0.5 : -0.5)));
      wc.setZoomLevel(level);
      break;
    }
    case 'find-next': {
      if (!wc || isInternalUrl(t?.url)) break;
      if (!findState.visible) { command('find'); break; }
      if (findState.query) wc.findInPage(findState.query, { forward: arg !== 'previous', findNext: true, matchCase: !!findState.matchCase });
      break;
    }
    case 'back': if (isInternalUrl(t?.url)) go(t.previousUrl || newTabUrl()); else if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': {
      const target = typeof arg === 'number' ? cur.tabs.find((x) => x.id === arg) : t;
      if (target && !target.view) activateTab(target);
      else if (arg === 'hard' && !isInternalUrl(target?.url)) target?.view?.webContents.reloadIgnoringCache();
      else target?.view?.webContents.reload();
      break;
    }
    case 'close-others':
    case 'close-right': {
      const keep = cur.tabs.find((x) => x.id === arg) || t;
      if (!keep) break;
      const keepIndex = cur.tabs.indexOf(keep);
      const closing = name === 'close-others'
        ? cur.tabs.filter((x) => x !== keep)
        : cur.tabs.slice(keepIndex + 1);
      const activeWasClosed = closing.includes(cur.active);
      for (const tab of closing) {
        const index = cur.tabs.indexOf(tab);
        if (index >= 0) { tab.url = liveUrl(tab) || tab.url; rememberClosedTab(tab, index); cur.tabs.splice(index, 1); }
        destroyView(tab);
      }
      if (!cur.tabs.length) { cur.active = null; createTab(); }
      else if (activeWasClosed || !cur.tabs.includes(cur.active)) activateTab(keep);
      else { push(); saveSession(); }
      break;
    }
    case 'reader': wc?.executeJavaScript(READER_JS).catch(() => {}); break;
    case 'bookmark': toggleBookmark(); break;
    case 'bookmarks': openInternalPage('bookmarks'); break;
    case 'history': openInternalPage('history'); break;
    case 'clear-data': ui?.webContents.focus(); ui?.webContents.send('clear-data:show'); break;
    case 'downloads': openInternalPage('downloads'); break;
    case 'extensions': openInternalPage('extensions'); break;
    case 'settings': openInternalPage('settings'); break;
    case 'open-profile-folder': shell.openPath(app.getPath('userData')); break;
    case 'find': if (wc && !isInternalUrl(t?.url)) { findState.visible = true; setUIOverlay(true); ui?.webContents.send('find:show'); push(); } break;
    case 'adblock': adBlockEnabled = !adBlockEnabled; persistSettings(); push(); break;
    case 'adblock-settings': ui?.webContents.send('open-adblock'); break;
    case 'tab-card-show': liftChromeForCard(true); break;
    case 'tab-card-hide': liftChromeForCard(false); break;
    case 'overlay-open': setUIOverlay(true); break;
    case 'overlay-close': setUIOverlay(false); break;
    case 'devtools': wc?.toggleDevTools(); break;
    case 'palette': if (paletteOpen) closePalette(); else openPalette(); break;
    case 'closePalette': closePalette(); break;
    case 'address': focusAddress(); break;
  }
}
// Lightweight on-demand data for the toolbar menu's submenus (recent items, zoom, extensions).
ipcMain.handle('menu:data', () => {
  const active = activeTab();
  const wc = active && !isInternalUrl(active.url) ? active.view?.webContents : null;
  const level = wc && !wc.isDestroyed() ? wc.getZoomLevel() : 0;
  return {
    zoom: Math.round(Math.pow(1.2, level) * 100),
    canZoom: !!wc,
    fullscreen: !!win?.isFullScreen?.(),
    bookmarks: bookmarks.slice(-8).reverse().map((b) => ({ title: b.title || b.url, url: b.url })),
    history: history.slice(-8).reverse().map((h) => ({ title: h.title || h.url, url: h.url })),
    closedTabs: closedTabs.slice(-5).reverse().map((c) => ({ title: c.title || c.url, url: c.url })),
    downloads: downloads.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, 6)
      .map((d) => ({ id: d.id, filename: d.filename, state: d.state, received: d.receivedBytes, total: d.totalBytes })),
    extensions: extensions.list().map((e) => ({ id: e.id, name: e.name, version: e.version }))
  };
});
ipcMain.on('cmd', (_e, name, arg) => command(name, arg));

ipcMain.on('bookmark:update', (_e, url, title, newUrl, folder) => updateBookmark(String(url || ''), title, newUrl, folder));
ipcMain.on('bookmark:remove', (_e, url) => removeBookmark(String(url || '')));
ipcMain.on('bookmark:add', (_e, title, rawUrl, folder) => {
  let url = String(rawUrl || '').trim();
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return;
    url = parsed.href;
  } catch { return; }
  if (bookmarks.some((b) => b.url === url)) return;
  const cleanFolder = String(folder || '').trim().slice(0, 80);
  bookmarks.push({ title: String(title || url).trim().slice(0, 240) || url, url, ...(cleanFolder ? { folder: cleanFolder } : {}), addedAt: Date.now() });
  persistBookmarks(); push();
});
ipcMain.on('history:remove', (_e, rawId) => { const id = String(rawId || ''); history = history.filter((h) => h.id !== id); writeJson('history.json', history); push(); });
ipcMain.on('history:clear', () => { history = []; writeJson('history.json', history); push(); });
ipcMain.on('downloads:action', (_e, id, action) => handleDownloadAction(String(id || ''), String(action || '')));
ipcMain.on('find:query', (_e, query, options = {}) => {
  const active = activeTab();
  const wc = active && !isInternalUrl(active.url) ? active.view?.webContents : null;
  const text = String(query || '').slice(0, 500);
  findState.query = text; findState.matchCase = !!options.matchCase;
  if (!wc || !text) { wc?.stopFindInPage('clearSelection'); findState.activeMatchOrdinal = 0; findState.matches = 0; push(); return; }
  wc.findInPage(text, { forward: options.forward !== false, matchCase: !!options.matchCase });
});
ipcMain.on('find:next', (_e, forward = true) => {
  const active = activeTab();
  const wc = active && !isInternalUrl(active.url) ? active.view?.webContents : null;
  if (wc && findState.query) wc.findInPage(findState.query, { forward: !!forward, findNext: true, matchCase: !!findState.matchCase });
});
ipcMain.on('find:close', () => {
  activeTab()?.view?.webContents.stopFindInPage('clearSelection');
  findState = { visible: false, query: '', matchCase: false, activeMatchOrdinal: 0, matches: 0 };
  setUIOverlay(false); push();
});
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
  let refreshNewTabs = false;
  if (APPEARANCES.includes(patch.appearance) && patch.appearance !== appearance) { appearance = patch.appearance; refreshNewTabs = true; applyAppearance(); }
  if (COLOR_THEME_IDS.includes(patch.colorTheme) && patch.colorTheme !== colorTheme) { colorTheme = patch.colorTheme; refreshNewTabs = true; }
  if (SEARCH_ENGINES.includes(patch.searchEngine) && patch.searchEngine !== searchEngine) { searchEngine = patch.searchEngine; refreshNewTabs = true; }
  if (SHORTCUT_MODES.includes(patch.newTabShortcuts) && patch.newTabShortcuts !== newTabShortcuts) { newTabShortcuts = patch.newTabShortcuts; refreshNewTabs = true; }
  if (typeof patch.newTabClock === 'boolean' && patch.newTabClock !== newTabClock) { newTabClock = patch.newTabClock; refreshNewTabs = true; }
  if (STARTUP_MODES.includes(patch.startupMode)) startupMode = patch.startupMode;
  if (Array.isArray(patch.startupPages)) startupPages = cleanStartupPages(patch.startupPages);
  if (typeof patch.homepage === 'string') homepage = normalizeUrlSetting(patch.homepage);
  if (typeof patch.showHomeButton === 'boolean') showHomeButton = patch.showHomeButton;
  if (NEWTAB_OPEN_MODES.includes(patch.newTabOpens)) newTabOpens = patch.newTabOpens;
  if (WINDOW_START_MODES.includes(patch.windowStart)) { windowStart = patch.windowStart; if (windowStart === 'remember') saveWindowState(); }
  if (typeof patch.launchAtLogin === 'boolean' && patch.launchAtLogin !== launchAtLogin && process.platform !== 'linux') { launchAtLogin = patch.launchAtLogin; applyLoginItem(); }
  if (typeof patch.autoUpdate === 'boolean' && patch.autoUpdate !== autoUpdate) { autoUpdate = patch.autoUpdate; updater.settingsChanged(); }
  if (typeof patch.usageReports === 'boolean' && patch.usageReports !== usageReports) { usageReports = patch.usageReports; telemetry.settingsChanged(); }
  if (typeof patch.showBookmarksBar === 'boolean') showBookmarksBar = patch.showBookmarksBar;
  if (typeof patch.askWhereToSave === 'boolean') askWhereToSave = patch.askWhereToSave;
  if (typeof patch.downloadDirectory === 'string' && patch.downloadDirectory.trim()) downloadDirectory = patch.downloadDirectory.trim();
  if (typeof patch.adBlockEnabled === 'boolean') adBlockEnabled = patch.adBlockEnabled;
  if (Array.isArray(patch.toolbarPins)) toolbarPins = cleanToolbarPins(patch.toolbarPins);
  if (refreshNewTabs) {
    for (const tab of cur.tabs) {
      if (!isNewTabUrl(tab.url)) continue;
      tab.url = newTabUrl();
      if (tab.view && !tab.view.webContents.isDestroyed()) safelyLoad(tab.view.webContents, tab.url);
    }
    saveSession();
  }
  persistSettings();
  layout();
  push();
});

ipcMain.handle('downloads:choose-folder', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Choose download folder', defaultPath: downloadDirectory, properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths?.[0]) return null;
  downloadDirectory = result.filePaths[0];
  persistSettings(); push();
  return downloadDirectory;
});
ipcMain.handle('extensions:install', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Select unpacked extension folder', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  try { await extensions.installFromFolder(result.filePaths[0]); push(); return { ok: true }; }
  catch (error) { return { error: error?.message || 'The extension could not be installed.' }; }
});
ipcMain.handle('extensions:install-store', async (_event, input) => {
  try { const installed = await extensions.installFromWebStore(input); push(); return { ok: true, name: installed?.name || '' }; }
  catch (error) {
    if (error?.cancelled) return { cancelled: true };
    return { error: error?.message || 'The extension could not be installed from the Chrome Web Store.' };
  }
});
ipcMain.handle('extensions:remove', async (_event, id) => {
  try { await extensions.remove(id); push(); return { ok: true }; }
  catch (error) { return { error: error?.message || 'Could not remove extension.' }; }
});
// ---------------------------------------------------------------- clear browsing data
// Electron's storage-clearing APIs have no time filter, so for "last hour / day /
// week / 4 weeks" we remove site data (cookies, storage) for the sites that
// appear in history during that period, and empty the HTTP cache completely
// (it only holds re-downloadable copies). "All time" wipes everything.
const CLEAR_RANGES = { hour: 3600e3, day: 24 * 3600e3, week: 7 * 24 * 3600e3, month: 28 * 24 * 3600e3, all: Infinity };
const CLEAR_TYPES = ['history', 'downloads', 'cookies', 'cache', 'siteSettings'];
const ALL_STORAGES = ['cookies', 'filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage'];
const hostFromUrl = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

ipcMain.handle('data:clear', async (_e, opts = {}) => {
  const range = Object.prototype.hasOwnProperty.call(CLEAR_RANGES, opts?.range) ? opts.range : 'hour';
  const types = new Set((Array.isArray(opts?.types) ? opts.types : []).filter((t) => CLEAR_TYPES.includes(t)));
  if (!types.size) return { error: 'Select at least one type of data to clear.' };
  const all = range === 'all';
  const cutoff = all ? 0 : Date.now() - CLEAR_RANGES[range];
  const inRange = (ts) => all || (Number(ts) || 0) >= cutoff;
  const ses = session.defaultSession;
  const result = {};
  const failures = [];

  // Sites visited in the period. Must be captured BEFORE history is removed.
  const hosts = new Set();
  if (!all) for (const h of history) if (inRange(h.visitedAt)) { const host = hostFromUrl(h.url); if (host) hosts.add(host); }
  const hostInScope = (domain) => {
    const d = String(domain || '').replace(/^\./, '').toLowerCase();
    return all || [...hosts].some((h) => h === d || h.endsWith(`.${d}`));
  };

  if (types.has('cookies')) {
    try {
      if (all) {
        await ses.clearStorageData({ storages: ALL_STORAGES });
        result.cookies = 'all sites';
      } else {
        let removed = 0;
        for (const cookie of await ses.cookies.get({})) {
          if (!hostInScope(cookie.domain)) continue;
          const url = `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain).replace(/^\./, '')}${cookie.path || '/'}`;
          try { await ses.cookies.remove(url, cookie.name); removed++; } catch { /* already gone */ }
        }
        for (const host of hosts) {
          for (const scheme of ['https', 'http']) {
            await ses.clearStorageData({ origin: `${scheme}://${host}`, storages: ALL_STORAGES.filter((s) => s !== 'cookies') }).catch(() => {});
          }
        }
        result.cookies = `${removed} cookies, ${hosts.size} sites`;
      }
    } catch (error) { failures.push('cookies and site data'); }
  }
  if (types.has('cache')) {
    try { await ses.clearCache(); await ses.clearCodeCaches({}).catch(() => {}); result.cache = true; }
    catch (error) { failures.push('cached files'); }
  }
  if (types.has('history')) {
    const before = history.length;
    history = all ? [] : history.filter((h) => !inRange(h.visitedAt));
    writeJson('history.json', history);
    result.history = before - history.length;
  }
  if (types.has('downloads')) {
    const before = downloads.length;
    downloads = downloads.filter((d) => !['completed', 'cancelled', 'interrupted'].includes(d.state) || !inRange(d.startedAt));
    persistDownloads(true);
    result.downloads = before - downloads.length;
  }
  if (types.has('siteSettings')) {
    result.siteSettings = allowlistedSites.length;
    allowlistedSites = [];
    persistSettings();
  }
  push();
  return failures.length ? { error: `Couldn’t clear ${failures.join(' and ')}.`, cleared: result } : { ok: true, cleared: result };
});

ipcMain.handle('downloads:clear', () => {
  downloads = downloads.filter((entry) => !['completed', 'cancelled', 'interrupted'].includes(entry.state));
  persistDownloads(true); push(); return true;
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
  // Accelerators are handled in bindShortcuts() on every surface; the menu only
  // displays them (registerAccelerator: false on Windows/Linux) to avoid double firing.
  const item = (label, accelerator, name, arg) => ({ label, accelerator, registerAccelerator: false, click: () => command(name, arg) });
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'Tabs', submenu: [
      item('New tab', 'CmdOrCtrl+T', 'new'),
      item('Reopen closed tab', 'CmdOrCtrl+Shift+T', 'reopen-tab'),
      item('Close tab', 'CmdOrCtrl+W', 'close'),
      item('Close window', 'CmdOrCtrl+Shift+W', 'close-window'),
      { type: 'separator' },
      item('Next tab', 'Ctrl+Tab', 'next-tab'),
      item('Previous tab', 'Ctrl+Shift+Tab', 'previous-tab'),
      item('Search open tabs', 'CmdOrCtrl+Shift+L', 'tab-search'),
      item('Select tab 1–8', 'CmdOrCtrl+1', 'select-tab', 1),
      item('Select last tab', 'CmdOrCtrl+9', 'select-tab', 9)
    ]},
    { label: 'Browser', submenu: [
      item('Command palette', 'CmdOrCtrl+K', 'palette'), item('Address bar', 'CmdOrCtrl+L', 'address'),
      item('Home', mac ? 'Cmd+Shift+H' : 'Alt+Home', 'home'),
      item('Bookmark page', 'CmdOrCtrl+D', 'bookmark'), item('Bookmarks manager', 'CmdOrCtrl+Shift+B', 'bookmarks'),
      item('History', 'CmdOrCtrl+H', 'history'), item('Downloads', 'CmdOrCtrl+J', 'downloads'), item('Extensions', 'CmdOrCtrl+Shift+E', 'extensions'),
      item('Clear browsing data…', 'CmdOrCtrl+Shift+Delete', 'clear-data'),
      { type: 'separator' },
      item('Find in page', 'CmdOrCtrl+F', 'find'), item('Find next', 'CmdOrCtrl+G', 'find-next', 'next'), item('Find previous', 'CmdOrCtrl+Shift+G', 'find-next', 'previous'),
      item('Print…', 'CmdOrCtrl+P', 'print'),
      { type: 'separator' },
      item('Reload', 'CmdOrCtrl+R', 'reload'), item('Hard reload', 'CmdOrCtrl+F5', 'reload', 'hard'),
      item('Back', mac ? 'Cmd+[' : 'Alt+Left', 'back'), item('Forward', mac ? 'Cmd+]' : 'Alt+Right', 'forward'),
      item('Reader mode', 'CmdOrCtrl+Shift+R', 'reader'), item('Toggle ad blocker', 'CmdOrCtrl+Shift+A', 'adblock'),
      { type: 'separator' },
      item('Settings', 'CmdOrCtrl+,', 'settings'), item('Developer tools', 'F12', 'devtools')
    ]},
    { label: 'View', submenu: [
      item('Zoom in', 'CmdOrCtrl+Plus', 'zoom-in'), item('Zoom out', 'CmdOrCtrl+-', 'zoom-out'), item('Actual size', 'CmdOrCtrl+0', 'zoom-reset'),
      { type: 'separator' },
      item('Toggle full screen', 'F11', 'fullscreen')
    ]},
    { role: 'editMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app
function setupSession() {
  const ses = session.defaultSession;
  ses.on('will-download', (_event, item, sourceContents) => {
    const sourceId = sourceContents && !sourceContents.isDestroyed() ? sourceContents.id : 0;
    if (sourceId) downloadOwners.set(sourceId, (downloadOwners.get(sourceId) || 0) + 1);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = item.getFilename() || 'download';
    let targetDir = downloadDirectory || app.getPath('downloads');
    try { fs.mkdirSync(targetDir, { recursive: true }); }
    catch {
      targetDir = app.getPath('downloads');
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch { targetDir = app.getPath('userData'); }
    }
    const baseName = path.basename(filename);
    const extension = path.extname(baseName);
    const stem = path.basename(baseName, extension);
    let preferredPath = path.join(targetDir, baseName);
    let suffix = 1;
    while (fs.existsSync(preferredPath)) { preferredPath = path.join(targetDir, `${stem} (${suffix++})${extension}`); }
    if (!askWhereToSave) item.setSavePath(preferredPath);
    else {
      item.pause();
      dialog.showSaveDialog(win, { defaultPath: preferredPath, title: 'Save download' }).then((result) => {
        if (result.canceled || !result.filePath) item.cancel();
        else { item.setSavePath(result.filePath); item.resume(); }
      }).catch(() => item.cancel());
    }
    const entry = {
      id, filename: path.basename(preferredPath), url: item.getURL(), savePath: item.getSavePath() || (askWhereToSave ? '' : preferredPath),
      receivedBytes: 0, totalBytes: item.getTotalBytes(), state: 'progressing',
      mimeType: item.getMimeType() || '', startedAt: Date.now()
    };
    downloads.push(entry);
    activeDownloads.set(id, item);
    persistDownloads(); push();
    item.on('updated', () => recordDownload(item, id));
    item.once('done', (_doneEvent, state) => {
      const final = downloads.find((record) => record.id === id);
      if (final) { final.state = state; final.savePath = item.getSavePath() || final.savePath; final.receivedBytes = item.getReceivedBytes(); final.totalBytes = item.getTotalBytes(); }
      activeDownloads.delete(id);
      if (sourceId) { const left = (downloadOwners.get(sourceId) || 1) - 1; if (left > 0) downloadOwners.set(sourceId, left); else downloadOwners.delete(sourceId); }
      persistDownloads(true); push();
    });
  });
  // Remove the Electron product token, leaving Chromium's platform UA intact.
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sdrift\/\S+/i, ''));
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission)));
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!adBlockEnabled || details.resourceType === 'mainFrame') return callback({});
    const blockedHost = blockedDomainFor(requestHost(details.url));
    if (!blockedHost) return callback({});
    // Only blocked requests pay for the allow-list check.
    const initiatorHost = hostnameOf(details.initiator || details.referrer || '');
    if (initiatorHost && isSiteAllowed(initiatorHost)) return callback({});
    blockedCount += 1;
    blockedHostCounts[blockedHost] = (blockedHostCounts[blockedHost] || 0) + 1;
    pushBlockedSoon();
    callback({ cancel: true });
  });
}


// ---------------------------------------------------------------- window state
const WINDOW_FILE = 'window.json';
let windowStateTimer = null;
function initialWindowBounds() {
  const bounds = { width: 1360, height: 860, startMaximized: windowStart === 'maximized' };
  if (windowStart !== 'remember') return bounds;
  const saved = readJson(WINDOW_FILE, null);
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return bounds;
  bounds.width = Math.min(Math.max(Math.round(saved.width), 760), 10000);
  bounds.height = Math.min(Math.max(Math.round(saved.height), 480), 10000);
  bounds.startMaximized = saved.maximized === true;
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => saved.x < a.x + a.width - 60 && saved.x + bounds.width > a.x + 60 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 60);
    if (onScreen) { bounds.x = Math.round(saved.x); bounds.y = Math.round(saved.y); }
  }
  return bounds;
}
function saveWindowState() {
  clearTimeout(windowStateTimer);
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const b = win.getNormalBounds();
  writeJson(WINDOW_FILE, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
}
function scheduleWindowState() {
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(saveWindowState, 500);
  windowStateTimer.unref?.();
}

async function start() {
  ensureUserDataDirectories();
  // A downloaded update that was not installed when Drift last closed is applied now, before any window opens.
  // The installer starts Drift again by itself, so 'exit' simply ends this process.
  const settingsOnDisk = readJson(SETTINGS_FILE, {});
  autoUpdate = settingsOnDisk.autoUpdate !== false;
  usageReports = settingsOnDisk.usageReports !== false;
  const updateGate = await updater.prepareStartup();
  if (updateGate === 'exit') { app.exit(0); return; }
  if (updateGate === 'restart') { app.relaunch(); app.exit(0); return; }
  const savedBookmarks = readJson('bookmarks.json', []);
  bookmarks = Array.isArray(savedBookmarks) ? savedBookmarks.filter((b) => b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url)).map((b) => ({
    title: typeof b.title === 'string' && b.title.trim() ? b.title : b.url,
    url: b.url,
    ...(typeof b.folder === 'string' && b.folder.trim() ? { folder: b.folder.trim().slice(0, 80) } : {}),
    ...(Number.isFinite(b.addedAt) ? { addedAt: b.addedAt } : {})
  })) : [];
  const savedHistory = readJson('history.json', []);
  history = Array.isArray(savedHistory) ? savedHistory.filter((h) => h && typeof h.url === 'string' && /^https?:\/\//i.test(h.url)).slice(-1000).map((entry) => ({
    ...entry,
    id: typeof entry.id === 'string' && entry.id ? entry.id : `${Number(entry.visitedAt) || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof entry.title === 'string' && entry.title ? entry.title : entry.url,
    visitedAt: Number.isFinite(entry.visitedAt) ? entry.visitedAt : 0
  })) : [];
  const settings = readJson(SETTINGS_FILE, {});
  adBlockEnabled = settings.adBlockEnabled !== false;
  appearance = APPEARANCES.includes(settings.appearance) ? settings.appearance : 'system';
  colorTheme = COLOR_THEME_IDS.includes(settings.colorTheme) ? settings.colorTheme : 'violet';
  searchEngine = SEARCH_ENGINES.includes(settings.searchEngine) ? settings.searchEngine : 'duckduckgo';
  // Older builds only had a "Restore previous session" switch.
  // Fresh installs (no saved choice) open a fresh New Tab page. Only an old build that explicitly
  // had "restore previous session" switched on keeps that behaviour.
  startupMode = STARTUP_MODES.includes(settings.startupMode) ? settings.startupMode : (settings.restoreSession === true ? 'previous' : 'newtab');
  startupPages = cleanStartupPages(settings.startupPages);
  homepage = normalizeUrlSetting(settings.homepage);
  showHomeButton = settings.showHomeButton === true;
  newTabOpens = NEWTAB_OPEN_MODES.includes(settings.newTabOpens) ? settings.newTabOpens : 'newtab';
  newTabShortcuts = SHORTCUT_MODES.includes(settings.newTabShortcuts) ? settings.newTabShortcuts : 'smart';
  newTabClock = settings.newTabClock !== false;
  windowStart = WINDOW_START_MODES.includes(settings.windowStart) ? settings.windowStart : 'default';
  launchAtLogin = app.isPackaged && process.platform !== 'linux' ? !!app.getLoginItemSettings().openAtLogin : settings.launchAtLogin === true;
  autoUpdate = settings.autoUpdate !== false;
  usageReports = settings.usageReports !== false;
  applyAppearance();
  showBookmarksBar = settings.showBookmarksBar !== false;
  askWhereToSave = settings.askWhereToSave === true;
  toolbarPins = cleanToolbarPins(settings.toolbarPins);
  downloadDirectory = typeof settings.downloadDirectory === 'string' && settings.downloadDirectory ? settings.downloadDirectory : app.getPath('downloads');
  try { fs.mkdirSync(downloadDirectory, { recursive: true }); } catch { downloadDirectory = app.getPath('downloads'); }
  downloads = readJson('downloads.json', []);
  if (!Array.isArray(downloads)) downloads = [];
  downloads = downloads.map((entry) => entry && entry.state === 'progressing' ? { ...entry, state: 'interrupted' } : entry).filter(Boolean);
  allowlistedSites = Array.isArray(settings.allowlistedSites)
    ? [...new Set(settings.allowlistedSites.filter((x) => typeof x === 'string' && /^[a-z0-9.-]+$/i.test(x)).map((x) => x.toLowerCase()))].slice(-300)
    : [];
  if (!fs.existsSync(file(SETTINGS_FILE))) persistSettings(); // first run: store the defaults right away
  setupSession();
  // Extensions load in parallel with the window and browser chrome; the first page waits for them below.
  const extensionsReady = extensions.restore().catch((error) => console.warn('Drift could not restore extensions:', error?.message || error));
  buildMenu();

  const windowBounds = initialWindowBounds();
  win = new BaseWindow({
    ...windowBounds, minWidth: 420, minHeight: 320, title: 'Drift', show: false,
    frame: !IS_WINDOWS, resizable: true, maximizable: true, minimizable: true, closable: true,
    icon: path.join(ROOT_DIR, 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11131b' : '#f5f6fa'
  });
  win.setMenuBarVisibility(false);
  if (windowBounds.startMaximized) win.maximize();
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#11131b' : '#f5f6fa'); });

  const uiPrefs = { preload: PRELOAD_PATH, contextIsolation: true, sandbox: true };
  ui = new WebContentsView({ webPreferences: uiPrefs });
  ui.setBackgroundColor('#00000000');
  bindShortcuts(ui.webContents);
  installWebContentsContextMenu(ui.webContents, 'chrome');
  ui.webContents.on('will-navigate', (e) => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.contentView.addChildView(ui);

  // Ensure local browser chrome is ready before display. The command palette
  // is created only on demand, reducing cold-start work and memory use.
  await ui.webContents.loadFile(path.join(RENDERER_DIR, 'browser', 'index.html'));

  win.on('resize', layout);
  // Re-layout on every state change that can alter the content size, not just drag-resizes.
  for (const evt of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen', 'resized']) win.on(evt, layout);
  const relayout = () => { if (win && !win.isDestroyed()) layout(); };
  screen.on('display-metrics-changed', relayout);
  screen.on('display-added', relayout);
  screen.on('display-removed', relayout);
  win.on('resize', scheduleWindowState);
  win.on('move', scheduleWindowState);
  win.on('maximize', () => { push(); scheduleWindowState(); });
  win.on('unmaximize', () => { push(); scheduleWindowState(); });
  win.on('close', saveWindowState);
  win.on('closed', () => {
    saveSessionNow();
    clearTimeout(sessionTimer);
    clearTimeout(pushTimer);
    for (const t of cur.tabs) if (t.view && !t.view.webContents.isDestroyed()) t.view.webContents.close();
  });

  // Restore metadata, but only instantiate the selected tab's WebContents.
  const saved = startupMode === 'previous' ? readJson('session.json', null) : null;
  // Migrate both the new flat session format and the legacy three-space format.
  const restored = Array.isArray(saved?.tabs) ? saved.tabs : (saved?.spaces || []).flatMap((space) => space.tabs || []);
  for (const t of restored) {
    const url = !t.url || isNewTabUrl(t.url) || /\/(?:ui|renderer\/newtab)\/newtab\.html$/.test(t.url) ? newTabUrl() : t.url;
    cur.tabs.push({ id: nextId++, title: t.title || 'New tab', url, favicon: t.favicon || '', loading: false, lastActive: Date.now(), view: null });
  }
  if (Array.isArray(saved?.tabs)) cur.active = cur.tabs[saved.active] || cur.tabs[0] || null;
  else {
    const oldSpaces = Array.isArray(saved?.spaces) ? saved.spaces : [];
    const previousSpaceIndex = oldSpaces.findIndex((space) => space.name === saved?.space);
    const previousSpace = previousSpaceIndex >= 0 ? oldSpaces[previousSpaceIndex] : null;
    const offset = previousSpaceIndex > 0 ? oldSpaces.slice(0, previousSpaceIndex).reduce((total, space) => total + (Array.isArray(space.tabs) ? space.tabs.length : 0), 0) : 0;
    const activeIndex = offset + (Number.isInteger(previousSpace?.active) ? previousSpace.active : 0);
    cur.active = cur.tabs[activeIndex] || cur.tabs[0] || null;
  }

  if (!cur.tabs.length) {
    // "Open specific pages" / "Open the home page", or a fresh New Tab page when nothing was restored.
    const pages = startupMode === 'specific' ? startupPages : (startupMode === 'homepage' && homepage ? [homepage] : []);
    for (const url of pages) cur.tabs.push({ id: nextId++, title: hostnameOf(url) || 'New tab', url, favicon: '', loading: false, lastActive: Date.now(), view: null });
    if (!cur.tabs.length) cur.tabs.push({ id: nextId++, title: 'New tab', url: newTabUrl(), favicon: '', loading: false, lastActive: Date.now(), view: null });
    cur.active = cur.tabs[0];
  }

  await extensionsReady; // content scripts must be registered before the first page loads
  layout();
  if (cur.tabs.length) {
    const initialTab = cur.active || cur.tabs[0];
    activateTab(initialTab);
    if (isNewTabUrl(initialTab.url)) focusNewTab(initialTab);
  } else createTab();
  win.show();
  // Focus requested before the window was visible can be dropped, so ask again once it is shown.
  if (cur.active && isNewTabUrl(cur.active.url)) setTimeout(() => { if (win && !win.isDestroyed() && !paletteOpen) focusNewTab(cur.active); }, 200);
  const discardTimer = setInterval(discardIdleTabs, 15 * 1000);
  discardTimer.unref?.();
  updater.start(); // background check shortly after startup; installs when Drift closes
  telemetry.start(); // "open" a few seconds after launch, then a heartbeat every minute
}

if (process.platform === 'win32') app.setAppUserModelId('org.drift.browser');
// Lower baseline memory: switch off Chromium background services a browser this size does not use (translation
// prompts, Cast discovery, optimization-hint downloads, autofill server calls). Must run before the app is ready.
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,AutofillServerCommunication');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start).catch((error) => {
    console.error('Drift failed to start:', error);
    app.quit();
  });
  let closeReported = false;
  app.on('before-quit', (event) => {
    persistSettings(); // final flush so no preference change can be lost
    if (win && !win.isDestroyed()) saveSessionNow();
    storage.flushAll(); // history, downloads and anything else still waiting on a debounce timer
    // Tell the monitor this session ended, then quit for real. The report is capped at a couple of seconds
    // (reportCloseTimeoutMs) so closing Drift never feels slow, and it runs only once.
    if (!closeReported && telemetry.hasOpenSession() && usageReports) {
      closeReported = true;
      event.preventDefault();
      telemetry.stop().catch(() => {}).finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => app.quit());
}
