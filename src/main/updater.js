'use strict';

/*
 * Drift silent updater (Windows).
 *
 *   1. A few seconds after launch (and every few hours) Drift asks the Universal App Monitor's public client
 *      gateway whether a newer release exists (app id "drift").
 *   2. A newer installer is downloaded quietly in the background, checked against the SHA-256 and size the
 *      monitor announced, and parked in <profile>\Updates. Nothing is shown to the user.
 *   3. When Drift closes, a tiny hidden helper waits for the browser process to exit and then runs the
 *      installer silently over the existing installation. The next launch is the new version.
 *   4. If that did not happen (crash, shutdown, antivirus...), the staged installer is applied at the next
 *      launch, before a window opens, and Drift starts again by itself.
 *
 * The profile (bookmarks, history, settings) lives in %APPDATA%\Drift and is never touched.
 * Updating is skipped on non-Windows systems, in development, and for installs that need administrator rights
 * (a silent install cannot show a UAC prompt). Users can switch it off in Settings > General.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const VERSION_RE = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LOCK_FRESH_MS = 5 * 60 * 1000;      // an apply lock older than this is considered abandoned
const APPLY_WAIT_MS = 150 * 1000;         // how long a freshly started Drift waits for a running installer
const LOG_LIMIT_BYTES = 200 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseVersion(value) {
  const match = VERSION_RE.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// -1 / 0 / 1, or null when either side is not a plain major.minor.build version.
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

// Values are placed inside set "NAME=value" lines, where only % needs doubling. A double quote can never be part
// of a Windows path, so anything containing one (or a line break) is refused instead of escaped.
function batchValue(value) {
  const text = String(value);
  if (/["\r\n\0]/.test(text)) throw new Error('Unsafe character in a path passed to the update helper.');
  return text.replace(/%/g, '%%');
}

/*
 * The helper script. It runs detached and hidden after Drift has started quitting:
 *   - waits (up to ~90 s) for the Drift process with the given PID to disappear, so the installer never has to
 *     kill the browser that launched it;
 *   - runs the installer silently and waits for it;
 *   - on success deletes the installer and pending.json; on failure leaves pending.json for a limited number of
 *     later attempts (and, when Drift was started only to apply the update, starts the old Drift again);
 *   - always removes the lock file last, which is what a newly started Drift waits for.
 */
function buildApplyScript({ pid, installer, installDir, exe, lock, pending, log, relaunch }) {
  const flags = `/S --updated --silent-update "--update-dir=%INSTALL_DIR%"${relaunch ? ' --force-run' : ''}`;
  return [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    `set "DRIFT_PID=${batchValue(pid)}"`,
    `set "INSTALLER=${batchValue(installer)}"`,
    `set "INSTALL_DIR=${batchValue(installDir)}"`,
    `set "DRIFT_EXE=${batchValue(exe)}"`,
    `set "LOCK=${batchValue(lock)}"`,
    `set "PENDING=${batchValue(pending)}"`,
    `set "LOG=${batchValue(log)}"`,
    'set "WAITED=0"',
    '>>"%LOG%" echo [%DATE% %TIME%] helper: waiting for Drift (pid %DRIFT_PID%) to close',
    ':wait',
    'tasklist /FI "PID eq %DRIFT_PID%" /FI "IMAGENAME eq Drift.exe" /NH 2>nul | find /I "Drift.exe" >nul',
    'if errorlevel 1 goto closed',
    'set /a WAITED+=1',
    'if %WAITED% GEQ 90 goto timeout',
    'ping -n 2 127.0.0.1 >nul',
    'goto wait',
    ':closed',
    'ping -n 3 127.0.0.1 >nul',
    '>>"%LOG%" echo [%DATE% %TIME%] helper: running the installer silently',
    `start "" /wait "%INSTALLER%" ${flags}`,
    'set "RC=%ERRORLEVEL%"',
    '>>"%LOG%" echo [%DATE% %TIME%] helper: installer exit code %RC%',
    'if "%RC%"=="0" goto ok',
    'goto fail',
    ':ok',
    'del /f /q "%INSTALLER%" >nul 2>&1',
    'del /f /q "%PENDING%" >nul 2>&1',
    'goto done',
    ':timeout',
    '>>"%LOG%" echo [%DATE% %TIME%] helper: Drift did not close in time, giving up for now',
    ':fail',
    ...(relaunch ? ['start "" "%DRIFT_EXE%"'] : []),
    ':done',
    'del /f /q "%LOCK%" >nul 2>&1',
    'exit /b 0',
    ''
  ].join('\r\n');
}

