'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const fail = (message) => {
  console.error(`\n[Drift preflight] ERROR: ${message}`);
  process.exitCode = 1;
};

if (pkg.name !== 'drift') fail(`Unexpected package name: ${pkg.name}`);
if (pkg.build?.appId !== 'org.drift.browser') fail('The stable application ID must remain org.drift.browser.');
if (pkg.build?.productName !== 'Drift') fail('The packaged product name must remain Drift.');

const nsis = pkg.build?.nsis || {};
const requiredSettings = [
  ['oneClick', false],
  ['perMachine', false],
  ['allowElevation', false],
  ['allowToChangeInstallationDirectory', true],
  ['deleteAppDataOnUninstall', false],
];
for (const [key, expected] of requiredSettings) {
  if (nsis[key] !== expected) fail(`build.nsis.${key} must be ${expected}.`);
}

const includePath = nsis.include || 'build/installer.nsh';
const includeFile = path.resolve(root, includePath);
if (!fs.existsSync(includeFile)) fail(`Custom NSIS include is missing: ${includePath}`);
else {
  const include = fs.readFileSync(includeFile, 'utf8');
  for (const macro of ['customWelcomePage', 'customUnWelcomePage']) {
    if (!include.includes(`!macro ${macro}`)) fail(`Custom NSIS include does not define ${macro}.`);
  }
}

const bitmaps = [
  ['build/installer-header.bmp', 150, 57],
  ['build/installer-sidebar.bmp', 164, 314],
];
for (const [relative, width, height] of bitmaps) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    fail(`Installer artwork is missing: ${relative}`);
    continue;
  }
  const data = fs.readFileSync(file);
  if (data.length < 54 || data.toString('ascii', 0, 2) !== 'BM') {
    fail(`${relative} is not a valid BMP file.`);
    continue;
  }
  const actualWidth = data.readInt32LE(18);
  const actualHeight = Math.abs(data.readInt32LE(22));
  if (actualWidth !== width || actualHeight !== height) {
    fail(`${relative} must be ${width}x${height}; found ${actualWidth}x${actualHeight}.`);
  }
}

for (const relative of [
  'build/icon.ico',
  'src/main/main.js',
  'src/preload/preload.js',
  'src/main/extensions.js',
  'src/main/extension-info.js',
  'src/main/shortcuts.js',
  'src/main/updater.js',
  'src/main/telemetry.js',
  'src/main/update-config.js',
  'src/main/storage.js',
  'src/main/memory-manager.js',
  'src/main/vpn.js',
  'src/main/vpn-gate.js',
  'src/renderer/browser/ui.js',
  'src/renderer/newtab/newtab.js',
  'src/renderer/palette/palette.js',
  'scripts/build_icons.cjs',
  'scripts/build_vpn_helper.bat',
  'scripts/build_vpn_helper.ps1',
  'scripts/before-pack.cjs',
  'resources/vpn/THIRD-PARTY-NOTICES.txt',
  'scripts/test-vpn-gate.cjs',
]) {
  if (!fs.existsSync(path.join(root, relative))) fail(`Required project file is missing: ${relative}`);
}

const syntaxFiles = [
  'src/main/main.js',
  'src/main/extensions.js',
  'src/main/extension-info.js',
  'src/main/shortcuts.js',
  'src/main/updater.js',
  'src/main/telemetry.js',
  'src/main/update-config.js',
  'src/main/storage.js',
  'src/main/memory-manager.js',
  'src/main/vpn.js',
  'src/main/vpn-gate.js',
  'src/setup/installer.js',
  'src/preload/preload.js',
  'src/renderer/browser/ui.js',
  'src/renderer/newtab/newtab.js',
  'src/renderer/palette/palette.js',
  'scripts/build_icons.cjs',
  'scripts/before-pack.cjs',
  'scripts/test-vpn-gate.cjs',
];
for (const relative of syntaxFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`JavaScript syntax check failed: ${relative}\n${result.stderr || result.stdout}`);
  }
}

if (process.exitCode) {
  console.error('\n[Drift preflight] Fix the reported problems before packaging.');
} else {
  console.log(`[Drift preflight] OK — Drift ${pkg.version}, stable app ID, installer config, artwork and ${syntaxFiles.length} JavaScript files verified.`);
}
