const { app, BaseWindow, WebContentsView, Menu, ipcMain, session, nativeTheme, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Keep Drift's writable profile in the current user's AppData (Windows),
// Application Support (macOS), or XDG config directory (Linux). The actual
// application binaries are installed separately by the per-user installer.
app.setName('Drift');
const LEGACY_USER_DATA_DIRECTORY = app.getPath('userData');
const APP_DATA_DIRECTORY = path.join(app.getPath('appData'), 'Drift');
app.setPath('userData', APP_DATA_DIRECTORY);
const EXTENSIONS_DIRECTORY = path.join(APP_DATA_DIRECTORY, 'Extensions');

// ---------------------------------------------------------------- config
const IS_WINDOWS = process.platform === 'win32';
const CHROME_H_WITH_BOOKMARKS = 108; // tab strip + navigation toolbar + bookmarks bar
const CHROME_H_WITHOUT_BOOKMARKS = 82;
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
function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function ensureUserDataDirectories() {
  fs.mkdirSync(APP_DATA_DIRECTORY, { recursive: true });
  fs.mkdirSync(EXTENSIONS_DIRECTORY, { recursive: true });
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
const writeJson = (f, v) => {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const target = file(f);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(v, null, 2));
    fs.renameSync(temp, target);
  } catch (error) {
    console.error(`Drift could not save profile file ${f}:`, error?.message || error);
  }
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
let colorTheme = 'violet';
let searchEngine = 'duckduckgo';
let restoreSession = true;
let showBookmarksBar = true;
let downloadDirectory = app.getPath('downloads');
let askWhereToSave = false;
let blockedHostCounts = Object.create(null);
let downloads = [];
let downloadPersistTimer = null;
let extensionDirectories = [];
let findState = { visible: false, query: '', matchCase: false, activeMatchOrdinal: 0, matches: 0 };
// A single browser workspace replaces the former Home / Work / Fun spaces.
const spaces = [{ name: 'Browser', tabs: [], active: null }];
let cur = spaces[0];
const activeTab = () => cur.active;

// ---------------------------------------------------------------- helpers
function newTabUrl() { return `${NEWTAB}?engine=${encodeURIComponent(searchEngine)}&theme=${encodeURIComponent(colorTheme)}&mode=${encodeURIComponent(appearance)}`; }
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
  for (const s of spaces) for (const t of s.tabs) t.view?.setBounds(tabBounds());
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
    extensions: activeInternalPage === 'extensions' ? getExtensionList() : [],
    find: { ...findState },
    blocked: blockedCount,
    adBlockEnabled,
    currentHost: host,
    siteAllowed: isSiteAllowed(host),
    blockedHosts: Object.entries(blockedHostCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hostName, count]) => ({ host: hostName, count })),
    settings: { appearance, colorTheme, searchEngine, restoreSession, showBookmarksBar, downloadDirectory, askWhereToSave },
    profileDirectory: app.getPath('userData'),
    extensionsDirectory: EXTENSIONS_DIRECTORY,
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
    active: cur.tabs.indexOf(cur.active),
    tabs: cur.tabs.map((t) => ({ title: t.title, url: t.url, favicon: t.favicon }))
  });
}
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSessionNow, 350);
}

function addHistory(title, url) {
  if (!/^https?:/i.test(url || '')) return;
  history.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: title || url, url, visitedAt: Date.now() });
  if (history.length > 1000) history.splice(0, history.length - 1000);
  writeJson('history.json', history);
}

function sortedBookmarks() {
  if (!bookmarksSortedCache) bookmarksSortedCache = bookmarks.slice().sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url));
  return bookmarksSortedCache;
}
function persistBookmarks() { bookmarksSortedCache = null; writeJson('bookmarks.json', bookmarks); }
function persistSettings() { writeJson(SETTINGS_FILE, { adBlockEnabled, allowlistedSites, appearance, colorTheme, searchEngine, restoreSession, showBookmarksBar, downloadDirectory, askWhereToSave }); }


function persistDownloads(immediate = false) {
  if (immediate) {
    clearTimeout(downloadPersistTimer);
    downloadPersistTimer = null;
    writeJson('downloads.json', downloads.slice(-300));
    return;
  }
  if (downloadPersistTimer) return;
  downloadPersistTimer = setTimeout(() => {
    downloadPersistTimer = null;
    writeJson('downloads.json', downloads.slice(-300));
  }, 700);
  downloadPersistTimer.unref?.();
}
function getExtensionList() {
  try {
    return session.defaultSession.extensions.getAllExtensions().map((extension) => ({
      id: extension.id, name: extension.name || 'Unnamed extension', version: extension.version || '',
      description: extension.manifest?.description || '', path: extension.path || ''
    }));
  } catch { return []; }
}

