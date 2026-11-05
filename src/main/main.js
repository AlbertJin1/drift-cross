const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, ipcMain, session, nativeTheme, nativeImage, dialog, shell, clipboard, screen, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createExtensionManager } = require('./extensions');
const { matchShortcut } = require('./shortcuts');
const { createUpdater } = require('./updater');
const { writeUpdateHealthcheck } = require('./update-healthcheck');
const { createTelemetry } = require('./telemetry');
const { createReviewService } = require('./reviews');
const { createReviewPrompt } = require('./review-prompt');
const { createStorage } = require('./storage');
const { spawn } = require('child_process');
const { createProfileManager, ProfileError } = require('./profiles');
const { parseIconImages, writeIcoFile } = require('./taskbar-icon');
const { planDiscards, planFreezes, measurePressure, normalizeTabOptimizationSettings, discardConfigFromSettings } = require('./memory-manager');
const { normalizeAppearanceOptions } = require('./appearance-settings');
const { createRecentlyClosedStore } = require('./recently-closed');
const { normalizeBookmarkUrl, normalizeFavicon, reorderBookmarkList, moveBookmarkBy } = require('./bookmark-utils');
const { evaluatePopup } = require('./protection');

// Project layout: src/main (this file), src/preload, src/renderer/*, build/ (icons).
const ROOT_DIR = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const PAGE_PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'page-preload.js');

