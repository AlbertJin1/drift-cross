'use strict';

// Exercises src/main/memory-manager.js (tab discard policy + pressure measurement). No Electron needed:
//   npm run test:memory

const assert = require('node:assert/strict');
const { planDiscards, measurePressure, DEFAULTS, normalizeTabOptimizationSettings, discardConfigFromSettings } = require('../src/main/memory-manager.js');

const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); } catch (error) { results.push([false, name, error]); }
}

const NOW = 10_000_000;
const MIN = 60 * 1000;
const tab = (id, idleMs, extra = {}) => ({ id, lastActive: NOW - idleMs, visible: false, audible: false, busy: false, isNewTab: false, memoryKB: 0, ...extra });
const plan = (tabs, pressure = 0, config) => planDiscards(tabs, { now: NOW, pressure, config }).sort((a, b) => a - b);

test('a tab idle for under three minutes is kept', () => {
  assert.deepEqual(plan([tab(1, 2 * MIN)]), []);
});
test('a tab idle for over three minutes is discarded', () => {
  assert.deepEqual(plan([tab(1, 4 * MIN)]), [1]);
});
test('the visible tab is never discarded, however old', () => {
  assert.deepEqual(plan([tab(1, 60 * MIN, { visible: true })], 2), []);
});
test('audible, captured and downloading tabs are never discarded', () => {
  const tabs = [tab(1, 60 * MIN, { audible: true }), tab(2, 60 * MIN, { busy: true }), tab(3, 60 * MIN)];
  assert.deepEqual(plan(tabs, 2), [3]);
});
test('an idle New Tab page goes after 20 seconds', () => {
  assert.deepEqual(plan([tab(1, 50 * 1000, { isNewTab: true }), tab(2, 50 * 1000)]), [1]);
});
test('moderate pressure shortens the idle limit to 75 seconds', () => {
  assert.deepEqual(plan([tab(1, 3 * MIN), tab(2, 60 * 1000)], 1), [1]);
});
test('high pressure shortens the idle limit to 40 seconds', () => {
  assert.deepEqual(plan([tab(1, 90 * 1000), tab(2, 30 * 1000)], 2).includes(1), true);
});
test('the live-tab cap drops the least recently used tabs first', () => {
  const tabs = [];
  for (let i = 1; i <= 9; i++) tabs.push(tab(i, i * 70 * 1000 / 2)); // 35s..315s idle; tab 9 (315s) already expires by idle time
  tabs.push(tab(10, 0, { visible: true }));
  const dropped = plan(tabs);
  assert.ok(dropped.includes(9), 'the expired tab goes');
  const background = tabs.filter((t) => !t.visible).length;
  assert.ok(background - dropped.length <= DEFAULTS.maxBackgroundLive, 'no more than the cap remain loaded');
  assert.ok(!dropped.includes(1), 'the most recently used tab survives');
});
test('the cap never drops a tab used within the last 45 seconds', () => {
  const tabs = [];
  for (let i = 1; i <= 12; i++) tabs.push(tab(i, 10 * 1000 + i)); // all recently used
  assert.deepEqual(plan(tabs), []);
});
test('protected tabs still count toward the cap but are not released by it', () => {
  const tabs = [];
  for (let i = 1; i <= 8; i++) tabs.push(tab(i, 2 * MIN, { audible: i <= 3 }));
  const dropped = plan(tabs);
  assert.ok(dropped.every((id) => id > 3), 'audible tabs are untouched');
  assert.equal(dropped.length, 8 - DEFAULTS.maxBackgroundLive);
});
test('high pressure also releases the heaviest idle tabs early, three at most', () => {
  const tabs = [tab(1, 25 * 1000, { memoryKB: 900_000 }), tab(2, 25 * 1000, { memoryKB: 100_000 }), tab(3, 25 * 1000, { memoryKB: 600_000 }), tab(4, 25 * 1000, { memoryKB: 300_000 })];
  assert.deepEqual(plan(tabs, 2), [1, 3, 4]);
  assert.deepEqual(plan(tabs, 1), []);
});
test('an empty or all-visible list plans nothing', () => {
  assert.deepEqual(plan([]), []);
  assert.deepEqual(plan([tab(1, 99 * MIN, { visible: true })], 2), []);
});

