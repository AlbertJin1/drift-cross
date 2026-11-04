'use strict';

const fs = require('fs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForUpdateHealthcheck(file, expectedVersion, token, options = {}) {
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const pause = options.sleep || sleep;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 45000);
  const pollMs = Math.max(50, Number(options.pollMs) || 200);
  const isProcessAlive = typeof options.isProcessAlive === 'function' ? options.isProcessAlive : () => true;
  const deadline = now() + timeoutMs;

  while (now() <= deadline) {
    if (!isProcessAlive()) throw new Error('Drift exited before confirming that its browser window opened.');
    try {
      const raw = await fsImpl.promises.readFile(file, 'utf8');
      const result = JSON.parse(raw);
      if (result && result.ok === true && result.version === expectedVersion && result.token === token
        && Number.isSafeInteger(Number(result.pid)) && Number(result.pid) > 0) {
        return result;
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        // A file that is being atomically replaced may briefly be unreadable;
        // keep polling until the timeout and report a single useful failure.
      }
    }
    await pause(pollMs);
  }
  throw new Error(`Drift did not confirm that version ${expectedVersion} opened within ${Math.round(timeoutMs / 1000)} seconds.`);
}

module.exports = { waitForUpdateHealthcheck };
