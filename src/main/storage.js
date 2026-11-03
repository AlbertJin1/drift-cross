'use strict';
// Profile storage for Drift.
//
//  - readJson / writeJson keep the original durable, synchronous behaviour (temp file, fsync,
//    .bak copy, atomic swap). They are used for anything the user changes explicitly
//    (settings, bookmarks) and for the final flush on quit.
//  - writeJsonLater is for high-frequency data (history, session, download progress). Calls
//    are coalesced, serialised per file and written off the main thread, so a burst of title
//    changes or navigations costs one write instead of one fsync each.
//
// A synchronous write bumps the file's generation, which makes any older async write for the
// same file discard itself instead of landing on top of newer data.
const fs = require('fs');
const path = require('path');

function createStorage({ getDir, log = console }) {
  const file = (f) => path.join(getDir(), f);
  const generation = new Map(); // file name -> counter bumped by every synchronous write
  const producers = new Map();  // file name -> () => data, the latest producer scheduled for it
  const pending = new Map();    // file name -> timer waiting to start an async write
  const inFlight = new Map();   // file name -> promise of the async write currently running
  let tempSeq = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Reads a profile file. If the main file is missing or corrupt (power loss, crash,
  // antivirus interference) the last good copy (<file>.bak) is used before giving up.
  const readJson = (f, fallback) => {
    for (const candidate of [file(f), `${file(f)}.bak`]) {
      try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch { /* try the next copy */ }
    }
    return fallback;
  };

  // Durable synchronous save. Returns true when the data reached disk.
  const writeJson = (f, v) => {
    generation.set(f, (generation.get(f) || 0) + 1);
    const target = file(f);
    const temp = `${target}.${process.pid}.${++tempSeq}.tmp`;
    const data = JSON.stringify(v, null, 2);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(temp, 'w');
      try { fs.writeSync(fd, data); try { fs.fsyncSync(fd); } catch { /* not supported everywhere */ } } finally { fs.closeSync(fd); }
      try { if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`); } catch { /* backup is best effort */ }
      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { fs.renameSync(temp, target); return true; }
        catch (error) {
          lastError = error;
          const wait = Date.now() + 15 * (attempt + 1);
          while (Date.now() < wait) { /* brief synchronous back-off */ }
        }
      }
      fs.writeFileSync(target, data); // last resort: direct write
      try { fs.unlinkSync(temp); } catch { /* ignore */ }
      if (lastError) log.warn(`Drift saved ${f} with a direct write after rename failed:`, lastError.message);
      return true;
    } catch (error) {
      log.error(`Drift could not save profile file ${f}:`, error?.message || error);
      try { fs.unlinkSync(temp); } catch { /* ignore */ }
      return false;
    }
  };

  // Non-blocking equivalent of writeJson. Compact JSON: these files are never edited by hand.
  async function writeJsonAsync(f, v) {
    const startedAt = generation.get(f) || 0;
    const stale = () => (generation.get(f) || 0) !== startedAt;
    const target = file(f);
    const temp = `${target}.${process.pid}.${++tempSeq}.tmp`;
    const drop = () => fs.promises.unlink(temp).catch(() => {});
    let handle = null;
    try {
      const data = JSON.stringify(v);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      handle = await fs.promises.open(temp, 'w');
      await handle.writeFile(data);
      try { await handle.sync(); } catch { /* not supported everywhere */ }
      await handle.close();
      handle = null;
      await fs.promises.copyFile(target, `${target}.bak`).catch(() => { /* first write, or best effort */ });
      for (let attempt = 0; attempt < 5; attempt++) {
        if (stale()) { await drop(); return true; } // a newer synchronous write already landed
        try { fs.renameSync(temp, target); return true; } // no await between the check and the swap
        catch { await sleep(15 * (attempt + 1)); }
      }
      if (stale()) { await drop(); return true; }
      await fs.promises.writeFile(target, data); // last resort: direct write
      await drop();
      return true;
    } catch (error) {
      log.error(`Drift could not save profile file ${f}:`, error?.message || error);
      if (handle) await handle.close().catch(() => {});
      await drop();
      return false;
    }
  }

  function startAsyncWrite(f) {
    pending.delete(f);
    const produce = producers.get(f);
    if (!produce) return;
    const previous = inFlight.get(f) || Promise.resolve();
    const job = previous
      .then(() => writeJsonAsync(f, produce()))
      .catch(() => {})
      .finally(() => { if (inFlight.get(f) === job) inFlight.delete(f); });
    inFlight.set(f, job);
  }

  // Schedules `produce()` to be written to `f` after `delay` ms. Calls made while a write is
  // already scheduled just replace the producer, so the newest data is what reaches disk.
  function writeJsonLater(f, produce, delay = 1500) {
    producers.set(f, produce);
    if (pending.has(f)) return;
    const timer = setTimeout(() => startAsyncWrite(f), delay);
    timer.unref?.();
    pending.set(f, timer);
  }

  // Synchronously writes everything that is scheduled or still running. Call before quitting.
  function flushAll() {
    const names = new Set([...pending.keys(), ...inFlight.keys()]);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const f of names) {
      const produce = producers.get(f);
      if (produce) writeJson(f, produce());
    }
  }

  return { file, readJson, writeJson, writeJsonLater, flushAll };
}

module.exports = { createStorage };
