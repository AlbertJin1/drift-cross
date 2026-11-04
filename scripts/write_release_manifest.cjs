'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(process.argv[2] || path.join(root, 'publish'));
const installerName = 'Drift-Setup.exe';
const installerPath = path.join(outputDir, installerName);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(installerPath)) {
  console.error(`[Drift release] Installer not found: ${installerPath}`);
  process.exit(1);
}

const fileBuffer = fs.readFileSync(installerPath);
const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
const now = new Date();
const manifest = {
  product: 'Drift Browser',
  version: pkg.version,
  platform: 'windows',
  architecture: 'x64',
  installerFormat: 'All-in-one Setup: custom installer window with the Drift app inside (current-user install, no administrator rights)',
  installer: installerName,
  fileSizeBytes: fileBuffer.length,
  sha256,
  builtAt: now.toISOString(),
  defaultInstallDirectory: '%LOCALAPPDATA%\\Programs\\Drift',
  installScope: 'current-user',
  profileDirectory: '%APPDATA%\\Drift',
  profileRetainedOnUninstall: true,
};

fs.writeFileSync(path.join(outputDir, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(outputDir, 'SHA256SUMS.txt'), `${sha256}  ${installerName}\n`, 'utf8');
fs.writeFileSync(path.join(outputDir, 'INSTALL-NOTES.txt'), [
  'DRIFT BROWSER — WINDOWS INSTALLER',
  '=================================',
  '',
  `Version: ${pkg.version}`,
  'Architecture: Windows x64',
  'Installer: Drift-Setup.exe',
  '',
  'INSTALLATION',
  'Run Drift-Setup.exe. It is one file: the Setup window and the Drift app',
  'itself, so nothing is downloaded. Drift installs for the current Windows',
  'account and does not require administrator permission. Choose the app',
  'folder and look during setup; Start menu and desktop shortcuts are optional.',
  'Installed copies update themselves from the Universal App Monitor.',
  '',
  'YOUR BROWSER PROFILE',
  'Drift stores bookmarks, history, settings and extensions separately from',
  'the application in %APPDATA%\\Drift. Uninstalling Drift does not delete',
  'this profile. Remove that folder manually only when you also want to',
  'permanently remove your personal browser data.',
  '',
  'INTEGRITY',
  `SHA-256: ${sha256}`,
  '',
].join('\r\n'), 'utf8');

console.log(`[Drift release] Manifest and SHA-256 written for ${installerName}.`);
