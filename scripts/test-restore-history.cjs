'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRecentlyClosedStore, FILE_NAME, MAX_ENTRIES } = require('../src/main/recently-closed');
const { matchShortcut } = require('../src/main/shortcuts');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack || error}`); process.exitCode = 1; }
}

function fixture(seed = null) {
  const files = new Map();
  if (seed) files.set(FILE_NAME, seed);
  return {
    files,
    store: createRecentlyClosedStore({
      readJson: (name, fallback) => files.has(name) ? files.get(name) : fallback,
      writeJson: (name, value) => { files.set(name, structuredClone(value)); return true; },
      now: (() => { let value = 1000; return () => ++value; })(),
      random: () => 0.25
    })
  };
}

test('closed tabs persist across store instances and retain their original insertion index', () => {
  const f = fixture();
  f.store.pushTab({ url: 'https://example.com', title: 'Example' }, 3);
  const reopened = createRecentlyClosedStore({ readJson: (name, fallback) => f.files.get(name) || fallback, writeJson: (name, value) => { f.files.set(name, structuredClone(value)); } });
  const entry = reopened.pop();
  assert.equal(entry.type, 'tab');
  assert.equal(entry.tab.url, 'https://example.com');
  assert.equal(entry.index, 3);
  assert.equal(reopened.count, 0);
});

test('mixed tab and window history restores in last-closed-first chronological order', () => {
  const f = fixture();
  f.store.pushTab({ url: 'https://tab.example', title: 'Closed tab' }, 0);
  f.store.pushWindow({ active: 1, tabs: [
    { url: 'https://one.example', title: 'One' },
    { url: 'https://two.example', title: 'Two' }
  ] });
  assert.equal(f.store.pop().type, 'window');
  assert.equal(f.store.pop().type, 'tab');
});

test('closed window snapshots retain every URL and the active-tab index', () => {
  const f = fixture();
  f.store.pushWindow({ active: 2, tabs: [
    { url: 'https://one.example', title: 'One' },
    { url: 'https://two.example', title: 'Two' },
    { url: 'https://three.example', title: 'Three' }
  ] });
  const entry = f.store.pop();
  assert.equal(entry.type, 'window');
  assert.equal(entry.tabs.length, 3);
  assert.equal(entry.activeIndex, 2);
  assert.equal(entry.tabs[2].url, 'https://three.example');
});

test('blank and New Tab pages are excluded from closed-window recovery', () => {
  const f = fixture();
  const id = f.store.pushWindow({ active: 1, tabs: [
    { url: 'file:///C:/Drift/newtab.html?engine=duckduckgo', title: 'New tab' },
    { url: 'about:blank', title: 'Blank' },
    { url: 'https://restore.example', title: 'Restore me' }
  ] });
  assert.ok(id);
  const entry = f.store.pop();
  assert.equal(entry.tabs.length, 1);
  assert.equal(entry.activeIndex, 0);
  assert.equal(entry.tabs[0].url, 'https://restore.example');
});

test('a specific recently-closed entry can be restored without discarding newer entries', () => {
  const f = fixture();
  const firstId = f.store.pushTab({ url: 'https://first.example' });
  const secondId = f.store.pushTab({ url: 'https://second.example' });
  assert.equal(f.store.pop(firstId).tab.url, 'https://first.example');
  assert.equal(f.store.pop().tab.url, 'https://second.example');
  assert.equal(f.store.pop(secondId), null);
});

test('history limits entries and returns safe menu summaries', () => {
  const f = fixture();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) f.store.pushTab({ url: `https://site${i}.example`, title: `Site ${i}` });
  assert.equal(f.store.count, MAX_ENTRIES);
  assert.equal(f.store.list(0).length, 0);
  assert.equal(f.store.list(2).length, 2);
  assert.equal(f.store.list(1)[0].title, `Site ${MAX_ENTRIES + 4}`);
});

test('malformed persisted entries are ignored and untrusted text fields are bounded', () => {
  const f = fixture({ version: 1, entries: [null, { type: 'tab', tab: { url: 'https://valid.example', title: 'T'.repeat(900) } }, { type: 'window', tabs: [] }, { type: 'unknown' }] });
  assert.equal(f.store.count, 1);
  const entry = f.store.pop();
  assert.equal(entry.tab.title.length, 500);
});

test('Ctrl+Shift+T maps to the unified restore-last-closed command', () => {
  assert.deepEqual(matchShortcut({ type: 'keyDown', key: 't', code: 'KeyT', shift: true, control: true }), { name: 'reopen-tab', arg: undefined });
});

test('browser and installer shortcut identities match the stable packaged AppUserModelID', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'src/setup/installer.js'), 'utf8');
  assert.ok(main.includes(`const APP_USER_MODEL_ID = '${pkg.build.appId}'`));
  assert.ok(installer.includes(`const APP_USER_MODEL_ID = '${pkg.build.appId}'`));
  assert.ok(installer.includes('appUserModelId: APP_USER_MODEL_ID'));
  assert.ok(main.includes("app.on('second-instance'"));
  assert.ok(main.includes("if (!app.requestSingleInstanceLock())"));
});

console.log(`\n${passed}/9 restore-history tests passed.`);
