'use strict';

// Confirm an OS-level spawn event. A positive-looking PID alone is not used
// as confirmation: Node may emit the actual spawn/error on the next tick.
function spawnDetachedConfirmed(spawnImpl, command, args, options, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child && onSpawn) child.removeListener?.('spawn', onSpawn);
      if (child && onError) child.removeListener?.('error', onError);
      if (error) {
        if (child && Number.isInteger(child.pid)) { try { child.kill?.(); } catch { /* best effort */ } }
        reject(error);
      } else {
        try { child.unref?.(); } catch { /* the process may already be detached */ }
        resolve(child);
      }
    };
    const onSpawn = () => finish();
    const onError = (error) => finish(error);
    try { child = spawnImpl(command, args, options); }
    catch (error) { finish(error); return; }
    if (!child || typeof child.once !== 'function') {
      finish(new Error('Windows did not create the updated Drift process.'));
      return;
    }
    child.once('spawn', onSpawn);
    child.once('error', onError);
    timer = setTimeout(() => finish(new Error(`Drift did not confirm startup within ${timeoutMs} ms.`)), timeoutMs);
  });
}

module.exports = { spawnDetachedConfirmed };
