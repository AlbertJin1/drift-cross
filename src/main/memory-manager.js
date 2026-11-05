'use strict';
// Configurable policy for releasing background WebContents. A discarded tab keeps
// its URL/title/favicon and is recreated when selected. Audible, captured, downloading,
// recently used, excluded, and visible tabs are protected from the applicable rules.

const KB = 1024;
const MINUTE = 60 * 1000;
const DEFAULTS = Object.freeze({
  idleMs: 3 * MINUTE,
  idleMsPressure1: 75 * 1000,
  idleMsPressure2: 40 * 1000,
  newTabIdleMs: 20 * 1000,
  maxBackgroundLive: 4,
  capMinIdleMs: 45 * 1000,
  pressureMinIdleMs: 15 * 1000,
  pressureReleasePerPass: 3
});

const TAB_OPTIMIZATION_DEFAULTS = Object.freeze({
  enabled: true,
  freezeBackground: true,
  freezeAfterSeconds: 30,
  idleMinutes: 3,
  maxBackgroundLive: 4,
  newTabIdleSeconds: 20,
  recentGraceSeconds: 45,
  pressureMode: 'balanced',
  excludedHosts: []
});
const ALLOWED_IDLE_MINUTES = new Set([0, 1, 2, 3, 5, 10, 15, 30, 60]);
const ALLOWED_BACKGROUND_CAPS = new Set([0, 1, 2, 3, 4, 6, 8, 12]);
const ALLOWED_NEW_TAB_SECONDS = new Set([0, 10, 20, 30, 60, 120]);
const ALLOWED_GRACE_SECONDS = new Set([15, 30, 45, 60, 90, 120, 180]);
const ALLOWED_FREEZE_SECONDS = new Set([10, 30, 60, 120, 300]);
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function normalizeExcludedHosts(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    let host = String(item ?? '').trim().toLowerCase();
    if (!host) continue;
    // Accept either a bare host or a pasted URL, but persist only its hostname.
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname.toLowerCase();
      else if (host.includes('/') || host.includes(':')) continue;
    } catch { continue; }
    host = host.replace(/^\*\./, '').replace(/\.$/, '');
    if (HOST_RE.test(host)) unique.add(host);
    if (unique.size >= 100) break;
  }
  return [...unique].sort();
}

function normalizeTabOptimizationSettings(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const pick = (candidate, allowed, fallback) => {
    const number = Number(candidate);
    return allowed.has(number) ? number : fallback;
  };
  return {
    enabled: value.enabled !== false,
    freezeBackground: value.freezeBackground !== false,
    freezeAfterSeconds: pick(value.freezeAfterSeconds, ALLOWED_FREEZE_SECONDS, TAB_OPTIMIZATION_DEFAULTS.freezeAfterSeconds),
    idleMinutes: pick(value.idleMinutes, ALLOWED_IDLE_MINUTES, TAB_OPTIMIZATION_DEFAULTS.idleMinutes),
    maxBackgroundLive: pick(value.maxBackgroundLive, ALLOWED_BACKGROUND_CAPS, TAB_OPTIMIZATION_DEFAULTS.maxBackgroundLive),
    newTabIdleSeconds: pick(value.newTabIdleSeconds, ALLOWED_NEW_TAB_SECONDS, TAB_OPTIMIZATION_DEFAULTS.newTabIdleSeconds),
    recentGraceSeconds: pick(value.recentGraceSeconds, ALLOWED_GRACE_SECONDS, TAB_OPTIMIZATION_DEFAULTS.recentGraceSeconds),
    pressureMode: ['off', 'balanced', 'aggressive'].includes(value.pressureMode) ? value.pressureMode : TAB_OPTIMIZATION_DEFAULTS.pressureMode,
    excludedHosts: normalizeExcludedHosts(value.excludedHosts)
  };
}

function discardConfigFromSettings(input = {}) {
  const settings = normalizeTabOptimizationSettings(input);
  const noIdleExpiry = settings.idleMinutes === 0;
  const aggressive = settings.pressureMode === 'aggressive';
  return {
    idleMs: noIdleExpiry ? Infinity : settings.idleMinutes * MINUTE,
    // Pressure-triggered idle expiry is bounded independently so the selected normal
    // idle timeout remains predictable while still allowing memory relief when enabled.
    idleMsPressure1: noIdleExpiry ? Infinity : aggressive ? 45 * 1000 : 75 * 1000,
    idleMsPressure2: noIdleExpiry ? Infinity : aggressive ? 20 * 1000 : 40 * 1000,
    newTabIdleMs: settings.newTabIdleSeconds === 0 ? Infinity : settings.newTabIdleSeconds * 1000,
    maxBackgroundLive: settings.maxBackgroundLive,
    capMinIdleMs: settings.recentGraceSeconds * 1000,
    pressureMinIdleMs: aggressive ? 10 * 1000 : 15 * 1000,
    pressureReleasePerPass: aggressive ? 5 : 3
  };
}

