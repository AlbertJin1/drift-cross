'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnDetachedConfirmed } = require('../src/setup/update-launch');

(async () => {
  let unreferenced = false;
  const launched = new EventEmitter();
  launched.unref = () => { unreferenced = true; };
  const ok = spawnDetachedConfirmed(() => {
    setImmediate(() => launched.emit('spawn'));
    return launched;
  }, 'Drift.exe', [], { detached: true }, 250);
  assert.equal(await ok, launched);
  assert.equal(unreferenced, true);
  console.log('PASS updated Drift is confirmed started before installer reports success');

  await assert.rejects(
    spawnDetachedConfirmed(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
      return child;
    }, 'missing.exe', [], {}, 250),
    /not found/
  );
  console.log('PASS a failed relaunch is surfaced so the installer can roll back');

  await assert.rejects(
    spawnDetachedConfirmed(() => {
      const child = new EventEmitter();
      child.pid = 4242; // A PID is available, but Node subsequently reports a failed spawn.
      setImmediate(() => child.emit('error', Object.assign(new Error('late launch failure'), { code: 'ENOENT' })));
      return child;
    }, 'missing-with-pid.exe', [], {}, 250),
    /late launch failure/
  );
  console.log('PASS a PID alone is never accepted when the operating system reports a spawn error');

  await assert.rejects(
    spawnDetachedConfirmed(() => new EventEmitter(), 'hung.exe', [], {}, 15),
    /did not confirm startup/
  );
  console.log('PASS a process that never confirms startup times out');

  await assert.rejects(
    spawnDetachedConfirmed(() => { throw new Error('spawn refused'); }, 'Drift.exe', [], {}, 15),
    /spawn refused/
  );
  console.log('PASS synchronous spawn failures are reported');
  console.log('\n5/5 installer launch tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