// Keep Drift's writable profile in the current user's AppData (Windows),
// Application Support (macOS), or XDG config directory (Linux). The actual
// application binaries are installed separately by the per-user installer.
const APP_USER_MODEL_ID = 'org.drift.browser';
app.setName('Drift');
// Each profile is its own taskbar app (own button, own pin, no grouping with other profiles). The default profile keeps the
// original id so existing shortcuts, pins and notifications keep working.
const profileAppId = (id) => (id === 'default' ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.${id}`);
const LEGACY_USER_DATA_DIRECTORY = app.getPath('userData');
// APP_DATA_DIRECTORY is the folder shared by every profile (profile registry, update files, startup log).
// Each browser profile gets its own userData folder, which is what keeps cookies, logins, site storage,
// cache, extensions, bookmarks, history and settings completely separate (see profiles.js). The "Default"
// profile lives in the shared folder itself, so existing installs keep their data without any migration.
const APP_DATA_DIRECTORY = path.join(app.getPath('appData'), 'Drift');
const profiles = createProfileManager({ rootDir: APP_DATA_DIRECTORY });
const ACTIVE_PROFILE_ID = profiles.resolveActive(process.argv);
// Make every profile folder carry its profile's current name (AppData\Drift\Profiles\<Name>) before this process
// starts using its own folder. Profiles that are open in another window are left alone until they close.
profiles.reconcile();
const PROFILE_DIRECTORY = profiles.dirFor(ACTIVE_PROFILE_ID);
const PROFILE_APP_ID = profileAppId(ACTIVE_PROFILE_ID);
if (process.platform === 'win32') app.setAppUserModelId(PROFILE_APP_ID);
try { fs.mkdirSync(PROFILE_DIRECTORY, { recursive: true }); } catch { /* reported when the first file is written */ }
app.setPath('userData', PROFILE_DIRECTORY);
// Pin every Chromium data location to this profile's folder so cookies, site storage, cache, logs and crash dumps
// can never leak between profiles, even if Electron's default for one of them is derived from somewhere else.
for (const [key, sub] of [['sessionData', ''], ['logs', 'Logs'], ['crashDumps', 'Crashpad']]) {
  try { app.setPath(key, sub ? path.join(PROFILE_DIRECTORY, sub) : PROFILE_DIRECTORY); } catch { /* key not supported on this Electron */ }
}

// ---------------------------------------------------------------- config
const IS_WINDOWS = process.platform === 'win32';
const CHROME_H_WITH_BOOKMARKS = 118; // tab strip (40) + navigation toolbar (44) + bookmarks bar (34)
const CHROME_H_WITHOUT_BOOKMARKS = 84;
// Window background before the chrome paints (matches the Tideline palette, so launch never flashes a foreign colour).
const WINDOW_BG = { dark: '#0f1e24', light: '#eef3f2' };
const windowBg = () => (nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light);
const SETTINGS_VERSION = 7;
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
  'videologygroup.com', 'zedo.com', 'ad.360yield.com', 'ads.yahoo.com', 'analytics.yahoo.com',
  'ads.linkedin.com', 'ads-api.twitter.com', 'ads-twitter.com', 'static.ads-twitter.com', 'ads.tiktok.com',
  'ads-api.tiktok.com', 'bat.bing.com', 'clarity.ms', 'adfox.ru', 'adition.com', 'admanmedia.com',
  'adserver.org', 'adserver.com', 'adtech.de', 'advertising.com', 'advertising.microsoft.com',
  'analytics.pinterest.com', 'app.adjust.com', 'cdn.krxd.net', 'clickserve.dartsearch.net',
  'e-planning.net', 'imasdk.googleapis.com', 'innovid.com', 'media.net', 'moat.com', 'pixel.adsafeprotected.com',
  'pixel.quantserve.com', 'pub.network', 'rtbhouse.com', 'sascdn.com', 'serving-sys.com',
  'smartadserver.com', 'track.adform.net', 'tracking.audience.network', 'yieldlove.com'
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
// Data that belongs to the installation rather than to one browsing profile (review-prompt schedule).
const sharedStorage = createStorage({ getDir: () => APP_DATA_DIRECTORY });
const recentlyClosed = createRecentlyClosedStore({ readJson, writeJson });

ipcMain.on('page:trusted-input', (event) => {
  const id = event.sender?.id;
  if (Number.isInteger(id)) trustedInputAt.set(id, Date.now());
});

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function ensureUserDataDirectories() {
  fs.mkdirSync(APP_DATA_DIRECTORY, { recursive: true });
  fs.mkdirSync(PROFILE_DIRECTORY, { recursive: true });
  fs.mkdirSync(path.join(APP_DATA_DIRECTORY, 'Logs'), { recursive: true });
  profiles.sweep(); // finish deleting any profile whose removal was interrupted
  profiles.markUsed(ACTIVE_PROFILE_ID); // a plain launch next time opens the profile used last
  refreshProfileInfo();
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
  appDataDir: PROFILE_DIRECTORY, // extensions are installed per profile
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
// Set as soon as Drift starts quitting. From then on windows and tab views are being torn down, so every timer
// and callback that touches them must stand down (touching a destroyed Electron object throws).
let quitting = false;
const wcAlive = (wc) => !!wc && !wc.isDestroyed();
const winAlive = () => !!win && !win.isDestroyed();
let nextId = 1;
let lastWindowTitle = '';
let paletteOpen = false;
let uiOverlayOpen = false;
let blockedCount = 0;
let blockedPopupsCount = 0;
const trustedInputAt = new Map();
let bookmarks = [];
let bookmarksSortedCache = null;
let history = [];
let adBlockEnabled = true;
let popupBlockEnabled = true;
let allowlistedSites = [];
let appearance = 'system';
let colorTheme = 'tide';
let appearanceOptions = normalizeAppearanceOptions();
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
let tabOptimizations = normalizeTabOptimizationSettings();
// The profile this window runs. `count` (how many profiles exist) decides whether the window title names it.
let profileInfo = { id: ACTIVE_PROFILE_ID, name: 'Default', color: profiles.PROFILE_COLORS[0], isDefault: ACTIVE_PROFILE_ID === profiles.DEFAULT_ID, count: 1 };
let profileInfoSig = '';
function refreshProfileInfo() {
  try {
    const p = profiles.get(ACTIVE_PROFILE_ID);
    if (p) profileInfo = { id: p.id, name: p.name, color: p.color, isDefault: p.isDefault, count: profiles.count() };
  } catch (error) { console.warn('Drift could not read its profile list:', error?.message || error); }
  const sig = JSON.stringify(profileInfo);
  if (sig === profileInfoSig) return;
  const first = profileInfoSig === '';
  profileInfoSig = sig;
  if (!first) onProfileInfoChanged(); // renamed / recoloured / a profile was added or removed, possibly from another Drift window
}
function onProfileInfoChanged() {
  try { applyTaskbarIdentity(); push(); } catch (error) { startupLog(`profile refresh failed: ${error?.message || error}`); }
}
// Silent updater. Uses its own in-memory session, so the ad blocker, cookies and extensions never see its requests.
let updaterSession = null;
const monitorFetch = (url, init) => (updaterSession ||= session.fromPartition('drift-updater')).fetch(url, init);
// Update files and the anonymous install id are shared by all profiles. An update is only installed when no
// other profile window is open, because replacing the program files would pull them out from under it.
const SHARED_UPDATES_DIRECTORY = path.join(APP_DATA_DIRECTORY, 'Updates');
const updater = createUpdater({
  app,
  fetch: monitorFetch,
  dir: SHARED_UPDATES_DIRECTORY,
  isEnabled: () => autoUpdate && !profiles.othersRunning(ACTIVE_PROFILE_ID)
});
// Usage reporting to the same monitor (open / heartbeat / close). It shares the updater's session and install id.
const telemetry = createTelemetry({
  app,
  fetch: monitorFetch,
  dir: SHARED_UPDATES_DIRECTORY,
  isEnabled: () => usageReports && !profiles.othersRunning(ACTIVE_PROFILE_ID), // one report stream per installation
  force: process.env.DRIFT_REPORT_DEV === '1', // lets `npm start` report to the monitor for testing (set DRIFT_REPORT_DEV=1)
  identity: { get: () => updater.installId(), set: (id) => updater.adoptInstallId(id) }
});
// Reviews share the anonymous install identity and server-side gateway used by the updater/telemetry.
const reviewService = createReviewService({
  app,
  fetch: monitorFetch,
  identity: { get: () => updater.installId(), set: (id) => updater.adoptInstallId(id) }
});
// Automatic review prompts are driven by local accumulated application use, not
// by remote telemetry preferences. The schedule is stored in the Drift profile.
const reviewPrompt = createReviewPrompt({
  readJson: sharedStorage.readJson,
  writeJson: sharedStorage.writeJson,
  getVersion: () => app.getVersion()
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
const COLOR_THEME_IDS = ['tide', 'violet', 'ocean', 'forest', 'rose', 'sunset', 'indigo', 'graphite', 'mint'];
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
  const visual = normalizeAppearanceOptions(appearanceOptions);
  const q = new URLSearchParams({ engine: searchEngine, theme: colorTheme, mode: appearance, sc: newTabShortcuts, clock: newTabClock ? '1' : '0', ntbg: visual.newTabBackground, ntlayout: visual.newTabLayout, nttile: visual.newTabTileSize, ntfont: visual.fontFamily, ntscale: String(visual.fontScale), ntmotion: visual.motion });
  if (visual.accentColor) q.set('accent', visual.accentColor);
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
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
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
  const base = showBookmarksBar ? CHROME_H_WITH_BOOKMARKS : CHROME_H_WITHOUT_BOOKMARKS;
  const scale = normalizeAppearanceOptions(appearanceOptions).fontScale / 100;
  return Math.round(base * scale);
}

function tabBounds() {
  const { width, height } = win.getContentBounds();
  const chromeHeightNow = chromeHeight();
  return { x: 0, y: chromeHeightNow, width: Math.max(0, width), height: Math.max(0, height - chromeHeightNow) };
}

function layout() {
  if (!winAlive()) return;
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
    blockedPopups: blockedPopupsCount,
    adBlockEnabled,
    popupBlockEnabled,
    currentHost: host,
    siteAllowed: isSiteAllowed(host),
    blockedHosts: Object.entries(blockedHostCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hostName, count]) => ({ host: hostName, count })),
    settings: { appearance, colorTheme, appearanceOptions, searchEngine, popupBlockEnabled, startupMode, startupPages, homepage, showHomeButton, newTabOpens, newTabShortcuts, newTabClock, windowStart, launchAtLogin, autoUpdate, usageReports, showBookmarksBar, downloadDirectory, askWhereToSave, toolbarPins, tabOptimizations },
    canAutoUpdate: updater.supported(),
    canReportUsage: telemetry.supported(),
    canLaunchAtLogin: process.platform !== 'linux',
    profileDirectory: app.getPath('userData'),
    profile: profileInfo,
    extensionsDirectory: extensions.directory,
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    updateStatus: updater.getStatus(),
    isMaximized: winAlive() ? !!win.isMaximized() : false
  };
}

let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (quitting || !winAlive()) return;
    try {
    if (ui && wcAlive(ui.webContents)) ui.webContents.send('state', snapshot());
    const t = activeTab();
    const title = (t?.title || 'New tab') + ' — Drift Browser' + (profileInfo.count > 1 || !profileInfo.isDefault ? ` — ${profileInfo.name}` : '');
    if (win && !win.isDestroyed() && title !== lastWindowTitle) {
      lastWindowTitle = title;
      win.setTitle(title);
    }
    } catch (error) { if (!quitting) console.warn('Drift could not refresh its window state:', error?.message || error); }
  }, 50);
}

let sessionTimer = null;
const sessionData = () => ({
  active: cur.tabs.indexOf(cur.active),
  tabs: cur.tabs.map((t) => ({
    title: t.view && wcAlive(t.view.webContents) ? (t.view.webContents.getTitle() || t.title) : t.title,
    url: liveUrl(t) || t.url,
    favicon: t.favicon
  }))
});
let closedWindowRecorded = false;
function recordClosedBrowserWindow() {
  if (closedWindowRecorded) return false;
  closedWindowRecorded = true;
  // When "Continue where you left off" is enabled, the same window is restored
  // automatically at startup; keeping another copy in Ctrl+Shift+T would duplicate it.
  if (startupMode === 'previous') return false;
  return !!recentlyClosed.pushWindow(sessionData());
}
function saveSessionNow() { writeJson('session.json', sessionData()); }
// Called on nearly every navigation/title event; the write is coalesced and runs off the main thread.
function saveSession() { writeJsonLater('session.json', sessionData, 800); }

function addHistory(title, url, favicon = '') {
  if (!/^https?:/i.test(url || '')) return;
  history.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: title || url, url, favicon: normalizeFavicon(favicon), visitedAt: Date.now() });
  if (history.length > 1000) history.splice(0, history.length - 1000);
  writeJsonLater('history.json', () => history, 2000);
}

function sortedBookmarks() {
  if (!bookmarksSortedCache) bookmarksSortedCache = bookmarks.slice(); // user-defined order (drag to reorder)
  return bookmarksSortedCache;
}
function persistBookmarks() { bookmarksSortedCache = null; writeJson('bookmarks.json', bookmarks); }
function persistSettings() { return writeJson(SETTINGS_FILE, { settingsVersion: SETTINGS_VERSION, adBlockEnabled, popupBlockEnabled, allowlistedSites, appearance, colorTheme, appearanceOptions, searchEngine, startupMode, startupPages, homepage, showHomeButton, newTabOpens, newTabShortcuts, newTabClock, windowStart, launchAtLogin, autoUpdate, usageReports, showBookmarksBar, downloadDirectory, askWhereToSave, toolbarPins, tabOptimizations }); }


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
  const view = new WebContentsView({ webPreferences: { preload: PAGE_PRELOAD_PATH, sandbox: true, contextIsolation: true, backgroundThrottling: true, spellcheck: false, enableWebSQL: false } });
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
  // Track trusted native input for popup decisions. This blocks script-driven
  // popunders while preserving click/keyboard-initiated target=_blank links.
  wc.on('before-input-event', (_event, input) => {
    if (['keyDown', 'rawKeyDown'].includes(input?.type)) trustedInputAt.set(wc.id, Date.now());
  });
  wc.once('destroyed', () => trustedInputAt.delete(wc.id));
  for (const eventName of ['dom-ready', 'did-finish-load', 'did-stop-loading']) wc.on(eventName, () => reclaimAddressFocus(tab));
  // A real click inside the page means the person chose to use it: stop pulling focus back to the address bar.
  wc.on('before-mouse-event', (_event, mouse) => { if (mouse?.type === 'mouseDown' && tab === addressFocusTab) addressFocusUntil = 0; });
  wc.setWindowOpenHandler((details) => {
    const decision = evaluatePopup(details, {
      now: Date.now(), lastGestureAt: trustedInputAt.get(wc.id) || 0, gestureWindowMs: 3000,
      adBlockEnabled, popupBlockEnabled,
      initiatorHost: hostnameOf(liveUrl(tab) || tab.url),
      isSiteAllowed: isSiteAllowed,
      blockedDomainFor
    });
    if (decision.block) {
      blockedPopupsCount += 1;
      blockedCount += 1;
      const host = decision.blockedHost || decision.host;
      if (host) blockedHostCounts[host] = (blockedHostCounts[host] || 0) + 1;
      pushBlockedSoon();
      return { action: 'deny' };
    }
    createTab(details.url);
    return { action: 'deny' };
  });
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
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = normalizeFavicon(favicons?.[0] || '');
    const currentUrl = liveUrl(tab) || tab.url;
    let bookmarksChanged = false;
    for (const bookmark of bookmarks) {
      if (bookmark.url === currentUrl && tab.favicon && bookmark.favicon !== tab.favicon) { bookmark.favicon = tab.favicon; bookmarksChanged = true; }
    }
    if (bookmarksChanged) persistBookmarks();
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].url === currentUrl) { if (tab.favicon) history[i].favicon = tab.favicon; writeJsonLater('history.json', () => history, 2000); break; }
    }
    push(); saveSession();
  });
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
    addHistory(tab.title, url, tab.favicon);
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

// ---------------------------------------------------------------- recently closed tabs and browser windows
function rememberClosedTab(tab, index) {
  const url = liveUrl(tab) || tab?.url || '';
  if (!url || isNewTabUrl(url) || url === 'about:blank') return; // Blank New Tabs are not useful restore targets.
  recentlyClosed.pushTab({ url, title: tab.title || url, favicon: tab.favicon || '' }, index);
}
function restoreRecentlyClosed(entryId) {
  const entry = recentlyClosed.pop(entryId);
  if (!entry) return null;
  if (entry.type === 'tab') {
    const closed = entry.tab;
    const tab = { id: nextId++, title: closed.title || 'New tab', url: closed.url, favicon: closed.favicon || '', loading: false, lastActive: Date.now(), view: null };
    cur.tabs.splice(Math.min(Math.max(entry.index, 0), cur.tabs.length), 0, tab);
    activateTab(tab);
    saveSession();
    return tab;
  }
  if (entry.type === 'window' && Array.isArray(entry.tabs) && entry.tabs.length) {
    // A just-launched, untouched New Tab is a placeholder; replace it rather
    // than leaving a confusing extra tab beside the recovered browser session.
    const replaceFreshTab = cur.tabs.length === 1 && isNewTabUrl(cur.tabs[0].url);
    if (replaceFreshTab) {
      destroyView(cur.tabs[0]);
      cur.tabs.length = 0;
      cur.active = null;
    }
    const restoredTabs = entry.tabs.map((closed) => ({
      id: nextId++, title: closed.title || 'New tab', url: isNewTabUrl(closed.url) ? newTabUrl() : closed.url,
      favicon: closed.favicon || '', loading: false, lastActive: Date.now(), view: null
    }));
    const baseIndex = cur.tabs.length;
    cur.tabs.push(...restoredTabs);
    const active = restoredTabs[Math.min(Math.max(entry.activeIndex, 0), restoredTabs.length - 1)] || restoredTabs[0];
    activateTab(active);
    saveSession();
    push();
    return { type: 'window', tabs: restoredTabs, active, baseIndex };
  }
  return null;
}
function reopenClosedTab() { return restoreRecentlyClosed(); }

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
  if (leaving && leaving !== tab) {
    // The tab just left was in active use until this switch. Reset its idle clock
    // here so long-lived foreground tabs do not become immediately eligible to sleep.
    leaving.lastActive = Date.now();
    if (leaving.view && !isInternalUrl(leaving.url)) captureThumb(leaving, 800);
  }
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
  if (tab.frozen) thawTab(tab);
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
// The hover card is ~280 CSS px wide, so a thumbnail needs roughly 2-3x that to stay sharp on
// HiDPI screens. Keep it generous and encode at high quality (text edges smear at low JPEG quality).
// 480px is ~1.7x the card's CSS width: sharp on 150% displays at a third of the bytes of the old 720px/q92 capture,
// and every tab keeps one of these in the main process.
const THUMB_WIDTH = 480;
const THUMB_JPEG_QUALITY = 80;
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
      const small = image.getSize().width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'best' }) : image;
      tab.thumb = `data:image/jpeg;base64,${small.toJPEG(THUMB_JPEG_QUALITY).toString('base64')}`;
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

ipcMain.handle('reviews:submit', async (event, payload) => {
  // Only the trusted browser-chrome renderer may submit product feedback.
  if (!ui || event.sender !== ui.webContents) return { ok: false, error: 'This review request is not allowed.' };
  const result = await reviewService.submit(payload);
  if (result?.ok) reviewPrompt.markSubmitted();
  return result;
});

ipcMain.handle('reviews:maybe-prompt', (event) => {
  if (!ui || event.sender !== ui.webContents) return { shouldPrompt: false, stopChecking: true };
  return reviewPrompt.maybePrompt();
});
ipcMain.handle('reviews:prompt-shown', (event) => {
  if (!ui || event.sender !== ui.webContents) return false;
  return reviewPrompt.markPromptShown();
});
ipcMain.handle('reviews:defer', (event, choice) => {
  if (!ui || event.sender !== ui.webContents) return false;
  return reviewPrompt.defer(choice);
});

ipcMain.handle('tabs:preview', async (_e, rawId, withThumb = true) => {
  const tab = findTabById(Number(rawId));
  if (!tab) return null;
  const live = !!tab.view && !tab.view.webContents.isDestroyed();
  const internal = isInternalUrl(tab.url);
  let thumb = tab.thumb || null;
  if (live && !internal && withThumb && !tab.frozen) thumb = await captureThumb(tab);
  const { memoryKB, sharedWith } = live && !internal ? tabMemory(tab) : { memoryKB: null, sharedWith: 0 };
  return {
    id: tab.id,
    state: internal ? 'internal' : !live ? 'sleeping' : tab.frozen ? 'frozen' : 'loaded',
    thumb,
    memoryKB,
    sharedWith,
    host: hostnameOf(liveUrl(tab) || tab.url) || ''
  };
});

function destroyView(tab) {
  tab.frozen = false;
  if (!tab.view) return;
  try { if (winAlive()) win.contentView.removeChildView(tab.view); } catch { /* already detached */ }
  try { const wc = tab.view.webContents; if (wcAlive(wc)) wc.close(); } catch { /* already gone */ }
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
  else bookmarks.push({ title: t.title && t.title !== 'Loading…' ? t.title : hostnameOf(t.url), url: t.url, favicon: normalizeFavicon(t.favicon), addedAt: Date.now() });
  persistBookmarks();
  push();
}

function updateBookmark(url, title, newUrl, folder, favicon) {
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
  if (cleanUrl !== b.url && typeof favicon !== 'string') b.favicon = '';
  b.url = cleanUrl;
  if (typeof favicon === 'string') { const cleanFavicon = normalizeFavicon(favicon); if (cleanFavicon) b.favicon = cleanFavicon; }
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

function isTabOptimizationExcluded(value) {
  const host = hostnameOf(value || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return tabOptimizations.excludedHosts.some((rule) => host === rule || host.endsWith(`.${rule}`));
}

// ---------------------------------------------------------------- tab freezing
// Tier one of memory relief. A frozen page keeps its DOM, form state and scroll position but runs no script, timers,
// animation frames or rendering, and Chromium purges its decoded-image and resource caches. Selecting it again
// thaws it instantly (no reload), which is what makes this cheaper for the user than discarding.
function lifecycleCommand(tab, state) {
  const wc = tab.view?.webContents;
  if (!wcAlive(wc)) return Promise.resolve(false);
  try {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg.sendCommand('Page.setWebLifecycleState', { state }).then(() => true, () => false);
  } catch { return Promise.resolve(false); } // DevTools or an extension already owns the protocol client
}
function freezeTab(tab) {
  if (tab.frozen || !tab.view) return;
  tab.frozen = true;
  lifecycleCommand(tab, 'frozen').then((ok) => {
    if (!ok) tab.frozen = false;
    else { try { tab.view?.webContents.debugger.detach(); } catch { /* already detached */ } }
  });
}
function thawTab(tab) {
  if (!tab.frozen) return;
  tab.frozen = false;
  lifecycleCommand(tab, 'active').finally(() => { try { tab.view?.webContents.debugger.detach(); } catch { /* already detached */ } });
}

// Free memory by discarding background tabs (see memory-manager.js for the policy). A
// discarded tab keeps its URL, title and favicon and gets a fresh WebContents when selected.
function discardIdleTabs() {
  if (quitting || !winAlive() || (!tabOptimizations.enabled && !tabOptimizations.freezeBackground)) return;
  const live = [];
  for (const s of spaces) {
    for (const t of s.tabs) {
      const wc = t.view?.webContents; // undefined once Electron has destroyed the view
      if (!wcAlive(wc)) continue;
      live.push({
        tab: t,
        wc,
        id: t.id,
        lastActive: t.lastActive,
        visible: s === cur && t === cur.active,
        audible: wc.isCurrentlyAudible(),
        busy: downloadOwners.has(wc.id) || (wc.isBeingCaptured?.() ?? false) || wc.isDevToolsOpened(),
        loading: !!t.loading,
        frozen: !!t.frozen,
        isNewTab: isNewTabUrl(liveUrl(t)),
        excluded: isTabOptimizationExcluded(liveUrl(t) || t.url)
      });
    }
  }
  if (!live.some((entry) => !entry.visible)) return; // nothing in the background, skip the measurements
  const pressure = measurePressure({ getSystemMemoryInfo: () => process.getSystemMemoryInfo(), getAppMetrics: () => app.getAppMetrics(), isWindows: IS_WINDOWS });
  for (const entry of live) entry.memoryKB = wcAlive(entry.wc) ? (pressure.byPid.get(entry.wc.getOSProcessId()) || 0) : 0;
  const policyPressure = tabOptimizations.pressureMode === 'off' ? 0 : pressure.level;
  const doomed = new Set(tabOptimizations.enabled ? planDiscards(live, { now: Date.now(), pressure: policyPressure, config: discardConfigFromSettings(tabOptimizations) }) : []);
  let changed = false;
  for (const entry of live) {
    if (!doomed.has(entry.id) || !wcAlive(entry.wc)) continue;
    entry.tab.url = liveUrl(entry.tab) || entry.tab.url;
    entry.tab.loading = false;
    destroyView(entry.tab);
    changed = true;
  }
  if (tabOptimizations.freezeBackground) {
    const freezeable = live.filter((entry) => !doomed.has(entry.id) && wcAlive(entry.wc));
    const toFreeze = new Set(planFreezes(freezeable, { now: Date.now(), afterMs: tabOptimizations.freezeAfterSeconds * 1000 }));
    for (const entry of freezeable) if (toFreeze.has(entry.id)) freezeTab(entry.tab);
  }
  if (changed) { push(); saveSession(); }
}

// Live memory figures for Settings > Tabs. privateBytes on Windows (what Task Manager calls "Memory"), working set elsewhere.
function memorySnapshot() {
  const out = { totalKB: 0, browserKB: 0, tabsKB: 0, tabs: 0, live: 0, frozen: 0, asleep: 0, processes: 0 };
  let metrics = [];
  try { metrics = app.getAppMetrics(); } catch { return out; }
  const byPid = new Map();
  for (const m of metrics) {
    const kb = Number(m.memory?.privateBytes ?? m.memory?.workingSetSize) || 0;
    byPid.set(m.pid, kb); out.totalKB += kb; out.processes += 1;
  }
  const tabPids = new Set();
  for (const s of spaces) {
    for (const t of s.tabs) {
      out.tabs += 1;
      const wc = t.view?.webContents;
      if (!wcAlive(wc)) { out.asleep += 1; continue; }
      if (t.frozen) out.frozen += 1; else out.live += 1;
      try { const pid = wc.getOSProcessId(); if (pid) tabPids.add(pid); } catch { /* process starting */ }
    }
  }
  for (const pid of tabPids) out.tabsKB += byPid.get(pid) || 0;
  out.browserKB = Math.max(0, out.totalKB - out.tabsKB);
  return out;
}
ipcMain.handle('memory:stats', (event) => (ui && event.sender === ui.webContents ? memorySnapshot() : null));

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

function focusAddress(soft = false) {
  ui?.webContents.focus();
  ui?.webContents.send('focus-address', { soft: !!soft });
}

// A fresh tab: empty the address bar and focus it so you can type right away.
// The New Tab page loads a moment later and Chromium may hand it keyboard focus when it finishes loading, which is why
// the cursor used to end up in the page's own search box. For a short window after a new tab opens, the address bar
// takes focus back whenever that page finishes loading (and only until the person clicks into the page themselves).
let addressFocusTab = null;
let addressFocusUntil = 0;
function focusNewTab(tab) {
  // Always put the cursor in the address bar at the top (never in the New Tab page's own search box).
  if (tab && isNewTabUrl(tab.url)) ui?.webContents.send('reset-address'); // empty it, then focus below
  if (tab) { addressFocusTab = tab; addressFocusUntil = Date.now() + 4000; }
  focusAddress();
  // Staggered re-assert for the page that is still starting up.
  for (const delay of [80, 250, 600]) {
    const timer = setTimeout(() => {
      if (!winAlive() || paletteOpen || quitting) return;
      if (addressFocusTab && cur.active === addressFocusTab && isNewTabUrl(addressFocusTab.url) && Date.now() < addressFocusUntil) focusAddress(true);
    }, delay);
    timer.unref?.();
  }
}
// Called by a tab's page events: if this is the new tab that was just opened and the page is taking focus, give it back.
function reclaimAddressFocus(tab) {
  if (!tab || tab !== addressFocusTab || Date.now() >= addressFocusUntil) return;
  if (paletteOpen || quitting || !winAlive() || cur.active !== tab || !isNewTabUrl(tab.url)) return;
  focusAddress(true);
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
    case 'reopen-entry': restoreRecentlyClosed(arg); break;
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
    closedTabs: recentlyClosed.list(8),
    downloads: downloads.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, 6)
      .map((d) => ({ id: d.id, filename: d.filename, state: d.state, received: d.receivedBytes, total: d.totalBytes })),
    extensions: extensions.list().map((e) => ({ id: e.id, name: e.name, version: e.version }))
  };
});
ipcMain.on('cmd', (_e, name, arg) => command(name, arg));

// Settings > About > "Check for updates". The sender is always the browser chrome (checked below).
const fromChrome = (event) => !!ui && event.sender === ui.webContents;
// ---- Taskbar identity (Windows) -------------------------------------------------------------------------------
// Every profile is its own taskbar app. Its button shows the Drift icon with a badge in the profile's colour and initial
// (drawn by the browser chrome, which has fonts and a canvas, and packed into <AppData>\Drift\Icons\<id>.ico here so a
// pinned button looks the same as the running one). The same name feeds the relaunch entry of the jump list.
// If the chrome cannot draw the icon, a small overlay badge is used instead.
const BASE_ICON_ICO = path.join(ROOT_DIR, 'build', 'icon.ico');
const BASE_ICON_PNG = path.join(ROOT_DIR, 'build', 'icon.png');
let taskbarBadge = { image: null, label: '' };            // fallback overlay
let taskbarIcon = { file: '', image: null };              // generated per-profile icon
const cachedProfileIconFile = () => { try { const f = profiles.iconFile(ACTIVE_PROFILE_ID); return fs.existsSync(f) ? f : ''; } catch { return ''; } };
function applyTaskbarBadge() {
  if (process.platform !== 'win32' || !winAlive() || typeof win.setOverlayIcon !== 'function') return;
  try { win.setOverlayIcon(taskbarBadge.image, taskbarBadge.label); } catch (error) { startupLog(`taskbar badge unavailable: ${error?.message || error}`); }
}
function applyTaskbarIdentity() {
  if (!IS_WINDOWS || !winAlive()) return;
  const iconFile = taskbarIcon.file || BASE_ICON_ICO;
  try {
    win.setAppDetails?.({
      appId: PROFILE_APP_ID,
      appIconPath: iconFile,
      appIconIndex: 0,
      // Pinning this window's taskbar button relaunches this same profile.
      relaunchCommand: [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), `--profile=${ACTIVE_PROFILE_ID}`].map((a) => `"${a}"`).join(' '),
      relaunchDisplayName: ACTIVE_PROFILE_ID === 'default' ? 'Drift' : `Drift - ${profileInfo.name}`
    });
  } catch (error) { startupLog(`taskbar app details unavailable: ${error?.message || error}`); }
  try { if (typeof win.setIcon === 'function') win.setIcon(taskbarIcon.image || nativeImage.createFromPath(BASE_ICON_PNG)); } catch (error) { startupLog(`window icon unavailable: ${error?.message || error}`); }
  applyTaskbarBadge(); // after setAppDetails, which would otherwise reset it
}
ipcMain.on('profile:badge', (event, dataUrl, label) => {
  if (!fromChrome(event)) return;
  const text = typeof dataUrl === 'string' ? dataUrl : '';
  if (!text) taskbarBadge = { image: null, label: '' };
  else if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(text) && text.length < 150000) {
    const image = nativeImage.createFromDataURL(text);
    if (image.isEmpty()) return;
    taskbarBadge = { image, label: String(label || 'Profile').slice(0, 80) };
  } else return;
  applyTaskbarBadge();
});
// The chrome sends the badged icon at several sizes (or an empty list when this profile should show the plain Drift icon).
ipcMain.on('profile:icon', (event, images, label) => {
  if (!fromChrome(event) || process.platform !== 'win32') return;
  try {
    const target = profiles.iconFile(ACTIVE_PROFILE_ID);
    if (!Array.isArray(images) || images.length === 0) {
      taskbarIcon = { file: '', image: null };
      try { fs.rmSync(target, { force: true }); } catch { /* the file is only a cache */ }
    } else {
      const parsed = parseIconImages(images);
      if (!parsed) return;
      writeIcoFile(target, parsed);
      const largest = parsed[parsed.length - 1];
      const image = nativeImage.createFromBuffer(largest.png);
      taskbarIcon = { file: target, image: image.isEmpty() ? null : image };
    }
    taskbarBadge = { image: null, label: '' }; // the icon itself carries the badge now
    applyTaskbarIdentity();
  } catch (error) { startupLog(`profile icon not applied: ${error?.message || error}`); }
});
ipcMain.handle('profile:icon-base', (event) => {
  if (!fromChrome(event)) return '';
  try { const image = nativeImage.createFromPath(BASE_ICON_PNG); return image.isEmpty() ? '' : image.resize({ width: 256, height: 256, quality: 'best' }).toDataURL(); } catch { return ''; }
});
ipcMain.handle('updates:check', async (event) => {
  if (!fromChrome(event)) return updater.getStatus();
  await updater.checkNow();
  return updater.getStatus();
});
ipcMain.handle('updates:install', async (event) => {
  if (!fromChrome(event)) return { ok: false, message: 'This update action is only available from Drift settings.' };
  // Setup is launched directly from the SHA-256-verified staged package. It
  // acknowledges its own Electron startup before Drift quits, then waits for
  // this process to exit normally before swapping the installation directory.
  const started = await updater.installNow();
  if (started) {
    // Quit normally first (flushes settings/session), but never let a slow shutdown keep the old process alive:
    // the update helper is waiting for this PID to disappear, so end it for certain after a short grace period.
    setTimeout(() => app.quit(), 300);
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 5000);
    return { ok: true };
  }
  return { ok: false, message: updater.getStatus().message || 'Drift Setup could not be started. The downloaded update is still available to retry.' };
});

// ---------------------------------------------------------------- profiles
// Opening a profile starts another Drift process for it (one process per profile, so Chromium keeps each profile's
// cookies and storage apart). If that profile is already open, Electron's single-instance lock hands the launch to the
// running window, which simply comes to the front.
function launchProfile(id) {
  return new Promise((resolve) => {
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), ...profiles.launchArgs(id)];
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^DRIFT_UPDATE_/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
    let child;
    try { child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env }); }
    catch (error) { resolve({ ok: false, error: `Drift could not open the profile: ${error?.message || error}` }); return; }
    child.once('error', (error) => resolve({ ok: false, error: `Drift could not open the profile: ${error?.message || error}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}