const activeDownloads = new Map();
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

function extensionDirectoryName(manifest) {
  const rawName = String(manifest?.name || 'extension').replace(/__MSG_.*?__/g, 'extension');
  const safeName = rawName.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'extension';
  return `${safeName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function installExtensionFromFolder(folder) {
  const chosenFolder = String(folder || '').trim();
  if (!chosenFolder) throw new Error('Select an unpacked extension folder containing manifest.json.');
  const sourceFolder = path.resolve(chosenFolder);
  const sourceManifestPath = path.join(sourceFolder, 'manifest.json');
  if (!fs.existsSync(sourceManifestPath)) throw new Error('Select an unpacked extension folder containing manifest.json.');

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8')); }
  catch { throw new Error('The selected extension has an invalid manifest.json file.'); }
  if (!manifest || ![2, 3].includes(Number(manifest.manifest_version))) throw new Error('The extension manifest must use Chromium Manifest V2 or V3.');

  // Extension files are copied into the Drift profile so their availability
  // does not depend on the original ZIP/extraction folder or removable drive.
  let managedFolder = sourceFolder;
  let copiedFolder = false;
  if (!isPathInside(EXTENSIONS_DIRECTORY, sourceFolder)) {
    managedFolder = path.join(EXTENSIONS_DIRECTORY, extensionDirectoryName(manifest));
    try { fs.cpSync(sourceFolder, managedFolder, { recursive: true, errorOnExist: true, force: false, dereference: true }); }
    catch (error) { throw new Error(`Could not copy the extension into Drift's AppData profile: ${error?.message || error}`); }
    copiedFolder = true;
  }

  const existing = extensionDirectories.find((entry) => path.resolve(entry) === path.resolve(managedFolder));
  if (existing) return getExtensionList();
  try {
    await session.defaultSession.extensions.loadExtension(managedFolder, { allowFileAccess: false });
  } catch (error) {
    if (copiedFolder) { try { fs.rmSync(managedFolder, { recursive: true, force: true }); } catch { /* preserve install error */ } }
    throw error;
  }
  extensionDirectories.push(managedFolder);
  writeJson('extensions.json', extensionDirectories);
  push();
  return getExtensionList();
}

// ---------------------------------------------------------------- tabs
function attachView(tab) {
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: true } });
  tab.view = view;
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  view.setBounds(tabBounds());
  view.setVisible(false);

  const wc = view.webContents;
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
    const h = [...history].reverse().find((x) => x.url === tab.url);
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

