'use strict';
// Windows default-browser registration: everything under HKCU, fully reversible. No Electron needed:
//   npm run test:registration
const assert = require('node:assert/strict');
const { browserRegistrationCommands, browserUnregistrationCommands, FILE_TYPES, URL_SCHEMES } = require('../src/setup/registration');

const exe = 'C:\\Users\\Jo\\AppData\\Local\\Programs\\Drift\\Drift.exe';
const add = browserRegistrationCommands(exe);
assert.ok(add.length > 10, 'registration writes the client, capabilities and ProgIDs');
for (const args of add) {
  assert.equal(args[0], 'add');
  assert.match(args[1], /^HKCU\\Software\\/, 'every key is per-user');
  assert.equal(args[args.length - 1], '/f');
}
const values = add.map((args) => args.join(' '));
assert.ok(values.some((v) => v.includes('RegisteredApplications') && v.includes('Capabilities')), 'Drift is listed in RegisteredApplications');
for (const ext of FILE_TYPES) assert.ok(values.some((v) => v.includes('FileAssociations') && v.includes(` ${ext} `)), `${ext} is offered`);
for (const scheme of URL_SCHEMES) assert.ok(values.some((v) => v.includes('URLAssociations') && v.includes(` ${scheme} `)), `${scheme} is offered`);
assert.ok(values.some((v) => v.includes('DriftURL\\shell\\open\\command') && v.includes(`"${exe}" "%1"`)), 'links open through Drift.exe with the URL argument');
assert.throws(() => browserRegistrationCommands('C:\\evil" & calc.exe'), /valid Drift.exe/, 'quotes in the path are rejected');
assert.throws(() => browserRegistrationCommands('not-an-exe'), /valid Drift.exe/);

const remove = browserUnregistrationCommands();
for (const args of remove) { assert.equal(args[0], 'delete'); assert.match(args[1], /^HKCU\\Software\\/); }
const removedKeys = new Set(remove.map((args) => args[1]));
for (const args of add) {
  const key = args[1];
  const covered = [...removedKeys].some((root) => key === root || key.startsWith(`${root}\\`)) || key === 'HKCU\\Software\\RegisteredApplications';
  assert.ok(covered, `uninstall removes ${key}`);
}
console.log('Browser registration tests passed.');