/**
 * @param {Array<{id:number,lastActive:number,visible:boolean,audible?:boolean,busy?:boolean,excluded?:boolean,isNewTab?:boolean,memoryKB?:number}>} tabs
 * @param {{now:number,pressure?:0|1|2,config?:object}} options
 * @returns {number[]} ids of tabs to discard
 */
function planDiscards(tabs, { now, pressure = 0, config = {} }) {
  const c = { ...DEFAULTS, ...config };
  const idleFor = (tab) => Math.max(0, now - tab.lastActive);
  const candidates = tabs.filter((tab) => !tab.visible && !tab.audible && !tab.busy && !tab.excluded);
  const idleLimit = pressure >= 2 ? c.idleMsPressure2 : pressure === 1 ? c.idleMsPressure1 : c.idleMs;
  const chosen = new Map();

  for (const tab of candidates) {
    const limit = tab.isNewTab ? Math.min(c.newTabIdleMs, idleLimit) : idleLimit;
    if (idleFor(tab) > limit) chosen.set(tab.id, tab);
  }

  // A cap of 0 means no user-imposed live background-tab limit.
  if (c.maxBackgroundLive > 0) {
    // Protected tabs still count toward the cap because their renderers still consume memory.
    let excess = tabs.filter((tab) => !tab.visible).length - chosen.size - c.maxBackgroundLive;
    if (excess > 0) {
      const lru = candidates
        .filter((tab) => !chosen.has(tab.id) && idleFor(tab) > c.capMinIdleMs)
        .sort((a, b) => a.lastActive - b.lastActive);
      for (const tab of lru) {
        if (excess <= 0) break;
        chosen.set(tab.id, tab);
        excess -= 1;
      }
    }
  }

  // High pressure: release only eligible, idle background tabs; never protected tabs.
  if (pressure >= 2) {
    const heavy = candidates
      .filter((tab) => !chosen.has(tab.id) && idleFor(tab) > c.pressureMinIdleMs)
      .sort((a, b) => (b.memoryKB || 0) - (a.memoryKB || 0))
      .slice(0, c.pressureReleasePerPass);
    for (const tab of heavy) chosen.set(tab.id, tab);
  }

  return [...chosen.keys()];
}

/**
 * The cheaper tier before discarding: a frozen background page keeps its DOM and scroll
 * position but runs no script, timers or rendering, so Chromium can purge its caches
 * and the tab resumes instantly instead of reloading.
 * @param {Array<{id:number,lastActive:number,visible:boolean,audible?:boolean,busy?:boolean,excluded?:boolean,frozen?:boolean,loading?:boolean}>} tabs
 * @param {{now:number, afterMs?:number}} options
 * @returns {number[]} ids of tabs to freeze now
 */
function planFreezes(tabs, { now, afterMs = 30 * 1000 }) {
  return tabs
    .filter((tab) => !tab.visible && !tab.frozen && !tab.audible && !tab.busy && !tab.excluded && !tab.loading)
    .filter((tab) => Math.max(0, now - tab.lastActive) >= afterMs)
    .map((tab) => tab.id);
}

/** Reads system/application memory pressure. Level 2 = high, 1 = moderate, 0 = fine. */
function measurePressure({ getSystemMemoryInfo, getAppMetrics, isWindows }) {
  const result = { level: 0, usedKB: 0, byPid: new Map() };
  let totalKB = 0;
  try {
    const system = getSystemMemoryInfo();
    totalKB = Number(system.total) || 0;
    if (isWindows && totalKB) {
      const freeRatio = (Number(system.free) || 0) / totalKB;
      if (freeRatio < 0.12) result.level = 2;
      else if (freeRatio < 0.25) result.level = 1;
    }
  } catch { /* not available on this platform */ }
  try {
    for (const metric of getAppMetrics()) {
      const memory = metric.memory || {};
      const kb = Number(memory.privateBytes ?? memory.workingSetSize) || 0;
      result.usedKB += kb;
      result.byPid.set(metric.pid, kb);
    }
  } catch { /* metrics unavailable */ }
  const budgetKB = Math.max(1.25 * 1024 * KB, totalKB * 0.30);
  if (result.usedKB > budgetKB) result.level = 2;
  else if (result.usedKB > budgetKB * 0.7) result.level = Math.max(result.level, 1);
  return result;
}

module.exports = {
  planDiscards,
  planFreezes,
  measurePressure,
  DEFAULTS,
  TAB_OPTIMIZATION_DEFAULTS,
  normalizeExcludedHosts,
  normalizeTabOptimizationSettings,
  discardConfigFromSettings
};