const profileFailure = (error) => ({
  ok: false,
  code: error?.code || 'error',
  error: error instanceof ProfileError ? error.message : 'Drift could not change your profiles. Please try again.'
});
const profileList = () => ({ activeId: ACTIVE_PROFILE_ID, profiles: profiles.list(ACTIVE_PROFILE_ID), max: profiles.MAX_PROFILES, colors: profiles.PROFILE_COLORS });
ipcMain.handle('profiles:list', (event) => {
  if (!fromChrome(event)) return { activeId: ACTIVE_PROFILE_ID, profiles: [], max: profiles.MAX_PROFILES, colors: profiles.PROFILE_COLORS };
  refreshProfileInfo();
  return profileList();
});
ipcMain.handle('profiles:create', async (event, input) => {
  if (!fromChrome(event)) return { ok: false, error: 'This action is only available from Drift.' };
  try {
    const profile = profiles.create({ name: input?.name, color: input?.color });
    refreshProfileInfo(); push();
    const result = { ok: true, profile, ...profileList() };
    if (input?.open === true) { const launched = await launchProfile(profile.id); if (!launched.ok) result.warning = launched.error; }
    return result;
  } catch (error) { return profileFailure(error); }
});
ipcMain.handle('profiles:update', (event, id, input) => {
  if (!fromChrome(event)) return { ok: false, error: 'This action is only available from Drift.' };
  try {
    const patch = {};
    if (typeof input?.name === 'string') patch.name = input.name;
    if (typeof input?.color === 'string') patch.color = input.color;
    const profile = profiles.update(String(id || ''), patch, { activeId: ACTIVE_PROFILE_ID });
    refreshProfileInfo(); push();
    return { ok: true, profile, ...profileList() };
  } catch (error) { return profileFailure(error); }
});
ipcMain.handle('profiles:remove', (event, id) => {
  if (!fromChrome(event)) return { ok: false, error: 'This action is only available from Drift.' };
  try {
    profiles.remove(String(id || ''), { activeId: ACTIVE_PROFILE_ID });
    refreshProfileInfo(); push();
    return { ok: true, ...profileList() };
  } catch (error) { return profileFailure(error); }
});
ipcMain.handle('profiles:open', async (event, id) => {
  if (!fromChrome(event)) return { ok: false, error: 'This action is only available from Drift.' };
  const wanted = String(id || '');
  if (!profiles.get(wanted)) return { ok: false, error: 'That profile no longer exists.' };
  if (wanted === ACTIVE_PROFILE_ID) { try { if (winAlive()) { if (win.isMinimized()) win.restore(); win.focus(); } } catch { /* window is closing */ } return { ok: true }; }
  return launchProfile(wanted);
});

