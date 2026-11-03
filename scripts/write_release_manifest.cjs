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
  installerFormat: 'NSIS assisted installer (current-user install is the default)',
  installer: installerName,
  fileSizeBytes: fileBuffer.length,
  sha256,
  builtAt: now.toISOString(),
  defaultInstallDirectory: '%LOCALAPPDATA%\\Programs\\Drift',
  installScopeOptions: ['current-user (default)', 'all-users (administrator only)'],
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
  'Run Drift-Setup.exe. By default, Drift installs for the current Windows',
  'account and does not require administrator permission. An administrator',
  'may choose an all-users installation. You can choose the app folder during',
  'setup. A Start menu shortcut and a desktop shortcut are created.',
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
