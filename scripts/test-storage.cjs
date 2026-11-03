'use strict';

// Exercises src/main/storage.js (durable sync writes + debounced async writes). No Electron needed:
//   npm run test:storage

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../src/main/storage.js');

const results = [];
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-storage-'));
  const silent = { warn() {}, error() {} };
  try { await fn(createStorage({ getDir: () => dir, log: silent }), dir); results.push([true, name]); }
  catch (error) { results.push([false, name, error]); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const tmpFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

(async () => {
  await test('writeJson round-trips and keeps a .bak of the previous version', (s, dir) => {
    assert.equal(s.writeJson('a.json', { v: 1 }), true);
    assert.equal(s.writeJson('a.json', { v: 2 }), true);
    assert.deepEqual(s.readJson('a.json', null), { v: 2 });
    assert.deepEqual(read(dir, 'a.json.bak'), { v: 1 });
    assert.deepEqual(tmpFiles(dir), []);
  });

  await test('readJson falls back to .bak when the main file is corrupt, then to the default', (s, dir) => {
    s.writeJson('a.json', { v: 1 });
    s.writeJson('a.json', { v: 2 });
    fs.writeFileSync(path.join(dir, 'a.json'), '{ broken');
    assert.deepEqual(s.readJson('a.json', null), { v: 1 });
    assert.deepEqual(s.readJson('missing.json', ['d']), ['d']);
  });

  await test('a burst of writeJsonLater calls becomes one write of the newest data', async (s, dir) => {
    let calls = 0;
    for (let i = 1; i <= 50; i++) s.writeJsonLater('h.json', () => { calls += 1; return { n: i }; }, 20);
    await wait(150);
    assert.equal(calls, 1, 'producer ran once');
    assert.deepEqual(read(dir, 'h.json'), { n: 50 });
    assert.deepEqual(tmpFiles(dir), []);
  });

  await test('nothing is written before the delay elapses', async (s, dir) => {
    s.writeJsonLater('h.json', () => ({ n: 1 }), 80);
    await wait(20);
    assert.equal(fs.existsSync(path.join(dir, 'h.json')), false);
    await wait(150);
    assert.equal(fs.existsSync(path.join(dir, 'h.json')), true);
  });

  await test('the producer is read at write time, so later mutations are included', async (s, dir) => {
    let list = [1];
    s.writeJsonLater('l.json', () => list, 30);
    list = [1, 2, 3]; // reassigned, like `history = history.filter(...)`
    await wait(120);
    assert.deepEqual(read(dir, 'l.json'), [1, 2, 3]);
  });

  await test('writes to one file are serialised and the newest data wins', async (s, dir) => {
    let n = 0;
    for (let round = 0; round < 6; round++) {
      s.writeJsonLater('h.json', () => ({ n: ++n }), 1);
      await wait(8);
    }
    await wait(200);
    assert.deepEqual(read(dir, 'h.json'), { n });
    assert.deepEqual(tmpFiles(dir), []);
  });

  await test('a newer synchronous write is never overwritten by an older async write', async (s, dir) => {
    s.writeJsonLater('h.json', () => ({ who: 'async-old' }), 1);
    await wait(2); // async write is now starting/in flight
    s.writeJson('h.json', { who: 'sync-new' });
    await wait(200);
    assert.deepEqual(read(dir, 'h.json'), { who: 'sync-new' });
    assert.deepEqual(tmpFiles(dir), []);
  });

  await test('flushAll writes pending data immediately and synchronously', (s, dir) => {
    s.writeJsonLater('h.json', () => ({ n: 7 }), 60_000);
    s.writeJsonLater('s.json', () => ({ n: 8 }), 60_000);
    s.flushAll();
    assert.deepEqual(read(dir, 'h.json'), { n: 7 });
    assert.deepEqual(read(dir, 's.json'), { n: 8 });
  });

  await test('flushAll also covers a write that is still in flight', async (s, dir) => {
    s.writeJsonLater('h.json', () => ({ n: 1 }), 1);
    await wait(2);
    s.flushAll();
    assert.deepEqual(read(dir, 'h.json'), { n: 1 });
    await wait(150);
    assert.deepEqual(read(dir, 'h.json'), { n: 1 });
    assert.deepEqual(tmpFiles(dir), []);
  });

  await test('flushAll after everything has landed is a harmless no-op', async (s, dir) => {
    s.writeJsonLater('h.json', () => ({ n: 1 }), 1);
    await wait(150);
    s.flushAll();
    assert.deepEqual(read(dir, 'h.json'), { n: 1 });
  });

  await test('a failing producer does not break later writes', async (s, dir) => {
    s.writeJsonLater('h.json', () => { throw new Error('boom'); }, 1);
    await wait(50);
    s.writeJsonLater('h.json', () => ({ ok: true }), 1);
    await wait(100);
    assert.deepEqual(read(dir, 'h.json'), { ok: true });
  });

  let failed = 0;
  for (const [ok, name, error] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) { failed += 1; console.log(`     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
