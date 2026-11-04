'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processIsAlive, waitForProcessExit, writeHelperReadyMarker } = require('../src/setup/update-helper-runtime');

(async () => {
  let now = 0;
  let checks = 0;
  const killAfterThreeChecks = () => {
    checks += 1;
    if (checks >= 3) throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
  };
  assert.equal(await waitForProcessExit(4242, {
    currentPid: 7777, timeoutMs: 1000, now: () => now,
    sleep: async (ms) => { now += ms; }, killProcess: killAfterThreeChecks
  }), true);
  assert.equal(checks, 3);
  console.log('PASS Setup waits for the exact parent Drift PID to exit normally');

  assert.equal(processIsAlive(4242, () => { throw Object.assign(new Error('access denied'), { code: 'EPERM' }); }), true);
  assert.equal(processIsAlive(0), false);
  console.log('PASS inaccessible process handles are treated as alive; invalid PIDs are rejected');

  now = 0;
  await assert.rejects(waitForProcessExit(4242, {
    currentPid: 7777, timeoutMs: 1000, now: () => now,
    sleep: async (ms) => { now += ms; }, killProcess: () => {}
  }), /did not close within 1 seconds/);
  console.log('PASS a stuck parent process times out instead of hanging Setup forever');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-update-helper-'));
  const updates = path.join(root, 'Drift', 'Updates');
  const marker = path.join(updates, 'helper-ready.txt');
  const token = 'a'.repeat(48);
  assert.equal(writeHelperReadyMarker(marker, token, updates), true);
  assert.equal(fs.readFileSync(marker, 'ascii'), token);
  assert.throws(() => writeHelperReadyMarker(path.join(root, 'outside.txt'), token, updates), /outside the Drift Updates folder/);
  assert.throws(() => writeHelperReadyMarker(marker, 'bad-token', updates), /parameters are invalid/);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS helper readiness marker is token-validated and restricted to the Updates folder');

  const updaterSource = fs.readFileSync(path.join(__dirname, '../src/main/updater.js'), 'utf8');
  assert.match(updaterSource, /spawnImpl\(installer, setupHelperArgs/);
  assert.match(updaterSource, /--wait-pid=\$\{process\.pid\}/);
  assert.doesNotMatch(updaterSource, /spawnConfirmed\('powershell\.exe'/);
  const setupSource = fs.readFileSync(path.join(__dirname, '../src/setup/installer.js'), 'utf8');
  assert.match(setupSource, /await waitForProcessExit\(waitPidArg, \{ timeoutMs: 180000 \}\)/);
  assert.match(setupSource, /writeSetupHelperReadyMarker\(\)/);
  assert.match(setupSource, /setImmediate\(\(\) => app\.exit\(0\)\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/setup/entry.js'), 'utf8'), /process\.argv\.includes\('--silent-update'\)/);
  console.log('PASS the manual restart path launches the verified Setup EXE directly without PowerShell');

  console.log('\n5/5 update helper runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
