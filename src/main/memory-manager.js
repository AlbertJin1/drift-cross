'use strict';
// Decides which background tabs should give their renderer process back.
//
// Drift keeps each tab's URL, title and favicon, so a discarded tab looks unchanged in the
// tab strip and is recreated the moment it is selected. Memory is reclaimed by:
//   1. idle expiry     - background tabs untouched for a while (shorter under memory pressure),
//   2. a live-tab cap  - at most `maxBackgroundLive` background tabs keep a renderer (LRU),
//   3. quick New Tab   - an idle New Tab page is trivial to recreate, so it goes after seconds,
//   4. pressure relief - when the machine or Drift itself is short of memory, the heaviest
//                        idle tabs are released first.
// Tabs that are playing audio, being captured or owning a running download are never touched,
// and neither is the visible tab.

const KB = 1024;

const DEFAULTS = {
  idleMs: 3 * 60 * 1000,            // normal idle expiry for background tabs
  idleMsPressure1: 75 * 1000,       // moderate pressure
  idleMsPressure2: 40 * 1000,       // high pressure
  newTabIdleMs: 20 * 1000,          // idle New Tab pages
  maxBackgroundLive: 4,             // background tabs allowed to keep a renderer
  capMinIdleMs: 45 * 1000,          // a tab used in the last 45 s is never dropped by the cap
  pressureMinIdleMs: 15 * 1000,     // under high pressure, tabs idle this long may be released early
  pressureReleasePerPass: 3         // ...at most this many per pass, heaviest first
};

/**
 * @param {Array<{id:number,lastActive:number,visible:boolean,audible?:boolean,busy?:boolean,isNewTab?:boolean,memoryKB?:number}>} tabs
 *        Every tab that currently owns a renderer.
 * @param {{now:number,pressure?:0|1|2,config?:object}} options
 * @returns {number[]} ids of tabs to discard
 */
function planDiscards(tabs, { now, pressure = 0, config = {} }) {
  const c = { ...DEFAULTS, ...config };
  const idleFor = (tab) => now - tab.lastActive;
  const candidates = tabs.filter((tab) => !tab.visible && !tab.audible && !tab.busy);
  const idleLimit = pressure >= 2 ? c.idleMsPressure2 : pressure === 1 ? c.idleMsPressure1 : c.idleMs;
  const chosen = new Map();

  for (const tab of candidates) {
    const limit = tab.isNewTab ? Math.min(c.newTabIdleMs, idleLimit) : idleLimit;
    if (idleFor(tab) > limit) chosen.set(tab.id, tab);
  }

  // Cap on loaded background tabs, least recently used first. Protected tabs still count
  // toward the cap because they still hold memory; they just cannot be the ones released.
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

  // High pressure: release the heaviest remaining idle tabs now instead of waiting for expiry.
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
 * Reads how much memory pressure Drift is under.
 * Level 2 = high, 1 = moderate, 0 = fine. Also returns per-process memory by OS pid.
 *
 * Drift's own footprint is compared with a budget of 30% of system RAM (never below 1.25 GB).
 * On Windows `free` already counts reclaimable standby memory, so it is also used directly;
 * on macOS and Linux `free` excludes the file cache and would report false pressure.
 */
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
      // privateBytes (Windows) avoids double counting pages shared between Chromium processes.
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

module.exports = { planDiscards, measurePressure, DEFAULTS };
