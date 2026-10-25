const { app, BaseWindow, WebContentsView, Menu, ipcMain, session, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------- config
const SIDEBAR_W = 248;
const TOP_H = 52;
const IDLE_DISCARD_MS = 5 * 60 * 1000;
const NEWTAB = pathToFileURL(path.join(__dirname, 'ui', 'newtab.html')).href;

const BLOCKED = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'adservice.google.com', 'connect.facebook.net', 'taboola.com',
  'outbrain.com', 'scorecardresearch.com', 'hotjar.com', 'criteo.com', 'adnxs.com',
  'amazon-adsystem.com', 'ads.twitter.com', 'analytics.tiktok.com', 'mixpanel.com'
];

const READER_JS = String.raw`(() => {
  const src = document.querySelector('article') || document.querySelector('main') || document.body;
  const box = document.createElement('div');
  src.querySelectorAll('h1,h2,h3,p,blockquote,li,img').forEach(e => {
    let n;
    if (e.tagName === 'IMG') { n = document.createElement('img'); n.src = e.src; }
    else { if (!e.innerText.trim()) return; n = document.createElement(e.tagName); n.textContent = e.innerText; }
    box.appendChild(n);
  });
  document.querySelectorAll('link[rel=stylesheet],style').forEach(x => x.remove());
  document.body.replaceChildren(box);
  const s = document.createElement('style');
  s.textContent = 'body{max-width:680px;margin:40px auto;padding:0 20px;font:19px/1.7 Georgia,serif;background:#faf7f2;color:#222}img{max-width:100%;height:auto}';
  document.head.appendChild(s);
})();`;

// ---------------------------------------------------------------- storage
const file = (f) => path.join(app.getPath('userData'), f);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(file(f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(file(f), JSON.stringify(v)); } catch { /* non-fatal */ }
};

// ---------------------------------------------------------------- state
let win, ui, palette;
let nextId = 1;
let paletteOpen = false;
let blockedCount = 0;
let bookmarks = [];
let history = [];
const spaces = ['Home', 'Work', 'Fun'].map((name) => ({ name, tabs: [], active: null }));
let cur = spaces[0];
const activeTab = () => cur.active;

// ---------------------------------------------------------------- helpers
function resolve(input) {
  const t = String(input || '').trim();
  if (!t) return NEWTAB;
  if (/^(https?|file|about|data):/i.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && t.includes('.')) return 'https://' + t;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t);
}

function tabBounds() {
  const { width, height } = win.getContentBounds();
  return { x: SIDEBAR_W, y: TOP_H, width: Math.max(0, width - SIDEBAR_W), height: Math.max(0, height - TOP_H) };
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  ui.setBounds({ x: 0, y: 0, width, height });
  palette.setBounds({ x: 0, y: 0, width, height });
  for (const s of spaces) for (const t of s.tabs) t.view?.setBounds(tabBounds());
}

// ---------------------------------------------------------------- state -> UI
function snapshot() {
  const t = activeTab();
  const nav = t?.view?.webContents.navigationHistory;
  return {
    spaces: spaces.map((s) => s.name),
    space: cur.name,
    tabs: cur.tabs.map((x) => ({ id: x.id, title: x.title, favicon: x.favicon, loading: x.loading, active: x === cur.active })),
    url: t && t.url && t.url !== NEWTAB ? t.url : '',
    loading: !!t?.loading,
    canBack: !!nav?.canGoBack(),
    canForward: !!nav?.canGoForward(),
    bookmarked: !!t && bookmarks.some((b) => b.url === t.url),
    blocked: blockedCount
  };
}

let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('state', snapshot());
    const t = activeTab();
    win?.setTitle((t?.title || 'New tab') + ' \u2014 Drift');
    saveSession();
  }, 30);
}

let sessionTimer = null;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    writeJson('session.json', {
      space: cur.name,
      spaces: spaces.map((s) => ({
        name: s.name,
        active: s.tabs.indexOf(s.active),
        tabs: s.tabs.map((t) => ({ title: t.title, url: t.url, favicon: t.favicon }))
      }))
    });
  }, 500);
}

function addHistory(title, url) {
  history = history.filter((h) => h.url !== url);
  history.push({ title: title || url, url });
  if (history.length > 500) history.shift();
  writeJson('history.json', history);
}