ipcMain.on('bookmark:update', (_e, url, title, newUrl, folder, favicon) => updateBookmark(String(url || ''), title, newUrl, folder, favicon));
ipcMain.on('bookmark:reorder', (_e, rawUrl, rawTarget, after) => {
  const next = reorderBookmarkList(bookmarks, String(rawUrl || ''), String(rawTarget || ''), after === true);
  if (!next) return;
  bookmarks = next; persistBookmarks(); push();
});
ipcMain.on('bookmark:move', (_e, rawUrl, direction) => {
  const next = moveBookmarkBy(bookmarks, String(rawUrl || ''), Number(direction));
  if (!next) return;
  bookmarks = next; persistBookmarks(); push();
});
ipcMain.on('bookmark:remove', (_e, url) => removeBookmark(String(url || '')));
ipcMain.on('bookmark:add', (_e, title, rawUrl, folder, favicon) => {
  const url = normalizeBookmarkUrl(rawUrl);
  if (!url) return;
  if (bookmarks.some((b) => b.url === url)) return;
  const cleanFolder = String(folder || '').trim().slice(0, 80);
  bookmarks.push({ title: String(title || url).trim().slice(0, 240) || url, url, favicon: normalizeFavicon(favicon), ...(cleanFolder ? { folder: cleanFolder } : {}), addedAt: Date.now() });
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
ipcMain.on('popup-block:toggle', (_e, enabled) => {
  popupBlockEnabled = !!enabled;
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
ipcMain.on('adblock:reset-count', () => { blockedCount = 0; blockedPopupsCount = 0; blockedHostCounts = Object.create(null); push(); });

ipcMain.on('settings:update', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  let refreshNewTabs = false;
  if (APPEARANCES.includes(patch.appearance) && patch.appearance !== appearance) { appearance = patch.appearance; refreshNewTabs = true; applyAppearance(); }
  if (COLOR_THEME_IDS.includes(patch.colorTheme) && patch.colorTheme !== colorTheme) { colorTheme = patch.colorTheme; refreshNewTabs = true; }
  if (patch.appearanceOptions && typeof patch.appearanceOptions === 'object' && !Array.isArray(patch.appearanceOptions)) {
    const nextAppearanceOptions = normalizeAppearanceOptions({ ...appearanceOptions, ...patch.appearanceOptions });
    if (JSON.stringify(nextAppearanceOptions) !== JSON.stringify(appearanceOptions)) {
      appearanceOptions = nextAppearanceOptions;
      refreshNewTabs = true;
    }
  }
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
  if (typeof patch.popupBlockEnabled === 'boolean') popupBlockEnabled = patch.popupBlockEnabled;
  if (Array.isArray(patch.toolbarPins)) toolbarPins = cleanToolbarPins(patch.toolbarPins);
  if (patch.tabOptimizations && typeof patch.tabOptimizations === 'object' && !Array.isArray(patch.tabOptimizations)) tabOptimizations = normalizeTabOptimizationSettings({ ...tabOptimizations, ...patch.tabOptimizations });
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
      item('Restore last closed tab or window', 'CmdOrCtrl+Shift+T', 'reopen-tab'),
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

// ---------------------------------------------------------------- startup diagnostics + splash
// Every launch writes a few timed lines to <profile>\startup.log, so "Drift is in Task Manager but never opens" can be
// diagnosed from the last line instead of guessed at.
const STARTUP_T0 = Date.now();
let startupShown = false;
function startupLog(message) {
  try {
    const target = path.join(APP_DATA_DIRECTORY, 'startup.log');
    fs.mkdirSync(APP_DATA_DIRECTORY, { recursive: true });
    try { if (fs.statSync(target).size > 100 * 1024) fs.renameSync(target, `${target}.1`); } catch { /* no log yet */ }
    fs.appendFileSync(target, `[${new Date().toISOString()}] +${Date.now() - STARTUP_T0}ms pid ${process.pid} [${ACTIVE_PROFILE_ID}] v${app.getVersion()} ${message}\n`);
  } catch { /* logging must never stop the browser */ }
}

// The silent installer waits for this acknowledgement before deleting the previous
// installation. It is written only after the browser chrome is loaded and the main
// window is visible, so Setup can distinguish a usable launch from a process that
// merely started and then failed during startup.
function acknowledgeUpdateHealthcheck() {
  const file = process.env.DRIFT_UPDATE_HEALTHCHECK_FILE;
  const token = process.env.DRIFT_UPDATE_HEALTHCHECK_TOKEN;
  const expectedVersion = process.env.DRIFT_UPDATE_EXPECTED_VERSION;
  if (!file && !token && !expectedVersion) return false;
  if (!winAlive() || !win.isVisible() || !ui || ui.webContents.isDestroyed()) {
    startupLog('UPDATE HEALTH-CHECK DEFERRED: browser window is not yet visible and usable');
    return false;
  }
  const ok = writeUpdateHealthcheck({
    file,
    token,
    expectedVersion,
    actualVersion: app.getVersion(),
    allowedDirectory: path.join(APP_DATA_DIRECTORY, 'Updates'),
    pid: process.pid
  });
  if (ok) {
    startupLog(`update launch health-check confirmed version ${app.getVersion()}`);
    delete process.env.DRIFT_UPDATE_HEALTHCHECK_FILE;
    delete process.env.DRIFT_UPDATE_HEALTHCHECK_TOKEN;
    delete process.env.DRIFT_UPDATE_EXPECTED_VERSION;
    return true;
  }
  startupLog(`UPDATE HEALTH-CHECK FAILED: expected ${expectedVersion || '(missing)'}, running ${app.getVersion()}, marker ${file || '(missing)'}`);
  return false;
}
const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    startupLog(`${label} still running after ${ms}ms; not waiting for it`);
    resolve({ completed: false, value: undefined });
  }, ms);
  timer.unref?.();
  Promise.resolve(promise).then((value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ completed: true, value });
  }, (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
});

// Small window shown only when this launch has to wait for an installer that is still replacing the files. Without
// it that wait was an invisible process.
let splash = null;
function showSplash(text) {
  if (splash) return;
  try {
    const dark = nativeTheme.shouldUseDarkColors;
    const bg = dark ? WINDOW_BG.dark : WINDOW_BG.light;
    const fg = dark ? '#e4efec' : '#0e2a31';
    const muted = dark ? '#94adab' : '#4d6a6e';
    const accent = dark ? '#f2c230' : '#8f6200';
    const safe = String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:${bg};color:${fg};font:13px/1.4 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-app-region:drag;user-select:none;overflow:hidden}
      main{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 26px;box-sizing:border-box}
      b{font:700 17px/1.1 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em}
      p{margin:6px 0 16px;color:${muted}}
      i{display:block;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,${accent},transparent) 0 0/35% 100% no-repeat,${dark ? '#22414b' : '#d3dfde'};animation:r 1.3s ease-in-out infinite}
      @keyframes r{from{background-position:-40% 0,0 0}to{background-position:140% 0,0 0}}
      @media (prefers-reduced-motion:reduce){i{animation:none}}
    </style><main><b>Drift</b><p>${safe}</p><i></i></main>`;
    splash = new BrowserWindow({ width: 360, height: 128, frame: false, resizable: false, maximizable: false, minimizable: false, alwaysOnTop: true, show: false, backgroundColor: bg, webPreferences: { sandbox: true, contextIsolation: true } });
    splash.once('ready-to-show', () => { if (splash && !splash.isDestroyed()) splash.show(); });
    splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } catch (error) { splash = null; startupLog(`splash failed: ${error && error.message}`); }
}
function closeSplash() {
  const s = splash; splash = null;
  try { if (s && !s.isDestroyed()) s.destroy(); } catch { /* already gone */ }
}

// Starts a fresh copy of Drift and ends this process. The single-instance lock is released first: with the plain
// app.relaunch() the new copy could start while this one still owned the lock, find it taken, and quit silently.
function restartDrift(reason) {
  startupLog(`restarting: ${reason}`);
  closeSplash();
  try { app.releaseSingleInstanceLock(); } catch { /* not held */ }
  app.relaunch();
  app.exit(0);
}

// Links and files handed to Drift by Windows ("Open with", default-browser clicks, shortcuts) or a second launch.
const OPENABLE_FILE = /\.(?:html?|xhtml|svg|pdf|txt|json|xml|png|jpe?g|gif|webp)$/i;
function urlsFromArgv(argv = []) {
  const out = [];
  for (const raw of argv.slice(1)) {
    const arg = String(raw || '').trim();
    if (!arg || arg.startsWith('-')) continue;
    if (/^https?:\/\//i.test(arg)) { try { out.push(new URL(arg).href); } catch { /* not a URL */ } continue; }
    if (/^file:\/\//i.test(arg)) { out.push(arg); continue; }
    try { if (OPENABLE_FILE.test(arg) && path.isAbsolute(arg) && fs.statSync(arg).isFile()) out.push(pathToFileURL(arg).href); } catch { /* not a file */ }
  }
  return out.slice(0, 20);
}
function openLaunchUrls(urls) {
  if (!urls.length || !winAlive()) return;
  // A just-launched, untouched New Tab is a placeholder: the first link takes its place.
  const placeholder = cur.tabs.length === 1 && isNewTabUrl(cur.tabs[0].url) ? cur.tabs[0] : null;
  urls.forEach((url, index) => {
    if (index === 0 && placeholder) { activateTab(placeholder); go(url); }
    else createTab(url);
  });
}

let discardTimer = null;
function shouldAnimateWindowOpacity() {
  return IS_WINDOWS && appearanceOptions?.motion !== 'reduced' && appearanceOptions?.motion !== 'off' && winAlive() && typeof win.setOpacity === 'function';
}
function fadeWindowOpacity(from, to, duration, done) {
  const started = Date.now();
  let timer = null;
  const tick = () => {
    if (!winAlive()) { done?.(); return; }
    const progress = Math.min(1, Math.max(0, (Date.now() - started) / duration));
    const eased = 1 - Math.pow(1 - progress, 3);
    try { win.setOpacity(from + ((to - from) * eased)); } catch { done?.(); return; }
    if (progress < 1) timer = setTimeout(tick, 16);
    else { try { win.setOpacity(to); } catch {} done?.(); }
  };
  tick();
  return { cancel: () => { if (timer) clearTimeout(timer); } };
}
function revealBrowserWindow() {
  if (!winAlive() || startupShown) return;
  startupShown = true;
  if (!shouldAnimateWindowOpacity()) { win.show(); return; }
  try { win.setOpacity(0); } catch { win.show(); return; }
  win.show();
  fadeWindowOpacity(0, 1, 190);
}
async function start() {
  startupLog('start');
  // Safety net: whatever goes wrong below, a window that exists is shown after a few seconds instead of staying hidden.
  const shownWatchdog = setTimeout(() => {
    if (startupShown) return;
    startupLog('window still hidden after 8s; forcing it visible');
    try { revealBrowserWindow(); } catch { /* nothing more to do */ }
  }, 8000);
  shownWatchdog.unref?.();
  ensureUserDataDirectories();
  powerMonitor.on('suspend', () => reviewPrompt.pause());
  powerMonitor.on('resume', () => reviewPrompt.resume());
  // A downloaded update that was not installed when Drift last closed is applied now, before any window opens.
  // The installer starts Drift again by itself, so 'exit' simply ends this process.
  const settingsOnDisk = readJson(SETTINGS_FILE, {});
  autoUpdate = settingsOnDisk.autoUpdate !== false;
  usageReports = settingsOnDisk.usageReports !== false;
  const updateGate = await updater.prepareStartup({ onWait: () => showSplash('Finishing the update\u2026') });
  startupLog(`update gate: ${updateGate}`);
  if (updateGate === 'exit') { closeSplash(); app.exit(0); return; }
  if (updateGate === 'restart') { restartDrift('an update was installed while this launch waited'); return; }
  const savedBookmarks = readJson('bookmarks.json', []);
  bookmarks = Array.isArray(savedBookmarks) ? savedBookmarks.filter((b) => b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url)).map((b) => ({
    title: typeof b.title === 'string' && b.title.trim() ? b.title : b.url,
    url: b.url,
    ...(typeof b.folder === 'string' && b.folder.trim() ? { folder: b.folder.trim().slice(0, 80) } : {}),
    favicon: normalizeFavicon(b.favicon),
    ...(Number.isFinite(b.addedAt) ? { addedAt: b.addedAt } : {})
  })) : [];
  const savedHistory = readJson('history.json', []);
  history = Array.isArray(savedHistory) ? savedHistory.filter((h) => h && typeof h.url === 'string' && /^https?:\/\//i.test(h.url)).slice(-1000).map((entry) => ({
    ...entry,
    id: typeof entry.id === 'string' && entry.id ? entry.id : `${Number(entry.visitedAt) || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof entry.title === 'string' && entry.title ? entry.title : entry.url,
    favicon: normalizeFavicon(entry.favicon),
    visitedAt: Number.isFinite(entry.visitedAt) ? entry.visitedAt : 0
  })) : [];
  const settings = readJson(SETTINGS_FILE, {});
  adBlockEnabled = settings.adBlockEnabled !== false;
  popupBlockEnabled = settings.popupBlockEnabled !== false;
  appearance = APPEARANCES.includes(settings.appearance) ? settings.appearance : 'system';
  colorTheme = COLOR_THEME_IDS.includes(settings.colorTheme) ? settings.colorTheme : 'tide';
  appearanceOptions = normalizeAppearanceOptions(settings.appearanceOptions);
  // 1.4 Tideline: profiles still on the 1.3 out-of-the-box look (violet, system font, aurora New Tab) move to the
  // new defaults once. Anything the person deliberately chose is left alone, and every old option is still offered.
  const migrateLook = Number(settings.settingsVersion || 0) < SETTINGS_VERSION;
  if (migrateLook) {
    if (colorTheme === 'violet' && !appearanceOptions.accentColor) colorTheme = 'tide';
    if (appearanceOptions.fontFamily === 'system') appearanceOptions = { ...appearanceOptions, fontFamily: 'drift' };
    if (appearanceOptions.newTabBackground === 'aurora') appearanceOptions = { ...appearanceOptions, newTabBackground: 'tide' };
  }
  searchEngine = SEARCH_ENGINES.includes(settings.searchEngine) ? settings.searchEngine : 'duckduckgo';
  // Older builds only had a "Restore previous session" switch.
  // Fresh installs (no saved choice) open a fresh New Tab page. Only an old build that explicitly
  // had "restore previous session" switched on keeps that behaviour.
  startupMode = STARTUP_MODES.includes(settings.startupMode) ? settings.startupMode : (settings.restoreSession === true ? 'previous' : 'newtab');
  // If Drift was terminated before its shutdown handler ran (power loss, Task Manager,
  // forced installer close), offer the last durable session through Ctrl+Shift+T. When
  // startupMode is 'previous', those same tabs are restored automatically instead.
  const previousRun = readJson('run-state.json', { running: false });
  if (previousRun?.running === true && startupMode !== 'previous') {
    const interrupted = readJson('session.json', null);
    if (interrupted && Array.isArray(interrupted.tabs)) {
      const recoveredId = recentlyClosed.pushWindow(interrupted);
      if (recoveredId) startupLog('saved an interrupted browser session for Ctrl+Shift+T recovery');
    }
  }
  closedWindowRecorded = false;
  writeJson('run-state.json', { running: true, pid: process.pid, startedAt: Date.now(), version: app.getVersion() });
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
  tabOptimizations = normalizeTabOptimizationSettings(settings.tabOptimizations);
  toolbarPins = cleanToolbarPins(settings.toolbarPins);
  downloadDirectory = typeof settings.downloadDirectory === 'string' && settings.downloadDirectory ? settings.downloadDirectory : app.getPath('downloads');
  try { fs.mkdirSync(downloadDirectory, { recursive: true }); } catch { downloadDirectory = app.getPath('downloads'); }
  downloads = readJson('downloads.json', []);
  if (!Array.isArray(downloads)) downloads = [];
  downloads = downloads.map((entry) => entry && entry.state === 'progressing' ? { ...entry, state: 'interrupted' } : entry).filter(Boolean);
  allowlistedSites = Array.isArray(settings.allowlistedSites)
    ? [...new Set(settings.allowlistedSites.filter((x) => typeof x === 'string' && /^[a-z0-9.-]+$/i.test(x)).map((x) => x.toLowerCase()))].slice(-300)
    : [];
  if (!fs.existsSync(file(SETTINGS_FILE)) || migrateLook) persistSettings(); // first run / upgrade: store the settings right away
  setupSession();
  // Extensions load in parallel with the window and browser chrome; the first page waits for them below.
  const extensionsReady = extensions.restore().catch((error) => console.warn('Drift could not restore extensions:', error?.message || error));
  buildMenu();

  const windowBounds = initialWindowBounds();
  win = new BaseWindow({
    ...windowBounds, minWidth: 420, minHeight: 320, title: 'Drift', show: false,
    frame: !IS_WINDOWS, resizable: true, maximizable: true, minimizable: true, closable: true,
    icon: IS_WINDOWS && cachedProfileIconFile() ? cachedProfileIconFile() : BASE_ICON_PNG,
    backgroundColor: windowBg()
  });
  // Keep the live window's taskbar identity identical to the AUMID embedded in
  // Drift.lnk by Setup. This lets Windows group the running browser with its pin.
  if (IS_WINDOWS) {
    try { app.setAppUserModelId(PROFILE_APP_ID); } catch { /* older Windows shell */ }
    const cached = cachedProfileIconFile();
    if (cached) { try { const image = nativeImage.createFromPath(cached); if (!image.isEmpty()) taskbarIcon = { file: cached, image }; } catch { /* the chrome redraws it right away */ } }
    applyTaskbarIdentity();
    try { win.on('show', applyTaskbarBadge); } catch { /* optional */ }
  }
  // Drift runs one process per open profile, all sharing profiles.json. Look for changes made from another window (a
  // rename, a new colour, a profile added or removed) so this window's title, badge and taskbar icon stay accurate, and
  // finish renaming folders whose profile was open when it was renamed.
  const profileWatch = setInterval(() => { if (!quitting) refreshProfileInfo(); }, 2500);
  const folderWatch = setInterval(() => { if (!quitting) profiles.reconcile({ selfId: ACTIVE_PROFILE_ID }); }, 15000);
  profileWatch.unref?.(); folderWatch.unref?.();
  win.setMenuBarVisibility(false);
  if (windowBounds.startMaximized) win.maximize();
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg()); });

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
  const chromeLoad = await withTimeout(ui.webContents.loadFile(path.join(RENDERER_DIR, 'browser', 'index.html')), 20000, 'browser chrome load');
  if (!chromeLoad.completed || !ui || ui.webContents.isDestroyed()) throw new Error('Drift browser chrome did not finish loading; the update cannot be confirmed.');
  startupLog('browser chrome loaded');

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
  let closeFadeTimer = null;
  let allowCloseAfterFade = false;
  win.on('close', (event) => {
    saveWindowState();
    saveSessionNow();
    recordClosedBrowserWindow();
    if (allowCloseAfterFade) { allowCloseAfterFade = false; return; }
    if (quitting || !shouldAnimateWindowOpacity()) return;
    event.preventDefault();
    if (closeFadeTimer) return;
    closeFadeTimer = fadeWindowOpacity(1, 0, 150, () => {
      closeFadeTimer = null;
      allowCloseAfterFade = true;
      if (winAlive()) win.close();
    });
  });
  win.on('closed', () => {
    quitting = true; // the window is gone: nothing below may touch it again
    clearInterval(discardTimer);
    saveSessionNow();
    clearTimeout(sessionTimer);
    clearTimeout(pushTimer);
    pushTimer = null;
    for (const t of cur.tabs) { try { const wc = t.view?.webContents; if (wcAlive(wc)) wc.close(); } catch { /* already gone */ } }
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

  // Content scripts must be registered before a website loads, but a slow or stuck extension (or Chrome Web Store setup)
  // must never keep the window hidden. The browser frame appears straight away; only a first tab that is a real
  // website waits (a few seconds at most) for extensions. The New Tab page and Drift's own pages never wait.
  const launchUrls = urlsFromArgv(process.argv);
  layout();
  const initialTab = cur.active || cur.tabs[0];
  const needsExtensions = !!launchUrls.length || (initialTab && !isNewTabUrl(initialTab.url) && !isInternalUrl(initialTab.url));
  if (!needsExtensions) {
    activateTab(initialTab);
    if (isNewTabUrl(initialTab.url)) focusNewTab(initialTab);
  }
  revealBrowserWindow();
  closeSplash();
  startupLog('window shown');
  // This is the installer's commit point: only the expected version, after its
  // browser chrome has loaded and the window is visible, can authorize cleanup
  // of the old installation. Setup rolls back any build that cannot confirm it.
  acknowledgeUpdateHealthcheck();
  if (needsExtensions) {
    push();
    await withTimeout(extensionsReady, 3500, 'extensions');
    if (winAlive()) {
      if (initialTab && cur.tabs.includes(initialTab)) activateTab(initialTab);
      openLaunchUrls(launchUrls);
    }
  }
  startupLog('extensions step done');
  // Focus requested before the window was visible can be dropped, so ask again once it is shown.
  if (cur.active && isNewTabUrl(cur.active.url)) setTimeout(() => { if (win && !win.isDestroyed() && !paletteOpen) focusNewTab(cur.active); }, 200);
  discardTimer = setInterval(discardIdleTabs, 10 * 1000);
  discardTimer.unref?.();
  updater.onStatus(() => push());
  updater.start(); // background check shortly after startup; installs when Drift closes
  reviewPrompt.start(); // counts local app use for the automatic review prompt (30-minute threshold)
  telemetry.start(); // "open" a few seconds after launch, then a heartbeat every minute
}

// Electron shows a blocking "A JavaScript error occurred in the main process" dialog for any uncaught exception.
// While Drift is closing (for example to install an update) objects are destroyed under running timers; that is
// expected and harmless, so it is only logged. Anything else still gets the dialog.
process.on('uncaughtException', (error) => {
  const message = String(error && error.message || error);
  if (quitting || /Object has been destroyed/i.test(message)) { console.warn('Ignored during shutdown:', message); return; }
  console.error(error);
  try { dialog.showErrorBox('Drift ran into a problem', error && error.stack ? error.stack : message); } catch { /* nothing more to do */ }
});

// Lower baseline memory: switch off Chromium background services a browser this size does not use (translation
// prompts, Cast discovery, optimization-hint downloads, autofill server calls). Must run before the app is ready.
// Lower baseline memory further:
//  - SpareRendererForSitePerProcess: Chromium keeps an empty, pre-warmed renderer (~25-40 MB) waiting for the next tab.
//  - BackForwardCache: keeps whole previous pages alive in memory per tab; Back reloads from the HTTP cache instead.
//  - Prerender2: speculation rules may render entire pages in the background before you click.
//  - process-per-site: tabs on the same site share one renderer instead of one renderer each.
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,SpareRendererForSitePerProcess,BackForwardCache,Prerender2,InterestFeedContentSuggestions');
app.commandLine.appendSwitch('process-per-site');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    startupLog('pinned shortcut / second launch routed to the existing Drift window');
    const urls = urlsFromArgv(argv);
    if (winAlive() && startupShown && urls.length) { try { for (const url of urls) createTab(url); } catch { /* window closing */ } }
    if (winAlive() && startupShown) {
      try { if (win.isMinimized()) win.restore(); } catch { /* ignore stale minimize state */ }
      try { if (!win.isVisible()) win.show(); } catch { /* ignore stale visibility state */ }
      try { win.focus(); } catch { /* a window can be closing */ }
      try { app.focus({ steal: true }); } catch { /* optional on some platforms */ }
    }
  });
  app.whenReady().then(start).catch((error) => {
    console.error('Drift failed to start:', error);
    startupLog(`FAILED: ${error && error.stack ? error.stack : error}`);
    closeSplash();
    // A silent quit here looked exactly like "Drift won't open". Say what happened and where the log is.
    try { dialog.showErrorBox('Drift could not start', `${error && error.message ? error.message : error}\n\nDetails: ${path.join(APP_DATA_DIRECTORY, 'startup.log')}`); } catch { /* nothing more to do */ }
    app.quit();
  });
  let closeReported = false;
  app.on('before-quit', (event) => {
    quitting = true;
    persistSettings(); // final flush so no preference change can be lost
    reviewPrompt.stop(); // persist exact accumulated review-prompt usage before the process exits
    if (winAlive()) saveSessionNow();
    recordClosedBrowserWindow();
    writeJson('run-state.json', { running: false, pid: process.pid, endedAt: Date.now(), version: app.getVersion() });
    storage.flushAll(); // history, downloads and anything else still waiting on a debounce timer
    // Tell the monitor this session ended, then quit for real. The report is capped at a couple of seconds
    // (reportCloseTimeoutMs) so closing Drift never feels slow, and it runs only once.
    if (!closeReported && telemetry.hasOpenSession() && usageReports) {
      closeReported = true;
      event.preventDefault();
      telemetry.stop().catch(() => {}).finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => { if (startupShown) app.quit(); }); // closing the update splash must not end the launch
}
