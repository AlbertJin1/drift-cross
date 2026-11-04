'use strict';

/*
 * Drift - Windows installer build orchestrator.
 *
 * Builds ONE file, dist-setup\Drift-Setup.exe: the custom Setup window (src/setup) with the Drift app packed inside it,
 * so there is no separate download and no GitHub step. The same file is what you upload to the monitor's
 * Drift tab > Releases for installed copies to update from.
 *
 *   node scripts/build-installer.cjs [options]        (build_publish.bat / build_setup.bat call this)
 *
 * Why this exists: the old build lived in .bat files with LF-only line endings, which makes cmd.exe lose its
 * place at labels and abort mid-script, closing the window with no message. This script does the same work in
 * Node, shows every step, keeps a full log (build-logs\build-latest.log) and always ends with a clear verdict.
 *
 * Options
 *   --setup           accepted for old shortcuts; the all-in-one Setup is now the only Windows build
 *   --skip-tests      do not run the unit tests
 *   --skip-install    do not run npm ci / npm install even if dependencies look stale
 *   --dry-run         print the plan and run only the cheap checks (no downloads, no packaging)
 *   --no-publish      leave the installer in dist\ and do not create the publish\ folder
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const OPT = {
  skipTests: args.has('--skip-tests'),
  skipInstall: args.has('--skip-install'),
  dryRun: args.has('--dry-run'),
  noPublish: args.has('--no-publish')
};
const IS_WINDOWS = process.platform === 'win32';

// ------------------------------------------------------------------ logging
const LOG_DIR = path.join(ROOT, 'build-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOG_DIR, `build-${stamp}.log`);
const LATEST_LOG = path.join(LOG_DIR, 'build-latest.log');
fs.writeFileSync(LOG_FILE, `Drift build ${new Date().toISOString()}\nnode ${process.version} on ${os.platform()} ${os.release()}\n\n`);
try { for (const name of fs.readdirSync(LOG_DIR).filter((n) => /^build-\d/.test(n)).sort().slice(0, -10)) fs.rmSync(path.join(LOG_DIR, name), { force: true }); } catch { /* keep going */ }

const strip = (text) => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function out(text = '') { process.stdout.write(`${text}\n`); fs.appendFileSync(LOG_FILE, `${strip(text)}\n`); }
function banner(text) { out(''); out('='.repeat(62)); out(text); out('='.repeat(62)); }
const warnings = [];
function warn(text) { warnings.push(text); out(`WARNING: ${text}`); }

class BuildError extends Error {
  constructor(message, hint) { super(message); this.hint = hint || ''; }
}

// ------------------------------------------------------------------ running commands
const HINTS = [
  [/A required privilege is not held|Cannot create symbolic link|symlink/i,
    'Windows refused to create a symbolic link while unpacking electron-builder tools. Turn on Developer Mode (Settings > System > For developers) or run this build from a terminal started "as administrator", then run it again.'],
  [/EBUSY|EPERM|resource busy or locked|operation not permitted/i,
    'A file is locked. Close Drift, any running "npm start" window, File Explorer windows inside dist\\ or node_modules\\, and pause antivirus real-time scanning for this folder, then run the build again.'],
  [/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|getaddrinfo|network|socket hang up/i,
    'A download failed. Check the internet connection (electron, electron-builder tools are downloaded on first build), then run the build again.'],
  [/EUSAGE|package-lock\.json.*(in sync|out of sync)|npm ci.*can only install/i,
    'package.json and package-lock.json disagree. The build retries with "npm install" automatically; if it still fails, delete node_modules and package-lock.json and run again.'],
  [/ENOSPC|no space left/i, 'The disk is full. Free some space (the build needs roughly 2 GB) and run again.'],
  [/Error while loading icon|Invalid command|cannot find module|electron-builder.*error/i,
    'electron-builder reported a packaging error (see the first error line above). Run "node scripts\\check-project.cjs" to check the project files.']
];

