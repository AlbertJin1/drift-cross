'use strict';

/*
 * Drift silent updater (Windows).
 *
 *   1. A few seconds after launch (and every few hours) Drift asks the Universal App Monitor (through its public
 *      client gateway, resource=update, app id "drift") for the newest release published in the monitor's
 *      Drift tab > Releases. The monitor also records this PC (install id, PC name, LAN address) from that request.
 *   2. A newer Drift-Setup.exe (the all-in-one installer: custom Setup window + the app itself) is downloaded
 *      quietly from the monitor, checked against the size and SHA-256 the monitor announces, and parked in
 *      <profile>\Updates. Nothing is shown to the user.
 *   3. When the user restarts to update, the verified staged Setup executable starts as a hidden helper, confirms
 *      its Electron runtime is ready, waits for the current browser PID to exit, and applies itself headlessly.
 *   4. Setup health-checks the new browser, rolls back and reopens the previous version on failure, and caches
 *      the verified Setup package as the next differential-update base.
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
const { createGateway } = require('./monitor-gateway');
const { lanAddress } = require('./telemetry');
const { indexFileChunks, validateManifest, parseDeltaArchive, reconstructInstaller, extractSingleFileZip } = require('./differential-update');
const { buildApplyScript } = require('./update-helper');

const VERSION_RE = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LOCK_FRESH_MS = 5 * 60 * 1000;      // an apply lock older than this is considered abandoned
const APPLY_WAIT_MS = 150 * 1000;         // longest a freshly started (old) Drift waits for a running installer
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

// True while a process with this PID exists. EPERM means it exists but belongs to someone else.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; }
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

// Startup and user-requested installs must never hash a multi-hundred-megabyte
// installer synchronously on Electron's main thread. The synchronous variant
// remains for the last-resort will-quit hook, where the app is already closing.
function sha256FileAsync(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function createUpdater(deps) {
  const app = deps.app;
  const config = deps.config || require('./update-config');
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const execPath = deps.execPath || process.execPath;
  const spawnImpl = deps.spawn || spawn;
  const fetchImpl = deps.fetch;
  const osImpl = deps.os || os;
  const isEnabled = deps.isEnabled || (() => true);
  const now = deps.now || Date.now;
  const waitMs = deps.applyWaitMs || APPLY_WAIT_MS;
  const dir = deps.dir || path.join(app.getPath('userData'), 'Updates');
  const installDir = path.dirname(execPath);
  const P = {
    state: path.join(dir, 'state.json'),
    pending: path.join(dir, 'pending.json'),
    lock: path.join(dir, 'apply.lock'),
    script: path.join(dir, 'apply-update.ps1'),
    helperReady: path.join(dir, 'helper-ready.txt'),
    healthcheck: path.join(dir, 'launch-healthcheck.json'),
    log: path.join(dir, 'updater.log'),
    baseDir: path.join(dir, 'Base'),
    baseMeta: path.join(dir, 'Base', 'base.json')
  };

  let busy = false;
  let failures = 0;
  let started = false;
  let timer = null;
  let appliedThisRun = false;
  let applying = false;
  let housekeepingTimer = null;
  let supportReason; // undefined = not evaluated yet, null = supported, string = why not

  // What the Settings > About page shows. phase: idle | checking | downloading | ready | up-to-date | error | unsupported
  const listeners = new Set();
  let status = { phase: 'idle', version: '', progress: 0, message: '', checkedAt: 0 };
  let lastEmit = 0;
  function setStatus(patch, { throttle = false } = {}) {
    status = { ...status, ...patch };
    const t = Date.now();
    if (throttle && t - lastEmit < 400) return;
    lastEmit = t;
    for (const fn of listeners) { try { fn({ ...status }); } catch { /* a listener must never break updating */ } }
  }

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
    if (!p || !parseVersion(p.version) || !SHA256_RE.test(p.sha256 || '') || !Number.isSafeInteger(p.size) || p.size < 1
      || typeof p.file !== 'string' || p.file !== path.basename(p.file)) return null;
    return {
      ...p,
      attempts: Number.isInteger(p.attempts) ? p.attempts : 0,
      nextAttemptAt: Number.isFinite(Number(p.nextAttemptAt)) ? Number(p.nextAttemptAt) : 0,
      lastError: typeof p.lastError === 'string' ? p.lastError.slice(0, 500) : ''
    };
  }
  function discardStaged(keepFile) {
    try {
      for (const name of fs.readdirSync(dir)) {
        // The installer that just launched this Drift may still be running (and locked); it is removed next time.
        if (/^Drift-Setup-.+\.exe(\.part)?$/.test(name) && name !== keepFile) { try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* locked for now */ } }
      }
    } catch { /* folder not created yet */ }
    if (!keepFile) { try { fs.rmSync(P.pending, { force: true }); } catch { /* retried later */ } }
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
    const lock = readJson(P.lock);
    if (pending && compareVersions(pending.version, app.getVersion()) <= 0) {
      const helperStillFinalizing = !!(lock && lock.version === pending.version
        && Number.isInteger(lock.helperPid) && pidAlive(lock.helperPid) && !lockIsStale(lock));
      if (helperStillFinalizing) {
        // The freshly launched browser can start before Setup has finished its
        // package-cache copy and lock cleanup. Retry housekeeping after the
        // helper exits so the staged installer is not leaked in AppData.
        log(`version ${pending.version} is running; Setup is still finalizing package cache`);
        if (!housekeepingTimer) {
          housekeepingTimer = setTimeout(() => {
            housekeepingTimer = null;
            housekeeping();
          }, 2000);
          housekeepingTimer.unref?.();
        }
      } else {
        log(`version ${pending.version} is installed`);
        discardStaged();
      }
    }
    if (fs.existsSync(P.lock) && (!lock || lockIsStale(lock))) {
      fs.rmSync(P.lock, { force: true });
    }
  }

  // A lock only means something while the helper that wrote it is alive. A helper that was killed (logoff, antivirus,
  // Task Manager) used to leave a "fresh" lock behind that made every launch wait for minutes behind it.
  function lockIsStale(lock) {
    if (!lock) return true;
    if (Number.isInteger(lock.helperPid)) return !pidAlive(lock.helperPid) || now() - Number(lock.startedAt || 0) > 4 * LOCK_FRESH_MS;
    return now() - Number(lock.startedAt || 0) > LOCK_FRESH_MS;
  }

  // ---------------------------------------------------------------- network (Universal App Monitor)
  const gateway = deps.gateway || createGateway({ config, fetch: fetchImpl, userAgent: 'Drift', version: () => app.getVersion() });
  const clip = (value, max) => String(value == null ? '' : value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

  // Returns validated release metadata, including optional ZIP and differential artifacts.
  // Older Monitor deployments remain compatible: missing ZIP/delta metadata simply selects the full EXE path.
  async function fetchLatest(current, state) {
    const result = await gateway.request({
      params: {
        resource: 'update', action: 'latest', app_id: config.appId, version: current, platform: 'windows',
        install_id: state.installId, hostname: clip(osImpl.hostname(), 64),
        local_ip: lanAddress(() => osImpl.networkInterfaces())
      },
      timeoutMs: config.requestTimeoutMs || 25000
    });
    if (result.kind !== 'ok') throw new Error(`the update check failed: ${result.message || 'the monitor did not answer'}`);
    let answer;
    try { answer = await result.response.json(); } catch { throw new Error('the monitor sent an unreadable answer'); }
    if (!answer || answer.ok === false) throw new Error(`the monitor refused the update check${answer && answer.error ? `: ${clip(answer.error, 120)}` : ''}`);
    const latest = answer.latest && typeof answer.latest === 'object' ? answer.latest : null;
    if (!latest) return null;
    const version = String(latest.version || answer.latest_version || '').replace(/^v/i, '');
    if (!parseVersion(version)) throw new Error(`the monitor announced "${clip(version, 40)}", which is not a plain version number`);
    const size = Number(latest.size);
    if (!Number.isFinite(size) || size < config.minInstallerBytes || size > config.maxInstallerBytes) throw new Error('the announced installer has an implausible size');
    const sha256 = String(latest.sha256 || '').toLowerCase();
    if (!SHA256_RE.test(sha256)) throw new Error('the monitor announced no SHA-256 checksum for the installer');
    const cmp = compareVersions(version, current);
    if (cmp === -1 || !(answer.update_available === true || cmp === 1)) return null;

    const rawPackage = latest.package && typeof latest.package === 'object' ? latest.package : answer.package;
    let packageInfo = null;
    if (rawPackage && rawPackage.format === 'zip') {
      const packageSize = Number(rawPackage.size);
      const packageSha = String(rawPackage.sha256 || '').toLowerCase();
      const entry = String(rawPackage.entry || 'Drift-Setup.exe');
      if (Number.isSafeInteger(packageSize) && packageSize > 128 && packageSize <= config.maxPackageBytes
        && SHA256_RE.test(packageSha) && path.basename(entry) === entry && !/[\\/]/.test(entry)) {
        packageInfo = { format: 'zip', size: packageSize, sha256: packageSha, entry };
      }
    }
    const rawDelta = latest.delta && typeof latest.delta === 'object' ? latest.delta : null;
    let deltaInfo = null;
    if (rawDelta && rawDelta.format === 'psd-chunks-v1') {
      const manifestSize = Number(rawDelta.manifest_size);
      const manifestSha = String(rawDelta.manifest_sha256 || '').toLowerCase();
      if (Number.isSafeInteger(manifestSize) && manifestSize > 0 && manifestSize <= config.maxManifestBytes && SHA256_RE.test(manifestSha)) {
        deltaInfo = { format: rawDelta.format, manifestSize, manifestSha };
      }
    }
    return {
      version, tag: `v${version}`, sha256, size,
      notes: clip(latest.notes || answer.notes, 2000), package: packageInfo, delta: deltaInfo
    };
  }

  function formatTransferBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function readyTransferStatus(version, kind, downloadedBytes, fullPackageBytes) {
    const downloaded = Math.max(0, Number(downloadedBytes) || 0);
    const full = Math.max(0, Number(fullPackageBytes) || 0);
    const saved = full > 0 ? Math.max(0, Math.round((1 - downloaded / full) * 100)) : 0;
    let summary;
    if (kind === 'differential') {
      summary = `Incremental update ready. Downloaded ${formatTransferBytes(downloaded)} of changed data${full > 0 ? ` — ${saved}% less than the compressed full package` : ''}.`;
    } else if (kind === 'full-zip') {
      summary = `Compressed full update ready. Downloaded ${formatTransferBytes(downloaded)}.`;
    } else if (kind === 'full-exe') {
      summary = `Full installer ready. Downloaded ${formatTransferBytes(downloaded)}.`;
    } else {
      summary = 'Update package staged.';
    }
    return { phase: 'ready', version, progress: 1, message: '', summary, downloadKind: kind || '', downloadedBytes: downloaded, fullPackageBytes: full, checkedAt: now() };
  }

  async function downloadResponseToFile(response, destination, options = {}) {
    if (!response || !response.body) throw new Error('the monitor sent no update data');
    const maxBytes = Number(options.maxBytes || config.maxInstallerBytes);
    const expectedSize = options.expectedSize === undefined ? null : Number(options.expectedSize);
    const expectedSha = options.expectedSha ? String(options.expectedSha).toLowerCase() : '';
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    let received = 0, stall = null;
    const controller = options.controller;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller?.abort(new Error('the download stalled')), config.stallTimeoutMs || 60000);
    };
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes || (expectedSize !== null && received > expectedSize)) return callback(new Error('the server sent more update data than announced'));
        hash.update(chunk);
        arm();
        const total = expectedSize || contentLength;
        setStatus({
          phase: 'downloading', version: options.version || status.version,
          progress: total > 0 ? Math.min(1, received / total) : 0,
          message: options.message || 'Downloading update components…'
        }, { throttle: true });
        callback(null, chunk);
      }
    });
    try {
      arm();
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination), { signal: controller?.signal });
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    } finally { clearTimeout(stall); }
    const digest = hash.digest('hex');
    if ((expectedSize !== null && received !== expectedSize) || (expectedSha && digest !== expectedSha)) {
      fs.rmSync(destination, { force: true });
      throw new Error('the update download failed its size/SHA-256 verification and was discarded');
    }
    return { size: received, sha256: digest };
  }

  async function requestArtifact(params, destination, options = {}) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(new Error('the update server did not respond in time')), options.timeoutMs || config.requestTimeoutMs || 25000);
    let result;
    try {
      result = await gateway.request({
        params, method: options.method || 'GET', body: options.body || null,
        accept: options.accept || 'application/octet-stream', expectJson: false,
        signal: controller.signal, timeoutMs: options.timeoutMs || config.requestTimeoutMs || 25000
      });
    } finally { clearTimeout(requestTimeout); }
    if (result.kind !== 'ok') throw new Error(`the update download failed: ${result.message || 'the monitor did not send data'}`);
    return downloadResponseToFile(result.response, destination, { ...options, controller });
  }

  async function readBoundedResponse(response, maxBytes, expectedSize) {
    if (!response || !response.body) throw new Error('the Monitor sent an empty response body');
    const chunks = [];
    let total = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      total += chunk.length;
      if (total > maxBytes || total > expectedSize) throw new Error('the Monitor response exceeded its announced size');
      chunks.push(Buffer.from(chunk));
    }
    if (total !== expectedSize) throw new Error('the Monitor response was shorter than its announced size');
    return Buffer.concat(chunks, total);
  }

  async function fetchDifferentialManifest(info) {
    const result = await gateway.request({
      params: { resource: 'update', action: 'manifest', app_id: config.appId, version: info.version },
      accept: 'application/json', timeoutMs: config.requestTimeoutMs || 25000
    });
    if (result.kind !== 'ok') throw new Error(`the differential manifest is unavailable: ${result.message || 'the Monitor did not provide one'}`);
    const bytes = await readBoundedResponse(result.response, config.maxManifestBytes, info.delta.manifestSize);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== info.delta.manifestSha) {
      throw new Error('the differential manifest failed its size/SHA-256 verification');
    }
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('the Monitor sent an unreadable differential manifest'); }
    return validateManifest(parsed, { version: info.version, size: info.size, sha256: info.sha256, maxSize: config.maxInstallerBytes });
  }

  async function loadBaseInstaller() {
    const metadata = readJson(P.baseMeta);
    if (!metadata || metadata.version !== app.getVersion() || !parseVersion(metadata.version)
      || typeof metadata.file !== 'string' || metadata.file !== path.basename(metadata.file)
      || metadata.file !== `Drift-Setup-${metadata.version}.exe` || !SHA256_RE.test(metadata.sha256 || '')
      || !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < config.minInstallerBytes
      || Number(metadata.size) > config.maxInstallerBytes) return null;
    const file = path.join(P.baseDir, metadata.file);
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size !== Number(metadata.size)) throw new Error('cached base size mismatch');
      // The content-defined index computes the whole-file SHA-256 in the same pass as chunk indexing.
      const magic = Buffer.alloc(2);
      const fd = await fs.promises.open(file, 'r');
      try { await fd.read(magic, 0, 2, 0); } finally { await fd.close(); }
      if (magic.toString('latin1') !== 'MZ') throw new Error('cached base is not a Windows executable');
      return { file, version: metadata.version, size: stat.size, sha256: metadata.sha256 };
    } catch (error) {
      log(`cached differential base was rejected: ${error.message}`);
      try { fs.rmSync(file, { force: true }); } catch { /* retry on next run */ }
      try { fs.rmSync(P.baseMeta, { force: true }); } catch { /* retry on next run */ }
      return null;
    }
  }

  async function downloadDifferential(info) {
    if (!info.delta) return null;
    const base = await loadBaseInstaller();
    if (!base || base.version !== app.getVersion()) return null;
    const targetName = `Drift-Setup-${info.version}.exe`;
    const target = path.join(dir, targetName);
    const deltaFile = path.join(dir, `Drift-Delta-${info.version}.part`);
    const chunkDir = path.join(dir, `Drift-Chunks-${info.version}`);
    const targetPart = `${target}.part`;
    try {
      setStatus({ phase: 'checking', version: info.version, progress: 0, message: 'Comparing the installed release with the update…' });
      const manifest = await fetchDifferentialManifest(info);
      const baseIndex = await indexFileChunks(base.file, {
        chunker: manifest.chunker,
        onProgress: (progress) => setStatus({
          phase: 'checking', version: info.version, progress: Math.min(0.8, progress * 0.8),
          message: `Comparing installed update package… ${Math.round(progress * 100)}%`
        }, { throttle: true })
      });
      if (baseIndex.sha256 !== base.sha256) throw new Error('the cached base installer failed its full-file SHA-256 check');
      log(`verified and indexed cached differential base v${base.version} (${base.size} bytes)`);
      const missing = new Map();
      for (const chunk of manifest.chunks) {
        const old = baseIndex.chunks.get(chunk.sha256);
        if (!old || old.size !== chunk.size) missing.set(chunk.sha256, chunk);
      }
      const missingBytes = [...missing.values()].reduce((sum, chunk) => sum + chunk.size, 0);
      const fullPreferredSize = info.package?.size || info.size;
      if (missingBytes >= fullPreferredSize) {
        log(`differential update would transfer at least ${missingBytes} bytes; compressed full package is ${fullPreferredSize} bytes`);
        return null;
      }
      const missingHashes = [...missing.keys()];
      let downloadedChunks = new Map();
      let deltaSize = 0;
      let totalDifferentialBytes = info.delta.manifestSize;
      if (missingHashes.length) {
        setStatus({ phase: 'downloading', version: info.version, progress: 0, message: `Downloading ${missingHashes.length} changed installer components…` });
        await requestArtifact({ resource: 'update', action: 'delta', app_id: config.appId, version: info.version }, deltaFile, {
          method: 'POST', body: { version: info.version, chunks: missingHashes },
          accept: 'application/vnd.pdfstudio.delta', maxBytes: config.maxDeltaBytes, version: info.version,
          message: 'Downloading changed installer components…'
        });
        deltaSize = (await fs.promises.stat(deltaFile)).size;
        totalDifferentialBytes = deltaSize + info.delta.manifestSize;
        if (totalDifferentialBytes >= fullPreferredSize) {
          log(`differential transfer is ${totalDifferentialBytes} bytes including its manifest; the compressed full package is ${fullPreferredSize} bytes, so using the full package`);
          return null;
        }
        downloadedChunks = await parseDeltaArchive(deltaFile, missingHashes, manifest, chunkDir);
      }
      setStatus({ phase: 'downloading', version: info.version, progress: 0.98, message: 'Reassembling and verifying the update…' });
      await reconstructInstaller({
        baseFile: base.file, baseIndex, manifest, downloadedChunks, outputFile: targetPart,
        onProgress: (progress) => setStatus({ phase: 'downloading', version: info.version, progress: 0.98 + Math.min(0.02, progress * 0.02), message: 'Reassembling and verifying the update…' }, { throttle: true })
      });
      await fs.promises.rm(target, { force: true });
      await fs.promises.rename(targetPart, target);
      log(`differential update v${info.version} reconstructed: downloaded ${totalDifferentialBytes} bytes including the manifest instead of ${fullPreferredSize} bytes for the compressed full package (${Math.max(0, Math.round((1 - totalDifferentialBytes / fullPreferredSize) * 100))}% less)`);
      return { file: targetName, kind: 'differential', downloadedBytes: totalDifferentialBytes };
    } finally {
      await Promise.all([deltaFile, targetPart].map((file) => fs.promises.rm(file, { force: true }).catch(() => {})));
      await fs.promises.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function downloadFull(info) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `Drift-Setup-${info.version}.exe`;
    const target = path.join(dir, name);
    if (info.package?.format === 'zip') {
      const zipFile = path.join(dir, `Drift-Package-${info.version}.zip`);
      try {
        setStatus({ phase: 'downloading', version: info.version, progress: 0, message: 'Downloading compressed full package…' });
        await requestArtifact({ resource: 'update', action: 'download', app_id: config.appId, version: info.version, format: 'zip' }, zipFile, {
          accept: 'application/zip', expectedSize: info.package.size, expectedSha: info.package.sha256,
          maxBytes: config.maxPackageBytes, version: info.version, message: 'Downloading compressed full package…'
        });
        await extractSingleFileZip(zipFile, target, {
          entry: info.package.entry, maxBytes: config.maxInstallerBytes,
          expectedSize: info.size, expectedSha256: info.sha256
        });
        log(`downloaded compressed full package (${info.package.size} bytes) and extracted verified installer (${info.size} bytes)`);
        return { file: name, kind: 'full-zip', downloadedBytes: info.package.size };
      } catch (error) {
        log(`compressed full package failed; falling back to the raw installer: ${error.message}`);
        await fs.promises.rm(target, { force: true }).catch(() => {});
      } finally { await fs.promises.rm(zipFile, { force: true }).catch(() => {}); }
    }
    const part = `${target}.part`;
    setStatus({ phase: 'downloading', version: info.version, progress: 0, message: 'Downloading complete installer…' });
    await requestArtifact({ resource: 'update', action: 'download', app_id: config.appId, version: info.version }, part, {
      accept: 'application/octet-stream', expectedSize: info.size, expectedSha: info.sha256,
      maxBytes: config.maxInstallerBytes, version: info.version, message: 'Downloading complete installer…'
    });
    const fd = await fs.promises.open(part, 'r');
    try { const magic = Buffer.alloc(2); await fd.read(magic, 0, 2, 0); if (magic.toString('latin1') !== 'MZ') throw new Error('the downloaded file is not a Windows program'); }
    finally { await fd.close(); }
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(part, target);
    log(`downloaded complete installer (${info.size} bytes)`);
    return { file: name, kind: 'full-exe', downloadedBytes: info.size };
  }

  async function download(info) {
    fs.mkdirSync(dir, { recursive: true });
    if (info.delta) {
      try {
        const differential = await downloadDifferential(info);
        if (differential) return differential;
        log('no verified compatible differential base is available; using the compressed full package fallback');
      } catch (error) {
        log(`differential update unavailable (${error.message}); using the full package fallback`);
        setStatus({ phase: 'downloading', version: info.version, progress: 0, message: 'Preparing the verified full-package fallback…' });
      }
    }
    return downloadFull(info);
  }

  // ---------------------------------------------------------------- check + stage
  // manual = the user pressed "Check for updates": it ignores the background-updates switch and a skipped version,
  // and reports every outcome through the status instead of staying silent.
  async function checkAndStage({ manual = false } = {}) {
    if (busy) return 'busy';
    const unsupported = supportedReason();
    if (unsupported) {
      if (manual) setStatus({ phase: 'unsupported', message: unsupported.charAt(0).toUpperCase() + unsupported.slice(1) + '.' });
      return 'unsupported';
    }
    if (!manual && !isEnabled()) return 'disabled';
    busy = true;
    if (manual) setStatus({ phase: 'checking', progress: 0, message: '' });
    try {
      housekeeping();
      const current = app.getVersion();
      const state = loadState();
      const info = await fetchLatest(current, state);
      state.lastCheckAt = now();
      saveState(state);
      if (!info || compareVersions(info.version, current) <= 0) {
        setStatus({ phase: 'up-to-date', version: '', progress: 0, message: '', checkedAt: now() });
        return 'up-to-date';
      }
      if (!manual && state.skipVersion && compareVersions(info.version, state.skipVersion) <= 0) return 'skipped';
      if (manual && state.skipVersion) { delete state.skipVersion; saveState(state); }
      const pending = readPending();
      if (pending && pending.version === info.version && pending.sha256 === info.sha256) {
        try {
          if (fs.statSync(path.join(dir, pending.file)).size === pending.size) {
            const fullBytes = info.package?.size || info.size;
            setStatus(readyTransferStatus(info.version, pending.downloadKind, pending.downloadedBytes, fullBytes));
            return 'staged';
          }
        } catch { /* download again */ }
      }
      log(`version ${info.version} is available; downloading${manual ? ' (requested by the user)' : ' in the background'}`);
      setStatus({ phase: 'downloading', version: info.version, progress: 0, message: '' });
      const downloaded = await download(info);
      const file = downloaded.file;
      writeJson(P.pending, { version: info.version, sha256: info.sha256, size: info.size, file, downloadKind: downloaded.kind, downloadedBytes: downloaded.downloadedBytes, notes: info.notes, downloadedAt: now(), attempts: 0 });
      discardStaged(file);
      log(`version ${info.version} is downloaded and verified; it installs when Drift closes`);
      setStatus(readyTransferStatus(info.version, downloaded.kind, downloaded.downloadedBytes, info.package?.size || info.size));
      return 'staged';
    } catch (error) {
      log(`update check failed: ${error && error.message ? error.message : error}`);
      const text = error && error.message ? String(error.message) : 'unknown error';
      if (manual || status.phase === 'checking' || status.phase === 'downloading') setStatus({ phase: 'error', progress: 0, message: text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.') });
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

  // The verified Setup executable is itself the hidden update helper. This avoids
  // depending on PowerShell (which may be unavailable, restricted by policy, or
  // blocked by endpoint security) and keeps the helper outside the install tree.
  function setupHelperArgs(pending, { relaunch = false, readyToken = '', healthcheckToken = '' } = {}) {
    const args = [
      '--silent-update',
      `--update-dir=${installDir}`,
      `--pending-file=${P.pending}`,
      `--wait-pid=${process.pid}`,
      `--helper-ready-file=${P.helperReady}`,
      `--helper-ready-token=${readyToken}`,
      `--lock-file=${P.lock}`,
      `--log-file=${P.log}`,
      `--base-cache-dir=${P.baseDir}`,
      `--base-file=${path.join(P.baseDir, `Drift-Setup-${pending.version}.exe`)}`,
      `--base-meta=${P.baseMeta}`,
      `--base-version=${pending.version}`,
      `--base-sha256=${pending.sha256}`,
      `--base-size=${pending.size}`
    ];
    if (relaunch) {
      args.push('--force-run', `--healthcheck-file=${P.healthcheck}`, `--healthcheck-token=${healthcheckToken}`);
    }
    return args;
  }

  function decrementPendingAttempt(version) {
    const pending = readPending();
    if (pending && pending.version === version) {
      pending.attempts = Math.max(0, pending.attempts - 1);
      try { writeJson(P.pending, pending); } catch { /* preserve original retry record */ }
    }
  }

  // Shutdown fallback. There is no renderer left to await here, so process
  // creation is enough; the Setup app writes its readiness token when Electron
  // has initialized, then waits for this Drift PID to exit normally.
  function applyPending({ relaunch = false, force = false } = {}) {
    if (appliedThisRun || supportedReason() || (!force && !isEnabled())) return false;
    const pending = readPending();
    if (!pending) return false;
    if (compareVersions(pending.version, app.getVersion()) <= 0) { housekeeping(); return false; }
    if (!force && pending.nextAttemptAt > now()) {
      log(`not retrying staged update ${pending.version} before its retry window`);
      return false;
    }
    if (pending.attempts >= config.maxInstallAttempts) { giveUp(pending); return false; }
    const installer = path.join(dir, pending.file);
    let valid = false;
    try { valid = fs.statSync(installer).size === pending.size && sha256FileSync(installer) === pending.sha256; } catch { valid = false; }
    if (!valid) { log('the staged installer is missing or damaged; it will be downloaded again'); discardStaged(); return false; }
    try {
      const readyToken = crypto.randomBytes(24).toString('hex');
      const healthcheckToken = relaunch ? crypto.randomBytes(24).toString('hex') : '';
      writeJson(P.pending, { ...pending, attempts: pending.attempts + 1, nextAttemptAt: 0, lastError: '' });
      fs.rmSync(P.helperReady, { force: true });
      fs.rmSync(P.healthcheck, { force: true });
      writeJson(P.lock, { startedAt: now(), version: pending.version, pid: process.pid });
      const child = spawnImpl(installer, setupHelperArgs(pending, { relaunch, readyToken, healthcheckToken }), {
        cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true
      });
      if (!child || typeof child.once !== 'function') throw new Error('Windows did not create the verified Drift Setup helper.');
      child.once('spawn', () => {
        try { writeJson(P.lock, { startedAt: now(), version: pending.version, pid: process.pid, helperPid: child.pid }); }
        catch (error) { log(`could not record Setup helper PID: ${error.message}`); }
      });
      child.once('error', (error) => {
        log(`the verified Setup helper failed to start: ${error.message}`);
        fs.rmSync(P.lock, { force: true });
        decrementPendingAttempt(pending.version);
      });
      child.once('exit', (code, signal) => {
        if (code !== 0) log(`Setup helper exited unexpectedly (code ${code}, signal ${signal || 'none'})`);
      });
      child.unref?.();
      appliedThisRun = true;
      log(`verified Setup helper spawned for ${pending.version} (attempt ${pending.attempts + 1})${relaunch ? ' with relaunch' : ''}`);
      return true;
    } catch (error) {
      fs.rmSync(P.lock, { force: true });
      decrementPendingAttempt(pending.version);
      log(`could not start the verified Setup helper: ${error && error.message ? error.message : error}`);
      return false;
    }
  }

  // Confirms that Windows created the staged Setup process. A PID alone is not
  // accepted: CreateProcess may still report an asynchronous ENOENT/ACCESS_DENIED.
  function spawnConfirmed(command, args, options, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timeout = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (child && onSpawn) child.removeListener?.('spawn', onSpawn);
        if (child && onError) child.removeListener?.('error', onError);
        if (!result.ok && child && Number.isInteger(child.pid)) { try { child.kill?.(); } catch { /* best effort */ } }
        resolve(result);
      };
      const onSpawn = () => {
        if (settled) return;
        try { if (Number.isInteger(child.pid)) writeJson(P.lock, { startedAt: now(), version: readPending()?.version || '', pid: process.pid, helperPid: child.pid }); }
        catch (error) { log(`could not record Setup helper PID: ${error.message}`); }
        try { child.unref?.(); } catch { /* already detached */ }
        finish({ ok: true, pid: child.pid, child });
      };
      const onError = (error) => finish({ ok: false, error });
      try { child = spawnImpl(command, args, options); }
      catch (error) { finish({ ok: false, error }); return; }
      if (!child || typeof child.once !== 'function') {
        finish({ ok: false, error: new Error('The verified Setup helper could not be created.') });
        return;
      }
      child.once('spawn', onSpawn);
      child.once('error', onError);
      timeout = setTimeout(() => finish({ ok: false, error: new Error(`Windows did not confirm Setup startup within ${timeoutMs} ms.`) }), timeoutMs);
    });
  }

  async function waitForHelperReady(token, child, timeoutMs = 90000) {
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      try {
        if (fs.readFileSync(P.helperReady, 'utf8').trim() === token) return { ok: true };
      } catch { /* Setup has not reached its silent-update entry point yet */ }
      // The portable EXE is a bootstrapper. Depending on the Windows portable
      // runtime it may hand off to the extracted Electron process and exit before
      // that process reaches app.whenReady(). The token from Setup is authoritative;
      // never mistake the wrapper's exit for a failed helper startup.
      await sleep(150);
    }
    return { ok: false, error: new Error(`Drift Setup was launched but did not initialize within ${timeoutMs / 1000} seconds. Check Windows Security or the updater log.`) };
  }

  async function launchApplyHelperConfirmed(installer, pending, { relaunch = false, readyToken, healthcheckToken } = {}) {
    const args = setupHelperArgs(pending, { relaunch, readyToken, healthcheckToken });
    const options = { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true };
    const result = await spawnConfirmed(installer, args, options, 20000);
    if (!result.ok) {
      const message = `Windows could not launch the verified Setup package (${result.error?.message || 'unknown Windows process error'}).`;
      log(message);
      fs.rmSync(P.lock, { force: true });
      decrementPendingAttempt(pending.version);
      appliedThisRun = false;
      return { ok: false, message };
    }
    const ready = await waitForHelperReady(readyToken, result.child);
    if (!ready.ok) {
      try { result.child?.kill?.(); } catch { /* Setup did not own the update safely */ }
      const message = ready.error?.message || 'Drift Setup did not confirm initialization.';
      log(`Setup helper readiness check failed: ${message}`);
      fs.rmSync(P.lock, { force: true });
      decrementPendingAttempt(pending.version);
      appliedThisRun = false;
      return { ok: false, message };
    }
    log(`verified Setup process confirmed ready (pid ${result.pid || 'unknown'})`);
    return { ok: true, pid: result.pid };
  }

  async function applyPendingAsync({ relaunch = false, force = false } = {}) {
    if (applying || appliedThisRun || supportedReason() || (!force && !isEnabled())) return false;
    const pending = readPending();
    if (!pending) return false;
    if (compareVersions(pending.version, app.getVersion()) <= 0) { housekeeping(); return false; }
    if (!force && pending.nextAttemptAt > now()) {
      const minutes = Math.max(1, Math.ceil((pending.nextAttemptAt - now()) / 60000));
      setStatus({ phase: 'ready', version: pending.version, progress: 1,
        message: `The previous update attempt failed. Drift will retry in about ${minutes} minute(s). Use Restart to update to retry now.` });
      return false;
    }
    if (pending.attempts >= config.maxInstallAttempts) { giveUp(pending); return false; }
    applying = true;
    try {
      const installer = path.join(dir, pending.file);
      let valid = false;
      try {
        const stat = await fs.promises.stat(installer);
        valid = stat.size === pending.size && await sha256FileAsync(installer) === pending.sha256;
      } catch { valid = false; }
      if (!valid) {
        log('the staged installer is missing or damaged; it will be downloaded again');
        discardStaged();
        setStatus({ phase: 'error', progress: 0, message: 'The downloaded installer is missing or damaged. Check for updates to download it again.' });
        return false;
      }
      const readyToken = crypto.randomBytes(24).toString('hex');
      const healthcheckToken = relaunch ? crypto.randomBytes(24).toString('hex') : '';
      writeJson(P.pending, { ...pending, attempts: pending.attempts + 1, nextAttemptAt: 0, lastError: '' });
      fs.rmSync(P.helperReady, { force: true });
      fs.rmSync(P.healthcheck, { force: true });
      writeJson(P.lock, { startedAt: now(), version: pending.version, pid: process.pid });
      setStatus({ phase: 'installing', version: pending.version, progress: 0, message: 'Starting the verified Drift Setup package…' });
      const started = await launchApplyHelperConfirmed(installer, pending, { relaunch, readyToken, healthcheckToken });
      if (!started.ok) {
        const message = `${started.message} Drift is still open and the downloaded update has been kept. You can safely retry.`;
        setStatus({ phase: 'ready', version: pending.version, progress: 1, message });
        return false;
      }
      appliedThisRun = true;
      log(`installing ${pending.version} (attempt ${pending.attempts + 1})${relaunch ? ' with launch health-check and automatic relaunch' : ''}`);
      setStatus({ phase: 'installing', version: pending.version, progress: 1, message: 'Setup is ready. Drift will close, update safely, verify the new browser opens, and then reopen.' });
      return true;
    } catch (error) {
      fs.rmSync(P.lock, { force: true });
      log(`could not prepare the update helper: ${error?.message || error}`);
      setStatus({ phase: 'ready', version: pending.version, progress: 1, message: `The update could not be started: ${error?.message || 'unexpected error'}. Drift is still running.` });
      return false;
    } finally {
      applying = false;
    }
  }

  // Runs first thing at launch. 'continue' = open normally, 'exit' = an update is installing (Drift reopens by
  // itself), 'restart' = an update finished while we waited, so start again to run the new files.
  // onWait() is called once if this launch has to wait for a running installer, so the caller can show something
  // instead of leaving an invisible process behind.
  async function prepareStartup({ onWait } = {}) {
    try {
      if (fs.existsSync(P.lock)) {
        const lock = readJson(P.lock);
        const current = app.getVersion();
        if (lockIsStale(lock)) {
          log('removed an abandoned update lock');
          fs.rmSync(P.lock, { force: true });
        } else if (lock && parseVersion(lock.version) && compareVersions(lock.version, current) <= 0) {
          // This process IS the updated version (the installer started it, and its own cleanup is still running).
          // Nothing to wait for: the files are already in place. Waiting here is what made the first launch after an
          // update take minutes with no window.
          log(`running ${current}; the installer for ${lock.version} is only cleaning up, not waiting for it`);
        } else {
          log('an update is installing; waiting for it to finish');
          if (typeof onWait === 'function') { try { onWait(); } catch { /* cosmetic */ } }
          const deadline = now() + waitMs;
          while (fs.existsSync(P.lock) && now() < deadline) {
            if (lockIsStale(readJson(P.lock))) { fs.rmSync(P.lock, { force: true }); break; }
            await sleep(250);
          }
          if (!fs.existsSync(P.lock) && !fs.existsSync(P.pending)) { log('the update finished'); return 'restart'; }
          log('the update did not finish in time or failed; opening the current version');
          return 'continue';
        }
      }
      if (supportedReason() || !isEnabled()) return 'continue';
      housekeeping();
      const pending = readPending();
      if (pending && compareVersions(pending.version, app.getVersion()) > 0 && await applyPendingAsync({ relaunch: true })) return 'exit';
    } catch (error) {
      log(`startup update step failed: ${error && error.message ? error.message : error}`);
    }
    return 'continue';
  }

  // ---------------------------------------------------------------- lifecycle
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const outcome = await checkAndStage();
      // A failed check (offline, tunnel down) is retried soon instead of waiting the whole interval.
      if (outcome === 'error') failures += 1; else failures = 0;
      const retry = Math.min((config.retryBaseMs || 2 * 60 * 1000) * 2 ** Math.max(0, failures - 1), config.checkIntervalMs);
      schedule(outcome === 'error' ? retry : config.checkIntervalMs + Math.floor(Math.random() * 10 * 60 * 1000));
    }, delay);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (started) return;
    started = true;
    const staged = readPending();
    if (staged && compareVersions(staged.version, app.getVersion()) > 0) setStatus({ phase: 'ready', version: staged.version, progress: 1, message: staged.lastError ? `The previous installation attempt failed: ${staged.lastError}` : '' });
    app.on('will-quit', () => {
      try { applyPending({ relaunch: false }); } catch (error) { log(`apply on close failed: ${error.message}`); }
    });
    schedule(config.firstCheckDelayMs);
    // Like Chrome: look again after the PC wakes from sleep or the network returns, not only on the timer.
    try {
      const { powerMonitor } = require('electron');
      if (powerMonitor && powerMonitor.on) powerMonitor.on('resume', () => { if (isEnabled()) schedule(15 * 1000); });
    } catch { /* not running inside Electron (tests) */ }
  }

  // "Restart to update": starts the helper (which waits for this process to exit, installs, and opens Drift again).
  // The caller then quits the app. Returns false when nothing could be started.
  async function installNow() {
    const pending = readPending();
    if (!pending || compareVersions(pending.version, app.getVersion()) <= 0) return false;
    return applyPendingAsync({ relaunch: true, force: true });
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
    checkNow: () => checkAndStage({ manual: true }),
    installNow,
    getStatus: () => ({ ...status }),
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
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

module.exports = { createUpdater, compareVersions, buildApplyScript, parseVersion, pidAlive };