// ---------------------------------------------------------------- tabs
function attachView(tab) {
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  tab.view = view;
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  view.setBounds(tabBounds());
  view.setVisible(false);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => { createTab(url); return { action: 'deny' }; });
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    const h = history.find((x) => x.url === tab.url);
    if (h) h.title = title;
    push();
  });
  wc.on('page-favicon-updated', (_e, favicons) => { tab.favicon = favicons[0] || ''; push(); });
  wc.on('did-start-loading', () => { tab.loading = true; push(); });
  wc.on('did-stop-loading', () => { tab.loading = false; push(); });
  wc.on('did-navigate', (_e, url) => {
    tab.url = url;
    if (/^https?:/.test(url)) addHistory(wc.getTitle(), url);
    push();
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) { tab.url = url; push(); } });
  return wc;
}

function createTab(input) {
  const tab = { id: nextId++, title: 'New tab', url: input ? resolve(input) : NEWTAB, favicon: '', loading: false, lastActive: Date.now(), view: null };
  cur.tabs.push(tab);
  activateTab(tab); // attaches the view and loads tab.url
  return tab;
}

function activateTab(tab) {
  if (!cur.tabs.includes(tab)) return;
  for (const t of cur.tabs) t.view?.setVisible(false);
  if (!tab.view) attachView(tab).loadURL(tab.url || NEWTAB);
  cur.active = tab;
  tab.lastActive = Date.now();
  tab.view.setBounds(tabBounds());
  tab.view.setVisible(true);
  if (!paletteOpen) tab.view.webContents.focus();
  push();
}

function destroyView(tab) {
  if (!tab.view) return;
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tab.view = null;
}

function closeTab(tab) {
  const i = cur.tabs.indexOf(tab);
  if (i < 0) return;
  cur.tabs.splice(i, 1);
  destroyView(tab);
  if (!cur.tabs.length) { cur.active = null; createTab(); return; }
  if (cur.active === tab) activateTab(cur.tabs[Math.min(i, cur.tabs.length - 1)]);
  else push();
}

function switchSpace(space) {
  if (space === cur) return;
  for (const t of cur.tabs) t.view?.setVisible(false);
  cur = space;
  if (!cur.tabs.length) createTab(); else activateTab(cur.active || cur.tabs[0]);
}

function go(text) {
  const t = activeTab();
  if (t?.view) { t.view.webContents.loadURL(resolve(text)); t.view.webContents.focus(); }
  else createTab(text);
}

function toggleBookmark() {
  const t = activeTab();
  if (!t || !t.url || t.url === NEWTAB) return;
  const i = bookmarks.findIndex((b) => b.url === t.url);
  if (i >= 0) bookmarks.splice(i, 1); else bookmarks.push({ title: t.title, url: t.url });
  writeJson('bookmarks.json', bookmarks);
  push();
}

// Free memory: tabs idle for a while are discarded and reloaded when you return to them.
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
  win.contentView.addChildView(palette); // re-adding moves it to the top
  palette.setVisible(true);
  palette.webContents.focus();
  palette.webContents.send('palette:open');
}

function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  palette.setVisible(false);
  activeTab()?.view?.webContents.focus();
}

function focusAddress() {
  ui.webContents.focus();
  ui.webContents.send('focus-address');
}