function run(label, command, { env = {}, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    out(`> ${command}`);
    if (OPT.dryRun) { out('  (dry run: not executed)'); return resolve({ code: 0, tail: '' }); }
    const child = spawn(command, { cwd: ROOT, shell: true, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      fs.appendFileSync(LOG_FILE, strip(text));
      tail = (tail + text).slice(-12000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => reject(new BuildError(`${label}: could not start (${error.message}).`)));
    child.on('close', (code) => {
      if (code === 0 || allowFail) return resolve({ code, tail });
      const hint = (HINTS.find(([re]) => re.test(tail)) || [])[1] || '';
      reject(new BuildError(`${label} failed (exit code ${code}).`, hint));
    });
  });
}

function capture(command) {
  const result = spawnSync(command, { cwd: ROOT, shell: true, encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, text: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

const quote = (value) => `"${value}"`;
const fileSize = (file) => { try { return fs.statSync(file).size; } catch { return -1; } };
const step = (n, total, text) => { out(''); out(`[${n}/${total}] ${text}`); };

// ------------------------------------------------------------------ steps
async function preflight(pkg) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new BuildError(`Node.js 20 or newer is required (found ${process.version}).`, 'Install the current LTS from https://nodejs.org/ and open a NEW terminal.');
  const npm = capture('npm --version');
  if (!npm.ok) throw new BuildError('npm was not found on PATH.', 'Reinstall Node.js from https://nodejs.org/ (it includes npm) and open a NEW terminal.');
  out(`Node ${process.version}, npm ${npm.text.split(/\r?\n/).pop()}, Drift ${pkg.version}`);
  if (!IS_WINDOWS && !OPT.dryRun) {
    throw new BuildError('The Windows installer must be built on Windows.', 'Run build_publish.bat on a Windows PC. (macOS/Linux builds use scripts/build_publish.sh.)');
  }
  const free = (() => { try { const s = fs.statfsSync(ROOT); return s.bavail * s.bsize; } catch { return Infinity; } })();
  if (free < 2 * 1024 ** 3) throw new BuildError(`Only ${(free / 1024 ** 3).toFixed(1)} GB free on this drive; the build needs about 2 GB.`, 'Free some disk space and run again.');
}


function dependenciesLookCurrent() {
  const marker = path.join(ROOT, 'node_modules', '.package-lock.json');
  const builder = path.join(ROOT, 'node_modules', 'electron-builder', 'package.json');
  const electron = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  if (![marker, builder, electron].every((f) => fs.existsSync(f))) return false;
  const newest = Math.max(fs.statSync(path.join(ROOT, 'package.json')).mtimeMs, fs.statSync(path.join(ROOT, 'package-lock.json')).mtimeMs);
  return fs.statSync(marker).mtimeMs >= newest;
}

async function installDependencies() {
  if (OPT.skipInstall) { out('Skipped (--skip-install).'); return; }
  if (dependenciesLookCurrent()) { out('node_modules is up to date with package-lock.json; skipping the install.'); return; }
  try {
    await run('npm ci', 'npm ci --no-audit --no-fund');
  } catch (error) {
    out('');
    out(`npm ci did not work (${error.message}). Retrying with "npm install"...`);
    await run('npm install', 'npm install --no-audit --no-fund');
  }
}

function removeDir(dir) {
  if (!fs.existsSync(dir)) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }); }
  catch (error) { throw new BuildError(`Could not delete ${path.relative(ROOT, dir)} (${error.code || error.message}).`, 'Close Drift and any window using that folder, then run again.'); }
  if (fs.existsSync(dir)) throw new BuildError(`Could not fully delete ${path.relative(ROOT, dir)}.`, 'Close Drift and any window using that folder, then run again.');
}

function verifyInstaller(file, minBytes) {
  const size = fileSize(file);
  if (size < 0) throw new BuildError(`electron-builder finished but ${path.relative(ROOT, file)} does not exist.`, 'Read the electron-builder output above for the first error.');
  if (size < minBytes) throw new BuildError(`${path.relative(ROOT, file)} is only ${size} bytes; that is not a real installer.`);
  const fd = fs.openSync(file, 'r');
  const magic = Buffer.alloc(2);
  try { fs.readSync(fd, magic, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (magic.toString('latin1') !== 'MZ') throw new BuildError(`${path.relative(ROOT, file)} is not a Windows executable.`);
  return size;
}

async function publish(installer) {
  const publishDir = path.join(ROOT, 'publish');
  const stage = path.join(ROOT, 'publish-staging');
  const backup = path.join(ROOT, 'publish-previous');
  removeDir(stage);
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(installer, path.join(stage, 'Drift-Setup.exe'));
  fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(stage, 'PROJECT-README.md'));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(stage, 'LICENSE.txt'));
  await run('Release manifest', `node ${quote(path.join('scripts', 'write_release_manifest.cjs'))} ${quote(stage)}`);
  removeDir(backup);
  if (fs.existsSync(publishDir)) fs.renameSync(publishDir, backup);
  try { fs.renameSync(stage, publishDir); }
  catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, publishDir); throw new BuildError(`Could not create the publish folder (${error.message}).`); }
  removeDir(backup);
  return publishDir;
}

