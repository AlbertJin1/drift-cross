(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const root = document.documentElement;
  const IS_MAC = /Mac/i.test(navigator.platform);

  // ------------------------------------------------------------ theme
  // The browser passes the user's appearance + accent in the URL. "system"
  // (or anything unrecognised) follows the OS and updates live.
  const COLOR_THEMES = ['violet', 'ocean', 'forest', 'rose', 'sunset', 'indigo', 'graphite', 'mint'];
  const colorTheme = params.get('theme');
  if (COLOR_THEMES.includes(colorTheme)) root.dataset.colorTheme = colorTheme;
  const mode = params.get('mode');
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  const applyMode = () => { root.dataset.theme = mode === 'light' || mode === 'dark' ? mode : (systemLight.matches ? 'light' : 'dark'); };
  applyMode();
  systemLight.addEventListener('change', applyMode);
  const accent = params.get('accent') || '';
  if (/^#[0-9a-f]{6}$/i.test(accent)) {
    const value = accent.slice(1);
    const darker = [0, 2, 4].map((offset) => Math.round(parseInt(value.slice(offset, offset + 2), 16) * .78).toString(16).padStart(2, '0')).join('');
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-strong', `#${darker}`);
  }
  const safeChoice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  root.dataset.background = safeChoice(params.get('ntbg'), ['aurora', 'midnight', 'paper', 'forest', 'sunset'], 'aurora');
  root.dataset.layout = safeChoice(params.get('ntlayout'), ['centered', 'wide', 'compact'], 'centered');
  root.dataset.tileSize = safeChoice(params.get('nttile'), ['small', 'medium', 'large'], 'medium');
  root.dataset.motion = safeChoice(params.get('ntmotion'), ['full', 'reduced', 'off'], 'full');
  const fontFamily = { system: 'system-ui, -apple-system, "Segoe UI", sans-serif', inter: 'Inter, system-ui, sans-serif', segoe: '"Segoe UI", system-ui, sans-serif', arial: 'Arial, Helvetica, sans-serif' };
  root.style.setProperty('--newtab-font', fontFamily[params.get('ntfont')] || fontFamily.system);
  const newTabScale = [90, 95, 100, 105, 110, 115, 120].includes(Number(params.get('ntscale'))) ? Number(params.get('ntscale')) : 100;
  const scaleFactor = newTabScale / 100;
  root.style.setProperty('--newtab-scale', String(scaleFactor));
  const page = document.querySelector('.page');
  if (page) {
    const layoutWidth = root.dataset.layout === 'wide' ? 1480 : root.dataset.layout === 'compact' ? 780 : 1240;
    page.style.zoom = String(scaleFactor);
    page.style.width = `min(${100 / scaleFactor}%, ${layoutWidth / scaleFactor}px)`;
    page.style.minHeight = `${100 / scaleFactor}vh`;
  }

  document.querySelectorAll('.mod').forEach((el) => { el.textContent = IS_MAC ? '⌘' : 'Ctrl'; });

  // ------------------------------------------------------------ helpers
  const ICONS = {
    search: '<svg data-fa="search"></svg>',
    globe: '<svg data-fa="globe"></svg>',
    link: '<svg data-fa="arrowRight"></svg>',
    check: '<svg data-fa="check"></svg>',
    close: '<svg data-fa="close"></svg>',
    plus: '<svg data-fa="plus"></svg>'
  };
  const ENGINES = {
    duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
    google: { name: 'Google', url: 'https://www.google.com/search?q=' },
    bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
    brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' }
  };
  let engine = ENGINES[params.get('engine')] ? params.get('engine') : 'duckduckgo';

  function safeUrl(value) {
    try { const u = new URL(String(value)); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
  }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
  // Turns what the person typed into a URL, or '' when it should be a search.
  function toUrl(raw) {
    const t = String(raw || '').trim();
    if (!t) return '';
    if (/^(https?|file|about|data):/i.test(t)) return t;
    if (/^localhost(?::\d+)?(?:[/?#]|$)/i.test(t) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/.test(t)) return 'http://' + t;
    if (!/\s/.test(t) && t.includes('.')) return 'https://' + t;
    return '';
  }
  const searchUrl = (text) => ENGINES[engine].url + encodeURIComponent(text.trim());
  const go = (url) => { location.href = url; };

  function readData() {
    const empty = { b: [], s: [] };
    const raw = params.get('d');
    if (!raw) return empty;
    try {
      const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      const clean = (list) => (Array.isArray(list) ? list : [])
        .filter((item) => Array.isArray(item) && safeUrl(item[1]))
        .map((item) => [String(item[0] || '').slice(0, 40), safeUrl(item[1])]);
      return { b: clean(parsed.b), s: clean(parsed.s) };
    } catch { return empty; }
  }
  const data = readData();

  // ------------------------------------------------------------ greeting + clock
  const showClock = params.get('clock') !== '0';
  $('clock-wrap').hidden = !showClock;
  function tick() {
    const now = new Date();
    const h = now.getHours();
    $('greeting').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('day').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const parts = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).formatToParts(now);
    const period = parts.find((p) => p.type === 'dayPeriod');
    $('clock').textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
    $('clock-period').textContent = period ? period.value : '';
    root.dataset.part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  }
  tick();
  setInterval(tick, 15000);

  // ------------------------------------------------------------ shortcuts
  const MAX_TILES = 9; // 9 sites + the "Add shortcut" tile fill two rows of five
  const DEFAULTS = [
    ['DuckDuckGo', 'https://duckduckgo.com/', 'duck'], ['Wikipedia', 'https://wikipedia.org/', 'wiki'],
    ['GitHub', 'https://github.com/', 'github'], ['YouTube', 'https://youtube.com/', 'youtube'], ['Reddit', 'https://reddit.com/', 'reddit']
  ];
  const PIN_KEY = 'drift.newtab.pins';
  const BRANDS = ['duck', 'wiki', 'github', 'youtube', 'reddit'];
  const shortcutMode = ['smart', 'bookmarks', 'hidden'].includes(params.get('sc')) ? params.get('sc') : 'smart';
  let pins = [];
  let shownTiles = [];
  try {
    const stored = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    if (Array.isArray(stored)) pins = stored.filter((p) => Array.isArray(p) && safeUrl(p[1])).slice(0, MAX_TILES).map((p) => [String(p[0] || '').slice(0, 40), safeUrl(p[1]), BRANDS.includes(p[2]) ? p[2] : undefined]);
  } catch { /* storage unavailable: pins last for this page only */ }
  const savePins = () => { try { localStorage.setItem(PIN_KEY, JSON.stringify(pins.map((p) => (p[2] ? p : [p[0], p[1]])))); } catch { /* ignore */ } };

  function hueOf(text) { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }

  function renderTiles() {
    const section = $('shortcuts');
    section.hidden = shortcutMode === 'hidden';
    if (section.hidden) return;

    const tiles = pins.map(([title, url, brand], i) => ({ title: title || hostOf(url), url, brand, pin: i }));
    const seen = new Set(tiles.map((t) => hostOf(t.url)));
    const push = (title, url, brand) => {
      const key = hostOf(url);
      if (!key || seen.has(key) || tiles.length >= MAX_TILES) return;
      seen.add(key); tiles.push({ title: title || key, url, brand });
    };
    if (shortcutMode === 'smart') {
      data.s.forEach(([title, url]) => push(title, url));
      DEFAULTS.forEach(([title, url, brand]) => push(title, url, brand));
    } else {
      data.b.forEach(([title, url]) => push(title, url));
    }

    $('sc-title').textContent = shortcutMode === 'bookmarks' ? 'Bookmarks' : (data.s.length ? 'Most visited' : 'Quick access');
    $('sc-hint').textContent = shortcutMode === 'bookmarks' ? 'Your most recent bookmarks' : (data.s.length ? 'Based on your browsing history' : 'Your essentials, one click away');

    shownTiles = tiles;
    const nodes = tiles.map((tile, idx) => {
      const wrap = document.createElement('div'); wrap.className = 'tile-wrap'; wrap.draggable = true; wrap.dataset.idx = String(idx);
      const link = document.createElement('a'); link.className = 'tile'; link.draggable = false; link.href = tile.url; link.title = tile.title + ' — ' + hostOf(tile.url);
      const mark = document.createElement('span'); mark.className = 'tile-mark' + (tile.brand ? ' brand-' + tile.brand : '');
      mark.textContent = (tile.title.match(/[\p{L}\p{N}]/u) || ['•'])[0].toUpperCase();
      if (!tile.brand) { const h = hueOf(hostOf(tile.url)); mark.style.background = `linear-gradient(145deg, hsl(${h} 62% 52%), hsl(${(h + 26) % 360} 62% 42%))`; }
      const text = document.createElement('span'); text.className = 'tile-text';
      const label = document.createElement('span'); label.className = 'tile-label'; label.textContent = tile.title;
      const host = document.createElement('span'); host.className = 'tile-host'; host.textContent = hostOf(tile.url);
      text.append(label, host);
      link.append(mark, text); wrap.append(link);
      if (tile.pin !== undefined) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'tile-remove';
        remove.setAttribute('aria-label', 'Remove shortcut ' + tile.title); remove.title = 'Remove shortcut'; remove.innerHTML = ICONS.close;
        remove.addEventListener('click', () => { pins.splice(tile.pin, 1); savePins(); renderTiles(); });
        wrap.append(remove);
      }
      return wrap;
    });

    if (!tiles.length) {
      const note = document.createElement('p'); note.className = 'tiles-empty';
      note.textContent = 'No bookmarks yet — press ' + (IS_MAC ? '⌘' : 'Ctrl') + '+D on any page to save it here.';
      nodes.push(note);
    }
    if (pins.length < MAX_TILES) {
      const wrap = document.createElement('div'); wrap.className = 'tile-wrap';
      wrap.classList.add('tile-add-wrap'); const add = document.createElement('button'); add.type = 'button'; add.className = 'tile tile-add'; add.id = 'add-tile';
      const mark = document.createElement('span'); mark.className = 'tile-mark'; mark.innerHTML = ICONS.plus;
      const text = document.createElement('span'); text.className = 'tile-text';
      const label = document.createElement('span'); label.className = 'tile-label'; label.textContent = 'Add shortcut';
      const host = document.createElement('span'); host.className = 'tile-host'; host.textContent = 'Pin a favourite site';
      text.append(label, host);
      add.append(mark, text); wrap.append(add); nodes.push(wrap);
      add.addEventListener('click', openPinDialog);
    }
    $('tiles').replaceChildren(...nodes);
  }

  // drag to reorder: dragging any tile pins the current layout in the new order
  (() => {
    const grid = $('tiles');
    let from = -1;
    const clear = () => grid.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    const place = (e, el) => { const r = el.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
    grid.addEventListener('dragstart', (e) => {
      const wrap = e.target.closest?.('.tile-wrap[data-idx]');
      if (!wrap) return;
      from = Number(wrap.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', shownTiles[from]?.url || ''); } catch { /* ignore */ }
      requestAnimationFrame(() => wrap.classList.add('dragging'));
    });
    grid.addEventListener('dragover', (e) => {
      if (from < 0) return;
      const wrap = e.target.closest?.('.tile-wrap');
      if (!wrap) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      clear();
      if (wrap.classList.contains('tile-add-wrap')) { const last = grid.querySelector('.tile-wrap[data-idx]:last-of-type, .tile-wrap[data-idx]:nth-last-child(2)'); if (last) last.classList.add('drop-after'); return; }
      if (Number(wrap.dataset.idx) !== from) wrap.classList.add(place(e, wrap) ? 'drop-after' : 'drop-before');
    });
    grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) clear(); });
    grid.addEventListener('drop', (e) => {
      if (from < 0) return;
      const wrap = e.target.closest?.('.tile-wrap');
      if (!wrap) return;
      e.preventDefault(); clear();
      let to; let after;
      if (wrap.classList.contains('tile-add-wrap')) { to = shownTiles.length - 1; after = true; }
      else { to = Number(wrap.dataset.idx); after = place(e, wrap); }
      if (to === from) { from = -1; return; }
      const order = shownTiles.slice();
      const [moved] = order.splice(from, 1);
      const target = order.indexOf(shownTiles[to]);
      order.splice(after ? target + 1 : target, 0, moved);
      pins = order.slice(0, MAX_TILES).map((t) => [t.title, t.url, t.brand]);
      from = -1; savePins(); renderTiles();
    });
    grid.addEventListener('dragend', () => { from = -1; clear(); grid.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging')); });
  })();

  // add-shortcut dialog
  const dialog = $('pin-dialog');
  const pinForm = $('pin-form');
  pinForm.noValidate = true;
  function openPinDialog() {
    pinForm.reset(); $('pin-error').hidden = true;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    $('pin-url').focus();
  }
  pinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = safeUrl(toUrl($('pin-url').value));
    if (!url) { $('pin-error').hidden = false; $('pin-url').focus(); return; }
    const dup = pins.findIndex((p) => p[1] === url);
    if (dup >= 0) pins.splice(dup, 1); // re-adding a site moves it to the end instead of duplicating it
    if (pins.length >= MAX_TILES) pins.shift();
    pins.push([$('pin-name').value.trim().slice(0, 40), url]);
    savePins(); dialog.close(); renderTiles();
  });
  $('pin-url').addEventListener('input', () => { $('pin-error').hidden = true; });
  $('pin-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

  // ------------------------------------------------------------ search, suggestions, engine picker
  const form = $('f'); const input = $('q');
  const suggestBox = $('suggest'); const engineMenu = $('engine-menu'); const engineBtn = $('engine-btn');
  let items = []; let active = -1;

  function setEngine(id) {
    engine = id;
    $('engine-name').textContent = ENGINES[id].name;
    input.placeholder = 'Search ' + ENGINES[id].name + ' or enter a website address';
    engineBtn.title = 'Search engine: ' + ENGINES[id].name;
  }
  setEngine(engine);

  function option(icon, main, sub, selected) {
    const li = document.createElement('li'); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(!!selected));
    const ic = document.createElement('span'); ic.className = 'opt-icon'; ic.innerHTML = icon;
    const m = document.createElement('span'); m.className = 'opt-main'; m.textContent = main;
    li.append(ic, m);
    if (sub) { const s = document.createElement('span'); s.className = 'opt-sub'; s.textContent = sub; li.append(s); }
    return li;
  }
  function closeSuggest() { items = []; active = -1; suggestBox.hidden = true; suggestBox.replaceChildren(); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function closeEngineMenu() { engineMenu.hidden = true; engineBtn.setAttribute('aria-expanded', 'false'); }
  function paintActive() {
    [...suggestBox.children].forEach((li, i) => { li.setAttribute('aria-selected', String(i === active)); if (i === active) li.scrollIntoView({ block: 'nearest' }); });
  }
  function buildSuggestions(text) {
    const q = text.trim();
    const out = [];
    const direct = toUrl(q);
    if (direct) out.push({ icon: ICONS.link, main: 'Go to ' + direct.replace(/^https?:\/\//i, '').replace(/\/$/, ''), url: direct });
    out.push({ icon: ICONS.search, main: 'Search ' + ENGINES[engine].name + ' for “' + q + '”', url: searchUrl(q) });
    const needle = q.toLowerCase(); const used = new Set();
    for (const [title, url] of [...pins, ...data.s, ...data.b, ...DEFAULTS.map((d) => [d[0], d[1]])]) {
      if (out.length >= 7) break;
      if (used.has(url) || !(title + ' ' + url).toLowerCase().includes(needle)) continue;
      used.add(url); out.push({ icon: ICONS.globe, main: title || hostOf(url), sub: hostOf(url), url });
    }
    return out;
  }
  function openSuggest() {
    if (!input.value.trim()) { closeSuggest(); return; }
    closeEngineMenu();
    items = buildSuggestions(input.value); active = -1;
    suggestBox.replaceChildren(...items.map((item, i) => {
      const li = option(item.icon, item.main, item.sub, false); li.id = 'sg' + i;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); go(item.url); });
      return li;
    }));
    suggestBox.hidden = false; input.setAttribute('aria-expanded', 'true');
  }

  input.addEventListener('input', openSuggest);
  input.addEventListener('keydown', (event) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault();
      active = event.key === 'ArrowDown' ? (active + 1) % items.length : (active <= 0 ? items.length - 1 : active - 1);
      input.setAttribute('aria-activedescendant', 'sg' + active); paintActive();
    } else if (event.key === 'Escape') {
      if (!suggestBox.hidden) closeSuggest(); else input.value = '';
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = input.value.trim(); if (!raw) return;
    if (active >= 0 && items[active]) { go(items[active].url); return; }
    go(toUrl(raw) || searchUrl(raw));
  });

  // engine picker
  function buildEngineMenu() {
    engineMenu.replaceChildren(...Object.entries(ENGINES).map(([id, e]) => {
      const li = option(ICONS.search, e.name, '', id === engine);
      if (id === engine) { const c = document.createElement('span'); c.className = 'opt-check'; c.innerHTML = ICONS.check; li.append(c); }
      li.addEventListener('click', () => { setEngine(id); closeEngineMenu(); input.focus(); if (input.value.trim()) openSuggest(); });
      return li;
    }));
  }
  engineBtn.addEventListener('click', () => {
    if (engineMenu.hidden) { closeSuggest(); buildEngineMenu(); engineMenu.hidden = false; engineBtn.setAttribute('aria-expanded', 'true'); }
    else closeEngineMenu();
  });
  document.addEventListener('mousedown', (event) => {
    if (!form.contains(event.target)) { closeSuggest(); closeEngineMenu(); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEngineMenu();
    // Start typing anywhere on the page to search.
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    if (dialog.open || event.target instanceof HTMLInputElement) return;
    input.focus();
  });

  renderTiles();
  // Focus stays in the browser's address bar; click here or just start typing to use this box.
})();
