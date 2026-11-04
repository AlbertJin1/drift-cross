'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { verifyUserWritableInstallDirectory } = require('../src/setup/install-path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src/renderer/browser/ui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/shared/style.css'), 'utf8');
const setup = fs.readFileSync(path.join(root, 'src/setup/installer.js'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.setup.json'), 'utf8'));
const nsis = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8');

// A drag must show both the live floating card and an in-flow insertion slot.
assert.match(ui, /bookmark-drag-preview/, 'bookmark drag preview is created');
assert.match(ui, /bookmark-drop-placeholder/, 'bookmark insertion placeholder is created');
assert.match(ui, /setPointerCapture\(event\.pointerId\)/, 'drag remains tracked after leaving its source bookmark');
assert.match(ui, /positionPreview\(drag, event\.clientX, event\.clientY\)/, 'drag preview follows the pointer');
assert.match(ui, /movePlaceholder\(drag, target\)/, 'placeholder moves with the drop target');
assert.match(ui, /window\.addEventListener\('blur', reset\)/, 'drag preview is cleaned up if the window loses focus');
assert.match(css, /\.bookmark-drag-preview\s*\{/, 'floating drag preview has dedicated styling');
assert.match(css, /\.bookmark-drop-placeholder-bar/, 'bookmark bar placeholder has dedicated styling');
assert.match(css, /\.bookmark-drop-placeholder-manager/, 'bookmark manager placeholder has dedicated styling');
assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'drag animations respect reduced motion');

// Installer must run as the current user and reject paths that would need elevation.
assert.equal(config.portable?.requestExecutionLevel, 'user', 'portable installer requests user execution level');
assert.match(setup, /verifyUserWritableInstallDirectory\(o\?\.dir \|\| defaultDir/, 'install path is revalidated before copying');
assert.match(setup, /verifyUserWritableInstallDirectory\(candidate, defaultDir\)/, 'browse path is validated before returning to the UI');
assert.match(setup, /defaultPath: path\.dirname\(cur \|\| defaultDir\)/, 'browse dialog opens at the install folder parent rather than creating Drift\\Drift');
assert.match(setup, /HKCU\\\\Software/, 'installer writes only to current-user registry branches');
assert.doesNotMatch(setup, /HKEY_LOCAL_MACHINE|HKLM\\\\|requireAdministrator|Verb\s*:\s*['"]runas/i, 'installer does not request machine-wide elevation');
assert.doesNotMatch(nsis, /all-users option|install for everyone|per-machine/i, 'installer copy does not advertise an elevated all-users install');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-user-install-test-'));
try {
  const target = path.join(temp, 'Programs', 'Drift');
  assert.equal(verifyUserWritableInstallDirectory(target, target), path.resolve(target), 'writable per-user folder is accepted');
  assert.ok(fs.existsSync(target), 'validated target directory is created');
  assert.equal(fs.readdirSync(target).length, 0, 'permission probe is removed after validation');
  assert.throws(() => verifyUserWritableInstallDirectory(path.parse(path.resolve('/')).root), /drive root/i, 'drive root is rejected');
  assert.throws(() => verifyUserWritableInstallDirectory('relative\\Drift'), /absolute install folder/i, 'relative install paths are rejected');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Bookmark bar and per-user installation tests passed (21 assertions).');