// ------------------------------------------------------------------ main
async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const target = 'all-in-one Setup (custom installer window + Drift app)';
  banner(`Drift Browser ${pkg.version} | Windows x64 ${target}${OPT.dryRun ? ' | DRY RUN' : ''}`);
  out(`Project: ${ROOT}`);
  out(`Log:     ${path.relative(ROOT, LATEST_LOG)}`);

  const total = 7;
  step(1, total, 'Checking this PC and the project...');
  await preflight(pkg);
  await run('Project check', `node ${quote(path.join('scripts', 'check-project.cjs'))}`);

  const env = { CSC_IDENTITY_AUTO_DISCOVERY: 'false' };

  step(2, total, 'Installing dependencies...');
  await installDependencies();

  step(3, total, 'Running the unit tests...');
  if (OPT.skipTests) out('Skipped (--skip-tests).');
  else await run('Unit tests', 'npm test');

  step(4, total, 'Compiling the stylesheet...');
  await run('Tailwind build', 'npm run css:build');

  const outDir = path.join(ROOT, 'dist-setup');
  step(5, total, `Cleaning ${path.basename(outDir)}\\ ...`);
  if (OPT.dryRun) out('(dry run) would delete the previous output folder.'); else removeDir(outDir);

  step(6, total, `Building the ${target} (this takes a few minutes)...`);
  const builderArgs = '--config electron-builder.setup.json --win portable --x64 --publish never';
  await run('electron-builder', `npx --no-install electron-builder ${builderArgs}`, { env });
  const installer = path.join(outDir, 'Drift-Setup.exe');
  let size = 0;
  if (!OPT.dryRun) size = verifyInstaller(installer, 1024 * 1024);

  step(7, total, 'Publishing the release folder...');
  let publishDir = '';
  if (OPT.noPublish) out('Skipped (--no-publish); the installer stays in dist-setup\\.');
  else if (OPT.dryRun) out('(dry run) would create publish\\ with the Setup, manifest and SHA-256.');
  else publishDir = await publish(installer);

  banner('DRIFT BUILD COMPLETED');
  out(`Version:    ${pkg.version}`);
  out(`Installer:  ${installer}${size ? ` (${(size / 1024 / 1024).toFixed(1)} MB)` : ''}`);
  if (!OPT.dryRun && size) out(`SHA-256:    ${crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex')}`);
  if (publishDir) out(`Publish:    ${publishDir}`);
  out('');
  out(`Next: open the monitor > Drift tab > Releases and upload ${path.join('publish', 'Drift-Setup.exe')} as version ${pkg.version}.`);
  out('New users run that same file; installed copies find it on their next update check and install it when Drift closes.');
  if (warnings.length) { out(''); out('Warnings:'); for (const w of warnings) out(` - ${w}`); }
}

function finish(code) {
  try { fs.copyFileSync(LOG_FILE, LATEST_LOG); } catch { /* ignore */ }
  process.exit(code);
}

process.on('uncaughtException', (error) => {
  banner('DRIFT BUILD FAILED');
  out(`Unexpected error: ${error && error.stack || error}`);
  out(`Full log: ${LATEST_LOG}`);
  finish(1);
});

main().then(() => finish(0), (error) => {
  banner('DRIFT BUILD FAILED');
  out(error instanceof BuildError ? error.message : `Unexpected error: ${error && error.stack || error}`);
  if (error && error.hint) { out(''); out(`What to do: ${error.hint}`); }
  out('');
  out('The previously published installer (publish\\) was not touched.');
  out(`Full log: ${LATEST_LOG}`);
  finish(1);
});