ipcMain.handle('palette:query', (_e, query) => {
  const q = String(query || '').trim();
  const needle = q.toLowerCase();
  const hit = (...fields) => !q || fields.some((f) => f && f.toLowerCase().includes(needle));
  const out = [];

  if (q) out.push({ kind: 'go', label: `Go or search \u201c${q}\u201d`, sub: resolve(q), act: { type: 'go', text: q } });
  for (const s of spaces)
    for (const t of s.tabs)
      if (hit(t.title, t.url)) out.push({ kind: 'tab', label: t.title || t.url, sub: `${s.name} \u00b7 open tab`, act: { type: 'tab', id: t.id } });
  bookmarks.filter((b) => hit(b.title, b.url)).slice(0, 6)
    .forEach((b) => out.push({ kind: 'bookmark', label: b.title, sub: b.url, act: { type: 'go', text: b.url } }));
  if (q) [...history].reverse().filter((h) => hit(h.title, h.url)).slice(0, 5)
    .forEach((h) => out.push({ kind: 'history', label: h.title, sub: h.url, act: { type: 'go', text: h.url } }));

  const commands = [
    ['New tab', 'new'], ['Close tab', 'close'], ['Reader mode', 'reader'],
    ['Bookmark or unbookmark this page', 'bookmark'], ['Developer tools', 'devtools'],
    ...spaces.map((s) => [`Switch to ${s.name}`, 'space:' + s.name])
  ];
  commands.filter(([label]) => hit(label))
    .forEach(([label, name]) => out.push({ kind: 'command', label, sub: 'Command', act: { type: 'cmd', name } }));

  return out.slice(0, 12);
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

// ---------------------------------------------------------------- commands
function command(name, arg) {
  const t = activeTab();
  const wc = t?.view?.webContents;
  switch (name) {
    case 'new': createTab(arg); if (!arg) focusAddress(); break;
    case 'close': { const target = arg ? cur.tabs.find((x) => x.id === arg) : t; if (target) closeTab(target); break; }
    case 'activate': { const target = cur.tabs.find((x) => x.id === arg); if (target) activateTab(target); break; }
    case 'space': { const s = spaces.find((x) => x.name === arg); if (s) switchSpace(s); break; }
    case 'go': go(arg); break;
    case 'back': wc?.navigationHistory.goBack(); break;
    case 'forward': wc?.navigationHistory.goForward(); break;
    case 'reload': wc?.reload(); break;
    case 'reader': wc?.executeJavaScript(READER_JS).catch(() => {}); break;
    case 'bookmark': toggleBookmark(); break;
    case 'devtools': wc?.toggleDevTools(); break;
    case 'palette': if (paletteOpen) closePalette(); else openPalette(); break;
    case 'closePalette': closePalette(); break;
    case 'address': focusAddress(); break;
  }
}
ipcMain.on('cmd', (_e, name, arg) => command(name, arg));

function buildMenu() {
  const mac = process.platform === 'darwin';
  const item = (label, accelerator, name, arg) => ({ label, accelerator, click: () => command(name, arg) });
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Browser',
      submenu: [
        item('Command palette', 'CmdOrCtrl+K', 'palette'),
        item('New tab', 'CmdOrCtrl+T', 'new'),
        item('Close tab', 'CmdOrCtrl+W', 'close'),
        item('Address bar', 'CmdOrCtrl+L', 'address'),
        item('Bookmark page', 'CmdOrCtrl+D', 'bookmark'),
        item('Reload', 'CmdOrCtrl+R', 'reload'),
        item('Back', mac ? 'Cmd+[' : 'Alt+Left', 'back'),
        item('Forward', mac ? 'Cmd+]' : 'Alt+Right', 'forward'),
        item('Reader mode', 'CmdOrCtrl+Shift+R', 'reader'),
        { type: 'separator' },
        ...spaces.map((s, i) => item(`Space: ${s.name}`, `CmdOrCtrl+${i + 1}`, 'space', s.name)),
        { type: 'separator' },
        item('Developer tools', 'F12', 'devtools')
      ]
    },
    { role: 'editMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app
function setupSession() {
  const ses = session.defaultSession;
  // Look like a normal Chrome so sites (e.g. Google sign-in) don't reject us.
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sdrift\/\S+/i, ''));
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission)));
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    let host = '';
    try { host = new URL(details.url).hostname; } catch { /* ignore */ }
    if (BLOCKED.some((b) => host === b || host.endsWith('.' + b))) { blockedCount++; push(); cb({ cancel: true }); }
    else cb({});
  });
}

function start() {
  bookmarks = readJson('bookmarks.json', []);
  history = readJson('history.json', []);
  setupSession();
  buildMenu();

  win = new BaseWindow({
    width: 1360, height: 860, minWidth: 760, minHeight: 480, title: 'Drift', show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16161d' : '#f3f4f8'
  });
  win.setMenuBarVisibility(false);

  const uiPrefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true };
  ui = new WebContentsView({ webPreferences: uiPrefs });
  ui.webContents.on('will-navigate', (e) => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.contentView.addChildView(ui);

  palette = new WebContentsView({ webPreferences: uiPrefs });
  palette.setBackgroundColor('#00000000');
  palette.webContents.loadFile(path.join(__dirname, 'ui', 'palette.html'));
  win.contentView.addChildView(palette);
  palette.setVisible(false);

  win.on('resize', layout);
  win.on('closed', () => { for (const s of spaces) for (const t of s.tabs) if (t.view) t.view.webContents.close(); });

  // Restore last session (tabs are loaded lazily when first shown).
  const saved = readJson('session.json', null);
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
  win.show();
  if (cur.tabs.length) activateTab(cur.active || cur.tabs[0]); else createTab();
  setInterval(discardIdleTabs, 60 * 1000);
}

app.setName('Drift');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