function sha256FileSync(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function createUpdater(deps) {
  const app = deps.app;
  const config = deps.config || require('./update-config');
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const execPath = deps.execPath || process.execPath;
  const spawnImpl = deps.spawn || spawn;
  const fetchImpl = deps.fetch;
  const isEnabled = deps.isEnabled || (() => true);
  const now = deps.now || Date.now;
  const waitMs = deps.applyWaitMs || APPLY_WAIT_MS;
  const dir = deps.dir || path.join(app.getPath('userData'), 'Updates');
  const installDir = path.dirname(execPath);
  const P = {
    state: path.join(dir, 'state.json'),
    pending: path.join(dir, 'pending.json'),
    lock: path.join(dir, 'apply.lock'),
    cmd: path.join(dir, 'apply.cmd'),
    log: path.join(dir, 'updater.log')
  };

  let busy = false;
  let started = false;
  let timer = null;
  let appliedThisRun = false;
  let supportReason; // undefined = not evaluated yet, null = supported, string = why not

  // ---------------------------------------------------------------- small helpers
  function log(message) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(P.log).size > LOG_LIMIT_BYTES) fs.renameSync(P.log, `${P.log}.1`); } catch { /* no log yet */ }
      fs.appendFileSync(P.log, `[${new Date(now()).toISOString()}] ${message}\n`);
    } catch { /* logging must never break the browser */ }
  }
  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  function writeJson(file, value) {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, file);
  }
  function loadState() {
    const state = readJson(P.state) || {};
    if (!/^[a-f0-9]{32}$/.test(state.installId || '')) {
      state.installId = crypto.randomBytes(16).toString('hex'); // random, anonymous, kept only in the profile
      try { writeJson(P.state, state); } catch { /* retried next time */ }
    }
    return state;
  }
  function saveState(state) {
    try { writeJson(P.state, state); } catch { /* not critical */ }
  }
  function readPending() {
    const p = readJson(P.pending);
    if (!p || !parseVersion(p.version) || !SHA256_RE.test(p.sha256 || '') || !Number.isFinite(p.size)
      || typeof p.file !== 'string' || p.file !== path.basename(p.file)) return null;
    return { ...p, attempts: Number.isInteger(p.attempts) ? p.attempts : 0 };
  }
  function discardStaged(keepFile) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^Drift-Setup-.+\.exe(\.part)?$/.test(name) && name !== keepFile) fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch { /* folder not created yet */ }
    if (!keepFile) fs.rmSync(P.pending, { force: true });
  }

  // null when updating is possible, otherwise a short reason (also written to the log once).
  function supportedReason() {
    if (supportReason !== undefined) return supportReason;
    let reason = null;
    if (!deps.force) {
      if (platform !== 'win32') reason = 'updates are only delivered for Windows builds';
      else if (arch !== 'x64') reason = `no ${arch} build is published`;
      else if (!app.isPackaged) reason = 'this is a development run';
    }
    if (!reason) {
      try {
        const probe = path.join(installDir, `.drift-write-test-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.rmSync(probe, { force: true });
      } catch {
        reason = 'the install folder needs administrator rights, so updates cannot be silent';
      }
    }
    supportReason = reason;
    if (reason) log(`automatic updates are off: ${reason}`);
    return reason;
  }

  // Removes leftovers of an update that is already installed and clears an abandoned lock.
  function housekeeping() {
    const pending = readPending();
    if (pending && compareVersions(pending.version, app.getVersion()) <= 0) {
      log(`version ${pending.version} is installed`);
      discardStaged();
    }
    const lock = readJson(P.lock);
    if (fs.existsSync(P.lock) && (!lock || now() - Number(lock.startedAt || 0) > LOCK_FRESH_MS)) {
      fs.rmSync(P.lock, { force: true });
    }
  }

  // ---------------------------------------------------------------- network
  function endpoint(params) {
    const url = new URL(config.gatewayUrl);
    if (url.protocol !== 'https:' && !config.allowInsecure) throw new Error('The update gateway must use HTTPS.');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.toString();
  }
  const headers = (accept) => ({
    accept,
    'ngrok-skip-browser-warning': '1',
    'user-agent': `Drift/${app.getVersion()} (updater)`
  });

  async function fetchLatest(current, installId) {
    const url = endpoint({
      resource: 'update', action: 'latest', app_id: config.appId, app: config.appId, version: current, install_id: installId
    });
    const response = await fetchImpl(url, { headers: headers('application/json'), signal: AbortSignal.timeout(config.requestTimeoutMs) });
    if (!response.ok) throw new Error(`the update check returned HTTP ${response.status}`);
    const body = await response.json();
    if (!body || body.ok !== true) throw new Error('the update service sent an unexpected answer');
    if (body.update_available !== true) return null;
    const latest = body.latest || {};
    const version = String(latest.version || body.latest_version || '').replace(/^v/i, '');
    const sha256 = String(latest.sha256 || body.sha256 || '').toLowerCase();
    const size = Number(latest.size || body.size);
    if (!parseVersion(version)) throw new Error(`the announced version "${version}" is not valid`);
    if (!SHA256_RE.test(sha256)) throw new Error('the announced checksum is not valid');
    if (!Number.isFinite(size) || size < config.minInstallerBytes || size > config.maxInstallerBytes) throw new Error('the announced size is not plausible');
    return { version, sha256, size, notes: String(latest.notes || body.notes || '').slice(0, 2000) };
  }

  async function download(info) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `Drift-Setup-${info.version}.exe`;
    const part = path.join(dir, `${name}.part`);
    const target = path.join(dir, name);
    const controller = new AbortController();
    const hash = crypto.createHash('sha256');
    let received = 0;
    let stall = null;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(new Error('the download stalled')), config.stallTimeoutMs);
    };
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > info.size) return callback(new Error('the server sent more data than announced'));
        hash.update(chunk);
        arm();
        return callback(null, chunk);
      }
    });
    try {
      arm();
      const url = endpoint({ resource: 'update', action: 'download', app_id: config.appId, app: config.appId, version: info.version });
      const response = await fetchImpl(url, { headers: headers('application/octet-stream'), signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`the download returned HTTP ${response.status}`);
      const announced = (response.headers.get('x-content-sha256') || '').toLowerCase();
      if (announced && announced !== info.sha256) throw new Error('the download does not match the announced release');
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(part), { signal: controller.signal });
    } catch (error) {
      fs.rmSync(part, { force: true });
      throw error;
    } finally {
      clearTimeout(stall);
    }
    const digest = hash.digest('hex');
    if (received !== info.size || digest !== info.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('the downloaded installer failed its size/SHA-256 check and was discarded');
    }
    const fd = fs.openSync(part, 'r');
    const magic = Buffer.alloc(2);
    try { fs.readSync(fd, magic, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (magic.toString('latin1') !== 'MZ') {
      fs.rmSync(part, { force: true });
      throw new Error('the downloaded file is not a Windows program');
    }
    fs.rmSync(target, { force: true });
    fs.renameSync(part, target);
    return name;
  }

  // ---------------------------------------------------------------- check + stage
  async function checkAndStage() {
    if (busy) return 'busy';
    if (supportedReason()) return 'unsupported';
    if (!isEnabled()) return 'disabled';
    busy = true;
    try {
      housekeeping();
      const current = app.getVersion();
      const state = loadState();
      const info = await fetchLatest(current, state.installId);
      state.lastCheckAt = now();
      saveState(state);
      if (!info || compareVersions(info.version, current) <= 0) return 'up-to-date';
      if (state.skipVersion && compareVersions(info.version, state.skipVersion) <= 0) return 'skipped';
      const pending = readPending();
      if (pending && pending.version === info.version && pending.sha256 === info.sha256) {
        try { if (fs.statSync(path.join(dir, pending.file)).size === pending.size) return 'staged'; } catch { /* download again */ }
      }
      log(`version ${info.version} is available; downloading in the background`);
      const file = await download(info);
      writeJson(P.pending, { version: info.version, sha256: info.sha256, size: info.size, file, notes: info.notes, downloadedAt: now(), attempts: 0 });
      discardStaged(file);
      log(`version ${info.version} is downloaded and verified; it installs when Drift closes`);
      return 'staged';
    } catch (error) {
      log(`update check failed: ${error && error.message ? error.message : error}`);
      return 'error';
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- apply
  function giveUp(pending) {
    const state = loadState();
    state.skipVersion = pending.version;
    saveState(state);
    discardStaged();
    log(`version ${pending.version} could not be installed after ${pending.attempts} attempts; waiting for a newer release`);
  }

  // Starts the hidden helper that installs the staged update once this process has exited.
  // relaunch = Drift was started only to apply the update, so the installer opens the browser again afterwards.
  function applyPending({ relaunch = false } = {}) {
    if (appliedThisRun || supportedReason() || !isEnabled()) return false;
    const pending = readPending();
    if (!pending) return false;
    if (compareVersions(pending.version, app.getVersion()) <= 0) { housekeeping(); return false; }
    if (pending.attempts >= config.maxInstallAttempts) { giveUp(pending); return false; }
    const installer = path.join(dir, pending.file);
    let valid = false;
    try { valid = fs.statSync(installer).size === pending.size && sha256FileSync(installer) === pending.sha256; } catch { valid = false; }
    if (!valid) { log('the staged installer is missing or damaged; it will be downloaded again'); discardStaged(); return false; }
    try {
      writeJson(P.pending, { ...pending, attempts: pending.attempts + 1 });
      fs.writeFileSync(P.cmd, buildApplyScript({
        pid: process.pid, installer, installDir, exe: execPath, lock: P.lock, pending: P.pending, log: P.log, relaunch
      }));
      writeJson(P.lock, { startedAt: now(), version: pending.version, pid: process.pid });
      const child = spawnImpl('cmd.exe', ['/d', '/s', '/c', `""${P.cmd}""`], {
        cwd: os.tmpdir(), // never inside the install folder: a handle on it would block the file swap
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true
      });
      if (child && child.on) child.on('error', (error) => { log(`could not start the update helper: ${error.message}`); fs.rmSync(P.lock, { force: true }); });
      if (child && child.unref) child.unref();
      appliedThisRun = true;
      log(`installing ${pending.version} (attempt ${pending.attempts + 1})${relaunch ? ' at startup' : ' after Drift closed'}`);
      return true;
    } catch (error) {
      fs.rmSync(P.lock, { force: true });
      log(`could not start the update: ${error && error.message ? error.message : error}`);
      return false;
    }
  }

  // Runs first thing at launch. 'continue' = open normally, 'exit' = an update is installing (Drift reopens by
  // itself), 'restart' = an update finished while we waited, so start again to run the new files.
  async function prepareStartup() {
    try {
      const lock = readJson(P.lock);
      if (lock && now() - Number(lock.startedAt || 0) < LOCK_FRESH_MS) {
        log('an update is installing; waiting for it to finish');
        const deadline = now() + waitMs;
        while (fs.existsSync(P.lock) && now() < deadline) await sleep(500);
        if (!fs.existsSync(P.lock) && !fs.existsSync(P.pending)) { log('the update finished'); return 'restart'; }
        return 'continue';
      }
      if (fs.existsSync(P.lock)) fs.rmSync(P.lock, { force: true });
      if (supportedReason() || !isEnabled()) return 'continue';
      housekeeping();
      const pending = readPending();
      if (pending && compareVersions(pending.version, app.getVersion()) > 0 && applyPending({ relaunch: true })) return 'exit';
    } catch (error) {
      log(`startup update step failed: ${error && error.message ? error.message : error}`);
    }
    return 'continue';
  }

  // ---------------------------------------------------------------- lifecycle
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await checkAndStage();
      schedule(config.checkIntervalMs + Math.floor(Math.random() * 10 * 60 * 1000));
    }, delay);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (started) return;
    started = true;
    app.on('will-quit', () => {
      try { applyPending({ relaunch: false }); } catch (error) { log(`apply on close failed: ${error.message}`); }
    });
    schedule(config.firstCheckDelayMs);
  }

  // Called when the user flips the Settings switch.
  function settingsChanged() {
    if (!started) return;
    if (isEnabled()) schedule(5000);
    else { clearTimeout(timer); discardStaged(); }
  }

  return {
    start,
    prepareStartup,
    checkAndStage,
    applyPending,
    settingsChanged,
    supported: () => supportedReason() === null,
    // The anonymous install id is shared with usage reporting (telemetry.js): one install, one id. The monitor may
    // answer with an older canonical id for the same PC, which is adopted here so updates and sessions stay together.
    installId: () => loadState().installId,
    adoptInstallId(id) {
      const next = String(id || '').toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(next)) return false;
      const state = loadState();
      if (state.installId === next) return true;
      state.installId = next;
      saveState(state);
      return true;
    },
    paths: P
  };
}

module.exports = { createUpdater, compareVersions, buildApplyScript, parseVersion };
