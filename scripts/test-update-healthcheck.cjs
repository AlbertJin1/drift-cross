'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildUpdateHealthcheckPayload, writeUpdateHealthcheck } = require('../src/main/update-healthcheck');
const { waitForUpdateHealthcheck } = require('../src/setup/update-healthcheck');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-update-health-'));
  const updates = path.join(root, 'Updates');
  const file = path.join(updates, 'launch-healthcheck.json');
  const token = 'a'.repeat(48);

  const valid = buildUpdateHealthcheckPayload({
    file, token, expectedVersion: '1.3.15', actualVersion: '1.3.15', allowedDirectory: updates, pid: 1234, now: 456
  });
  assert.deepEqual(valid, { ok: true, version: '1.3.15', token, pid: 1234, readyAt: 456 });
  console.log('PASS browser health-check accepts only the expected version and token');

  assert.equal(buildUpdateHealthcheckPayload({ file, token, expectedVersion: '1.3.15', actualVersion: '1.3.14', allowedDirectory: updates, pid: 1234 }), null);
  assert.equal(buildUpdateHealthcheckPayload({ file: path.join(root, 'outside.json'), token, expectedVersion: '1.3.15', actualVersion: '1.3.15', allowedDirectory: updates, pid: 1234 }), null);
  assert.equal(buildUpdateHealthcheckPayload({ file, token: 'bad-token', expectedVersion: '1.3.15', actualVersion: '1.3.15', allowedDirectory: updates, pid: 1234 }), null);
  console.log('PASS mismatched versions, unsafe paths and malformed tokens are rejected');

  assert.equal(writeUpdateHealthcheck({ file, token, expectedVersion: '1.3.15', actualVersion: '1.3.15', allowedDirectory: updates, pid: process.pid }), true);
  const result = await waitForUpdateHealthcheck(file, '1.3.15', token, { timeoutMs: 1000, pollMs: 50, isProcessAlive: () => true });
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.3.15');
  assert.equal(result.token, token);
  console.log('PASS Setup recognizes the visible, expected-version browser launch');

  await assert.rejects(
    waitForUpdateHealthcheck(file, '1.3.15', 'b'.repeat(48), {
      timeoutMs: 1000, pollMs: 50, isProcessAlive: () => true,
      now: (() => { let value = 0; return () => (value += 100); })(),
      sleep: async () => {}
    }),
    /did not confirm/
  );
  console.log('PASS stale or foreign health-check tokens cannot commit an update');

  await assert.rejects(
    waitForUpdateHealthcheck(file, '1.3.15', token, { isProcessAlive: () => false, timeoutMs: 1000 }),
    /exited before confirming/
  );
  console.log('PASS Setup detects a browser process that exits before opening');

  // Integration guard: the production main process must acknowledge only after
  // its real browser chrome has loaded and its main window has been revealed.
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const reveal = mainSource.indexOf('revealBrowserWindow();', mainSource.indexOf('async function start()'));
  const acknowledge = mainSource.indexOf('acknowledgeUpdateHealthcheck();', reveal);
  assert.ok(reveal >= 0 && acknowledge > reveal, 'main process must write the health-check after the browser window is shown');
  assert.match(mainSource, /actualVersion:\s*app\.getVersion\(\)/);
  const setupSource = fs.readFileSync(path.join(__dirname, '../src/setup/installer.js'), 'utf8');
  assert.match(setupSource, /waitForUpdateHealthcheck\(healthcheckFile, app\.getVersion\(\), healthcheckToken/);
  assert.match(setupSource, /fs\.rmSync\(old, \{ recursive: true, force: true \}\)/);
  assert.match(setupSource, /restoring previous version/);
  assert.match(setupSource, /await waitForProcessExit\(waitPidArg, \{ timeoutMs: 180000 \}\)/);
  assert.match(setupSource, /cacheVerifiedSetup\(log, app\.getVersion\(\)\)/);
  assert.match(setupSource, /if \(lockFileArg\) \{ try \{ fs\.rmSync\(lockFileArg/);
  console.log('PASS Setup commits only after the health-check, caches the base package and owns its apply lock');
  console.log('PASS browser startup is wired to acknowledge the health-check after showing the window');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n5/5 update health-check tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