function createTab(input) {
  const tab = { id: nextId++, title: 'New tab', url: input ? resolve(input) : newTabUrl(), favicon: '', loading: false, lastActive: Date.now(), view: null };
  cur.tabs.push(tab);
  activateTab(tab);
  saveSession();
  if (!input) focusAddress();
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
  for (const t of cur.tabs) t.view?.setVisible(false);
  cur.active = tab;
  tab.lastActive = Date.now();
  if (isInternalUrl(tab.url)) {
    tab.title = internalTitle(internalPageName(tab.url));
    setUIOverlay(true);
    push();
    saveSession();
    return;
  }
  if (!tab.view) safelyLoad(attachView(tab), tab.url || newTabUrl());
  tab.url = liveUrl(tab) || tab.url;
  tab.view.setBounds(tabBounds());
  tab.view.setVisible(true);
  if (!paletteOpen) tab.view.webContents.focus();
  setUIOverlay(false);
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
  clearFindState();
  const url = resolve(text);
  let t = activeTab();
  if (!t) { createTab(text); return; }
  if (isInternalUrl(url)) {
    if (!isInternalUrl(t.url)) t.previousUrl = liveUrl(t) || t.url || newTabUrl();
    t.url = url;
    t.title = internalTitle(internalPageName(url));
    t.loading = false;
    activateTab(t);
    return;
  }
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

function openInternalPage(page, newTab = false) {
  const target = `drift://${page}`;
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
  if (isInternalUrl(activeTab()?.url)) ui?.webContents.focus();
  else activeTab()?.view?.webContents.focus();
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
    ['New tab', 'new'], ['Close tab', 'close'], ['Next tab', 'next-tab'], ['Previous tab', 'previous-tab'], ['Reader mode', 'reader'],
    ['Bookmark or unbookmark this page', 'bookmark'], ['Open bookmarks manager', 'bookmarks'],
    ['Open history', 'history'], ['Open downloads', 'downloads'], ['Open extensions', 'extensions'], ['Open settings', 'settings'],
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

// ---------------------------------------------------------------- commands
function command(name, arg) {
  const t = activeTab();
  const wc = t?.view?.webContents;
  switch (name) {
    case 'new': createTab(arg); break;
    case 'close': { const target = arg ? cur.tabs.find((x) => x.id === arg) : t; if (target) closeTab(target); break; }
    case 'activate': { const target = cur.tabs.find((x) => x.id === arg); if (target) activateTab(target); break; }
    case 'next-tab': if (cur.tabs.length > 1) activateTab(cur.tabs[(cur.tabs.indexOf(t) + 1 + cur.tabs.length) % cur.tabs.length]); break;
    case 'previous-tab': if (cur.tabs.length > 1) activateTab(cur.tabs[(cur.tabs.indexOf(t) - 1 + cur.tabs.length) % cur.tabs.length]); break;
    case 'go': go(arg); break;
    case 'back': if (isInternalUrl(t?.url)) go(t.previousUrl || newTabUrl()); else if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': {
      const target = arg ? cur.tabs.find((x) => x.id === arg) : t;
      if (target && !target.view) activateTab(target);
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
        if (index >= 0) cur.tabs.splice(index, 1);
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
    case 'downloads': openInternalPage('downloads'); break;
    case 'extensions': openInternalPage('extensions'); break;
    case 'settings': openInternalPage('settings'); break;
    case 'open-profile-folder': shell.openPath(app.getPath('userData')); break;
    case 'find': if (wc && !isInternalUrl(t?.url)) { findState.visible = true; setUIOverlay(true); ui?.webContents.send('find:show'); push(); } break;
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
  if (['system', 'light', 'dark'].includes(patch.appearance) && patch.appearance !== appearance) { appearance = patch.appearance; refreshNewTabs = true; }
  if (['violet', 'ocean', 'forest', 'rose', 'sunset', 'indigo', 'graphite', 'mint'].includes(patch.colorTheme) && patch.colorTheme !== colorTheme) { colorTheme = patch.colorTheme; refreshNewTabs = true; }
  if (['duckduckgo', 'google', 'bing', 'brave'].includes(patch.searchEngine) && patch.searchEngine !== searchEngine) { searchEngine = patch.searchEngine; refreshNewTabs = true; }
  if (typeof patch.restoreSession === 'boolean') restoreSession = patch.restoreSession;
  if (typeof patch.showBookmarksBar === 'boolean') showBookmarksBar = patch.showBookmarksBar;
  if (typeof patch.askWhereToSave === 'boolean') askWhereToSave = patch.askWhereToSave;
  if (typeof patch.downloadDirectory === 'string' && patch.downloadDirectory.trim()) downloadDirectory = patch.downloadDirectory.trim();
  if (typeof patch.adBlockEnabled === 'boolean') adBlockEnabled = patch.adBlockEnabled;
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
  try { await installExtensionFromFolder(result.filePaths[0]); return { ok: true }; }
  catch (error) { return { error: error?.message || 'The extension could not be installed.' }; }
});
ipcMain.handle('extensions:remove', async (_event, id) => {
  const extensionId = String(id || '');
  const extension = getExtensionList().find((entry) => entry.id === extensionId);
  if (!extension) return { error: 'Extension not found.' };
  try {
    await session.defaultSession.extensions.removeExtension(extensionId);
    extensionDirectories = extensionDirectories.filter((folder) => path.resolve(folder) !== path.resolve(extension.path));
    if (isPathInside(EXTENSIONS_DIRECTORY, extension.path)) {
      try { fs.rmSync(extension.path, { recursive: true, force: true }); }
      catch (error) { console.warn('Drift could not remove extension files:', error?.message || error); }
    }
    writeJson('extensions.json', extensionDirectories); push(); return { ok: true };
  } catch (error) { return { error: error?.message || 'Could not remove extension.' }; }
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
  const item = (label, accelerator, name, arg) => ({ label, accelerator, click: () => command(name, arg) });
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'Browser', submenu: [
      item('Command palette', 'CmdOrCtrl+K', 'palette'), item('New tab', 'CmdOrCtrl+T', 'new'),
      item('Close tab', 'CmdOrCtrl+W', 'close'), item('Next tab', 'Ctrl+Tab', 'next-tab'), item('Previous tab', 'Ctrl+Shift+Tab', 'previous-tab'), item('Address bar', 'CmdOrCtrl+L', 'address'),
      item('Bookmark page', 'CmdOrCtrl+D', 'bookmark'), item('Bookmarks manager', 'CmdOrCtrl+Shift+B', 'bookmarks'),
      item('History', 'CmdOrCtrl+H', 'history'), item('Downloads', 'CmdOrCtrl+J', 'downloads'), item('Extensions', 'CmdOrCtrl+Shift+E', 'extensions'), item('Find in page', 'CmdOrCtrl+F', 'find'),
      item('Reload', 'CmdOrCtrl+R', 'reload'), item('Back', mac ? 'Cmd+[' : 'Alt+Left', 'back'),
      item('Forward', mac ? 'Cmd+]' : 'Alt+Right', 'forward'), item('Reader mode', 'CmdOrCtrl+Shift+R', 'reader'),
      item('Toggle ad blocker', 'CmdOrCtrl+Shift+A', 'adblock'), { type: 'separator' },
      { type: 'separator' }, item('Settings', 'CmdOrCtrl+,', 'settings'), item('Developer tools', 'F12', 'devtools')
    ]},
    { role: 'editMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app
function setupSession() {
  const ses = session.defaultSession;
  ses.on('will-download', (_event, item) => {
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
      persistDownloads(true); push();
    });
  });
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
  ensureUserDataDirectories();
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
  appearance = ['system', 'light', 'dark'].includes(settings.appearance) ? settings.appearance : 'system';
  colorTheme = ['violet', 'ocean', 'forest', 'rose', 'sunset', 'indigo', 'graphite', 'mint'].includes(settings.colorTheme) ? settings.colorTheme : 'violet';
  searchEngine = ['duckduckgo', 'google', 'bing', 'brave'].includes(settings.searchEngine) ? settings.searchEngine : 'duckduckgo';
  restoreSession = settings.restoreSession !== false;
  showBookmarksBar = settings.showBookmarksBar !== false;
  askWhereToSave = settings.askWhereToSave === true;
  downloadDirectory = typeof settings.downloadDirectory === 'string' && settings.downloadDirectory ? settings.downloadDirectory : app.getPath('downloads');
  try { fs.mkdirSync(downloadDirectory, { recursive: true }); } catch { downloadDirectory = app.getPath('downloads'); }
  downloads = readJson('downloads.json', []);
  if (!Array.isArray(downloads)) downloads = [];
  downloads = downloads.map((entry) => entry && entry.state === 'progressing' ? { ...entry, state: 'interrupted' } : entry).filter(Boolean);
  extensionDirectories = readJson('extensions.json', []);
  if (!Array.isArray(extensionDirectories)) extensionDirectories = [];
  allowlistedSites = Array.isArray(settings.allowlistedSites)
    ? [...new Set(settings.allowlistedSites.filter((x) => typeof x === 'string' && /^[a-z0-9.-]+$/i.test(x)).map((x) => x.toLowerCase()))].slice(-300)
    : [];
  setupSession();
  const restoredExtensionDirectories = [];
  for (const savedFolder of extensionDirectories.slice()) {
    let folder = path.resolve(String(savedFolder || ''));
    try {
      const manifestPath = path.join(folder, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      if (!isPathInside(EXTENSIONS_DIRECTORY, folder)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const managedFolder = path.join(EXTENSIONS_DIRECTORY, extensionDirectoryName(manifest));
        fs.cpSync(folder, managedFolder, { recursive: true, errorOnExist: true, force: false, dereference: true });
        folder = managedFolder;
      }
      await session.defaultSession.extensions.loadExtension(folder, { allowFileAccess: false });
      restoredExtensionDirectories.push(folder);
    } catch (error) {
      console.warn('Drift skipped an unavailable extension:', folder, error?.message || error);
    }
  }
  if (JSON.stringify(restoredExtensionDirectories) !== JSON.stringify(extensionDirectories)) {
    extensionDirectories = restoredExtensionDirectories;
    writeJson('extensions.json', extensionDirectories);
  }
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
  installWebContentsContextMenu(ui.webContents, 'chrome');
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
    for (const t of cur.tabs) if (t.view && !t.view.webContents.isDestroyed()) t.view.webContents.close();
  });

  // Restore metadata, but only instantiate the selected tab's WebContents.
  const saved = restoreSession ? readJson('session.json', null) : null;
  // Migrate both the new flat session format and the legacy three-space format.
  const restored = Array.isArray(saved?.tabs) ? saved.tabs : (saved?.spaces || []).flatMap((space) => space.tabs || []);
  for (const t of restored) {
    const url = !t.url || isNewTabUrl(t.url) || t.url.endsWith('/ui/newtab.html') ? newTabUrl() : t.url;
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

  layout();
  if (cur.tabs.length) {
    const initialTab = cur.active || cur.tabs[0];
    activateTab(initialTab);
    if (isNewTabUrl(initialTab.url)) focusAddress();
  } else createTab();
  win.show();
  const discardTimer = setInterval(discardIdleTabs, 60 * 1000);
  discardTimer.unref?.();
}

if (process.platform === 'win32') app.setAppUserModelId('org.drift.browser');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start).catch((error) => {
    console.error('Drift failed to start:', error);
    app.quit();
  });
  app.on('before-quit', () => {
    if (win && !win.isDestroyed()) saveSessionNow();
    if (downloadPersistTimer) persistDownloads(true);
  });
  app.on('window-all-closed', () => app.quit());
}
