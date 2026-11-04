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

const setupConfigFile = path.join(root, 'electron-builder.setup.json');
if (!fs.existsSync(setupConfigFile)) fail('electron-builder.setup.json (the all-in-one Setup build) is missing.');
else {
  const setupConfig = JSON.parse(fs.readFileSync(setupConfigFile, 'utf8'));
  if (setupConfig.appId !== 'org.drift.browser') fail('electron-builder.setup.json must use the application ID org.drift.browser.');
  if (setupConfig.productName !== 'Drift') fail('electron-builder.setup.json must keep the product name Drift.');
  if (setupConfig.extraMetadata?.main !== 'src/setup/entry.js') fail('electron-builder.setup.json must start src/setup/entry.js.');
  if (!(setupConfig.win?.target || []).includes('portable')) fail('electron-builder.setup.json must build the portable Setup.');
}
for (const relative of ['src/setup/entry.js', 'src/setup/installer.js', 'src/setup/preload.js', 'src/setup/index.html']) {
  if (!fs.existsSync(path.join(root, relative))) fail(`Setup file is missing: ${relative}`);
}
// Updates come from the monitor, never GitHub: the updater must not carry a repository configuration again.
const updateConfig = fs.readFileSync(path.join(root, 'src/main/update-config.js'), 'utf8');
if (/github/i.test(updateConfig) || !/gatewayUrl/.test(updateConfig)) fail('src/main/update-config.js must point updates at the monitor gateway (no GitHub settings).');

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
  'src/renderer/browser/ui.js',
  'src/renderer/newtab/newtab.js',
  'src/renderer/palette/palette.js',
  'scripts/build_icons.cjs',
]) {
  if (!fs.existsSync(path.join(root, relative))) fail(`Required project file is missing: ${relative}`);
}

const syntaxFiles = [
  'src/main/main.js',
  'src/main/extensions.js',
  'src/main/extension-info.js',
  'src/main/shortcuts.js',
  'src/main/updater.js',
  'src/main/monitor-gateway.js',
  'src/main/telemetry.js',
  'src/main/update-config.js',
  'src/main/storage.js',
  'src/main/memory-manager.js',
  'src/setup/entry.js',
  'src/setup/installer.js',
  'src/setup/preload.js',
  'src/preload/preload.js',
  'src/renderer/browser/ui.js',
  'src/renderer/newtab/newtab.js',
  'src/renderer/palette/palette.js',
  'scripts/build_icons.cjs',
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
  console.log(`[Drift preflight] OK — Drift ${pkg.version}, stable app ID, all-in-one Setup config and ${syntaxFiles.length} JavaScript files verified.`);
}