test('user settings normalize to safe defaults and bounded values', () => {
  assert.deepEqual(normalizeTabOptimizationSettings({ idleMinutes: 999, maxBackgroundLive: -1, pressureMode: 'unknown' }), {
    enabled: true, idleMinutes: 3, maxBackgroundLive: 4, newTabIdleSeconds: 20,
    recentGraceSeconds: 45, pressureMode: 'balanced', excludedHosts: []
  });
  assert.deepEqual(normalizeTabOptimizationSettings({ enabled: false, excludedHosts: ['Example.com', '*.docs.example.org', 'https://site.test/path', 'bad host'] }).excludedHosts,
    ['docs.example.org', 'example.com', 'site.test']);
});
test('custom idle timeout and grace period are reflected in discard policy', () => {
  const c = discardConfigFromSettings({ idleMinutes: 10, recentGraceSeconds: 90, newTabIdleSeconds: 60 });
  assert.equal(c.idleMs, 10 * MIN);
  assert.equal(c.capMinIdleMs, 90 * 1000);
  assert.equal(c.newTabIdleMs, 60 * 1000);
});
test('Never by idle time disables normal and pressure-based idle expiry', () => {
  const c = discardConfigFromSettings({ idleMinutes: 0 });
  assert.equal(c.idleMs, Infinity);
  assert.equal(c.idleMsPressure1, Infinity);
  assert.equal(c.idleMsPressure2, Infinity);
});
test('no background-tab cap means the LRU cap is not applied', () => {
  const tabs = Array.from({ length: 8 }, (_, i) => tab(i + 1, 2 * MIN));
  assert.deepEqual(plan(tabs, 0, { maxBackgroundLive: 0, idleMs: Infinity }), []);
});
test('excluded and protected tabs are never selected for suspension', () => {
  const tabs = [tab(1, 60 * MIN, { excluded: true }), tab(2, 60 * MIN, { audible: true }), tab(3, 60 * MIN, { busy: true }), tab(4, 60 * MIN)];
  assert.deepEqual(plan(tabs), [4]);
});
test('aggressive pressure policy uses shorter thresholds and a larger release batch', () => {
  const c = discardConfigFromSettings({ pressureMode: 'aggressive' });
  assert.equal(c.idleMsPressure1, 45 * 1000);
  assert.equal(c.idleMsPressure2, 20 * 1000);
  assert.equal(c.pressureReleasePerPass, 5);
});

const GB = 1024 * 1024; // in KB
const metrics = (kbs) => () => kbs.map((kb, i) => ({ pid: 100 + i, memory: { workingSetSize: kb, privateBytes: kb } }));
test('pressure is 0 on a roomy machine with a small footprint', () => {
  const r = measurePressure({ getSystemMemoryInfo: () => ({ total: 16 * GB, free: 8 * GB }), getAppMetrics: metrics([300_000, 400_000]), isWindows: true });
  assert.equal(r.level, 0);
  assert.equal(r.byPid.get(100), 300_000);
});
test('Windows free memory under 25% / 12% raises pressure to 1 / 2', () => {
  const at = (free) => measurePressure({ getSystemMemoryInfo: () => ({ total: 8 * GB, free }), getAppMetrics: metrics([200_000]), isWindows: true }).level;
  assert.equal(at(1.4 * GB), 1);
  assert.equal(at(0.5 * GB), 2);
});
test('low "free" memory is ignored on macOS/Linux (it excludes the file cache)', () => {
  const r = measurePressure({ getSystemMemoryInfo: () => ({ total: 8 * GB, free: 0.2 * GB }), getAppMetrics: metrics([200_000]), isWindows: false });
  assert.equal(r.level, 0);
});
test("Drift's own footprint is measured against 30% of RAM (min 1.25 GB)", () => {
  const level = (total, usedKB) => measurePressure({ getSystemMemoryInfo: () => ({ total, free: total }), getAppMetrics: metrics([usedKB]), isWindows: false }).level;
  assert.equal(level(4 * GB, 1.2 * GB), 1); // 4 GB machine: budget is the 1.25 GB floor, 70% = 0.875 GB
  assert.equal(level(4 * GB, 1.6 * GB), 2);
  assert.equal(level(16 * GB, 3 * GB), 0);  // 16 GB machine: budget 4.8 GB
  assert.equal(level(16 * GB, 6 * GB), 2);
});
test('privateBytes is preferred over workingSetSize when present', () => {
  const r = measurePressure({ getSystemMemoryInfo: () => ({ total: 16 * GB, free: 8 * GB }), getAppMetrics: () => [{ pid: 7, memory: { workingSetSize: 900_000, privateBytes: 400_000 } }], isWindows: false });
  assert.equal(r.byPid.get(7), 400_000);
});
test('measurement failures degrade to "no pressure" instead of throwing', () => {
  const r = measurePressure({ getSystemMemoryInfo: () => { throw new Error('nope'); }, getAppMetrics: () => { throw new Error('nope'); }, isWindows: true });
  assert.equal(r.level, 0);
});

let failed = 0;
for (const [ok, name, error] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) { failed += 1; console.log(`     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
