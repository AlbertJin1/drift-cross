'use strict';

// Durable, chronological restore history for closed tabs and browser windows.
// A window entry keeps all of its tabs and the previously active tab so that
// Ctrl+Shift+T can recover a complete browser instance after Drift restarts.

const FILE_NAME = 'recently-closed.json';
const MAX_ENTRIES = 50;
const MAX_WINDOW_TABS = 100;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 500;
const MAX_FAVICON_LENGTH = 4096;

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeTab(value) {
  if (!value || typeof value !== 'object') return null;
  const url = cleanString(value.url, MAX_URL_LENGTH);
  if (!url) return null;
  return {
    url,
    title: cleanString(value.title, MAX_TITLE_LENGTH) || url,
    favicon: cleanString(value.favicon, MAX_FAVICON_LENGTH)
  };
}

function normalizeEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanString(value.id, 100);
  const closedAt = Number.isFinite(value.closedAt) && value.closedAt > 0 ? value.closedAt : Date.now();
  if (value.type === 'tab') {
    const tab = normalizeTab(value.tab);
    if (!tab) return null;
    return { id, type: 'tab', closedAt, tab, index: Math.max(0, Math.trunc(Number(value.index) || 0)) };
  }
  if (value.type === 'window') {
    const sourceTabs = Array.isArray(value.tabs) ? value.tabs.slice(0, MAX_WINDOW_TABS) : [];
    const indexedTabs = sourceTabs.map((tab, index) => ({ tab: normalizeTab(tab), index })).filter((entry) => entry.tab);
    if (!indexedTabs.length) return null;
    const requestedActive = Number.isInteger(value.activeIndex) ? value.activeIndex : 0;
    let activeIndex = indexedTabs.findIndex((entry) => entry.index === requestedActive);
    if (activeIndex < 0) activeIndex = Math.min(indexedTabs.length - 1, Math.max(0, requestedActive));
    return { id, type: 'window', closedAt, tabs: indexedTabs.map((entry) => entry.tab), activeIndex };
  }
  return null;
}

function createRecentlyClosedStore({ readJson, writeJson, now = Date.now, random = Math.random }) {
  if (typeof readJson !== 'function' || typeof writeJson !== 'function') {
    throw new TypeError('recently-closed store requires readJson and writeJson');
  }

  const saved = readJson(FILE_NAME, { version: 1, entries: [] });
  let entries = (Array.isArray(saved?.entries) ? saved.entries : [])
    .map(normalizeEntry).filter(Boolean).slice(-MAX_ENTRIES);
  let sequence = 0;

  function makeId() {
    sequence += 1;
    return `closed-${Math.trunc(now()).toString(36)}-${sequence.toString(36)}-${Math.floor(random() * 0x1000000).toString(36)}`;
  }

  function persist() {
    return writeJson(FILE_NAME, { version: 1, entries });
  }

  function add(entry) {
    const normalized = normalizeEntry({ ...entry, id: makeId(), closedAt: now() });
    if (!normalized) return null;
    entries.push(normalized);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    persist();
    return normalized.id;
  }

  function pushTab(tab, index = 0) {
    const normalized = normalizeTab(tab);
    if (!normalized || /^about:blank$/i.test(normalized.url)) return null;
    return add({ type: 'tab', tab: normalized, index });
  }

  function pushWindow(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.tabs)) return null;
    const tabs = snapshot.tabs.slice(0, MAX_WINDOW_TABS).map(normalizeTab);
    // New Tab / blank pages aren't useful recovery targets. Keep their positions
    // out of the stored snapshot and remap the active index accordingly.
    const activeSourceIndex = Number.isInteger(snapshot.active) ? snapshot.active : 0;
    const retained = tabs.map((tab, index) => ({ tab, index })).filter(({ tab }) => tab && !/^about:blank$/i.test(tab.url) && !/^file:.*newtab\.html/i.test(tab.url));
    if (!retained.length) return null;
    const activeIndex = Math.max(0, retained.findIndex(({ index }) => index === activeSourceIndex));
    return add({ type: 'window', tabs: retained.map(({ tab }) => tab), activeIndex });
  }

  function list(limit = 10) {
    const size = Math.max(0, Math.min(MAX_ENTRIES, Math.trunc(Number(limit) || 0)));
    if (!size) return [];
    return entries.slice(-size).reverse().map((entry) => entry.type === 'window'
      ? { id: entry.id, type: entry.type, title: 'Closed browser window', url: entry.tabs[entry.activeIndex]?.url || entry.tabs[0]?.url || '', tabCount: entry.tabs.length, activeTitle: entry.tabs[entry.activeIndex]?.title || '' }
      : { id: entry.id, type: entry.type, title: entry.tab.title, url: entry.tab.url, tabCount: 1, activeTitle: entry.tab.title });
  }

  function pop(id) {
    let index = entries.length - 1;
    if (id !== undefined && id !== null && id !== '') index = entries.findIndex((entry) => entry.id === String(id));
    if (index < 0) return null;
    const [entry] = entries.splice(index, 1);
    persist();
    return entry;
  }

  function clear() {
    entries = [];
    persist();
  }

  return {
    pushTab,
    pushWindow,
    list,
    pop,
    clear,
    get count() { return entries.length; },
    get size() { return entries.length; }
  };
}

module.exports = {
  FILE_NAME,
  MAX_ENTRIES,
  MAX_WINDOW_TABS,
  normalizeTab,
  normalizeEntry,
  createRecentlyClosedStore
};
