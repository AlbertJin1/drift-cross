'use strict';

// Exercises src/main/updater.js against a fake monitor gateway. No Electron and no Windows needed:
//   npm run test:updater
// The helper script that Windows runs is only checked as text here; its first real run is the end-to-end test.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, compareVersions, buildApplyScript } = require('../src/main/updater.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); } catch (error) { results.push([false, name, error]); }
}

const payload = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(300 * 1024)]);
const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

function startGateway(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const q = Object.fromEntries(url.searchParams);
    state.requests.push(q);
    if (q.action === 'latest') {
      res.setHeader('content-type', 'application/json');
      const current = q.version;
      const available = state.latestVersion !== current;
      res.end(JSON.stringify({
        ok: true, app_id: 'drift', status: available ? 'update_available' : 'up_to_date', update_available: available,
        latest: { version: state.latestVersion, sha256: state.announcedSha, size: payload.length, notes: 'Notes' }
      }));
    } else if (q.action === 'download') {
      state.downloads += 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length, 'x-content-sha256': sha256 });
      res.end(state.corruptDownload ? Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(payload.length - 2)]) : payload);
    } else {
      res.statusCode = 400; res.end('{}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function fixture(server, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-updater-'));
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir);
  const spawned = [];
  const fakeApp = {
    isPackaged: true,
    version: options.version || '1.3.1',
    getVersion() { return this.version; },
    getPath: () => path.join(root, 'profile'),
    handlers: {},
    on(event, fn) { this.handlers[event] = fn; }
  };
  const flags = { enabled: true };
  const updater = createUpdater({
    app: fakeApp,
    force: true,
    execPath: path.join(installDir, 'Drift.exe'),
    fetch: (url, init) => fetch(url, init),
    spawn: (...args) => { spawned.push(args); return { on() {}, unref() {} }; },
    isEnabled: () => flags.enabled,
    applyWaitMs: 3000,
    config: {
      appId: 'drift', gatewayUrl: `http://127.0.0.1:${server.address().port}/api/client-gateway.php`, allowInsecure: true,
      firstCheckDelayMs: 1e9, checkIntervalMs: 1e9, stallTimeoutMs: 5000, requestTimeoutMs: 5000,
      maxInstallAttempts: 3, minInstallerBytes: 1024, maxInstallerBytes: 1e9
    }
  });
  return { root, installDir, fakeApp, flags, updater, spawned };
}

(async () => {
  const state = { requests: [], downloads: 0, latestVersion: '1.4.0', announcedSha: sha256, corruptDownload: false };
  const server = await startGateway(state);
  const reset = () => { state.requests.length = 0; state.downloads = 0; state.latestVersion = '1.4.0'; state.announcedSha = sha256; state.corruptDownload = false; };

  await test('version comparison', () => {
    assert.equal(compareVersions('1.3.1', '1.4.0'), -1);
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
    assert.equal(compareVersions('1.3.1-beta', '1.3.1'), null);
  });

  await test('helper script: waits for the PID, runs the installer silently, escapes percent signs, refuses quotes', () => {
    const script = buildApplyScript({ pid: 4242, installer: 'C:\\Users\\A 100%\\Updates\\Drift-Setup-1.4.0.exe', installDir: 'C:\\Drift', exe: 'C:\\Drift\\Drift.exe', lock: 'L', pending: 'P', log: 'G', relaunch: false });
    assert.match(script, /set "DRIFT_PID=4242"/);
    assert.match(script, /A 100%%\\Updates/);
    assert.match(script, /tasklist \/FI "PID eq %DRIFT_PID%"/);
    assert.match(script, /start "" \/wait "%INSTALLER%" \/S --updated --silent-update "--update-dir=%INSTALL_DIR%"\r\n/);
    assert.ok(!script.includes('--force-run'));
    assert.ok(!script.includes('start "" "%DRIFT_EXE%"'));
    assert.ok(script.indexOf('del /f /q "%PENDING%"') < script.lastIndexOf('del /f /q "%LOCK%"'), 'lock must be removed last');
    const startup = buildApplyScript({ pid: 1, installer: 'I', installDir: 'D', exe: 'E', lock: 'L', pending: 'P', log: 'G', relaunch: true });
    assert.match(startup, /--force-run/);
    assert.match(startup, /start "" "%DRIFT_EXE%"/);
    assert.throws(() => buildApplyScript({ pid: 1, installer: 'a"b', installDir: 'D', exe: 'E', lock: 'L', pending: 'P', log: 'G' }));
  });

  await test('check downloads, verifies and stages an update; a second check does not download again', async () => {
    reset();
    const f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'staged');
    const latest = state.requests.find((r) => r.action === 'latest');
    assert.equal(latest.app_id, 'drift');
    assert.equal(latest.version, '1.3.1');
    assert.match(latest.install_id, /^[a-f0-9]{32}$/);
    assert.equal(state.downloads, 1);
    const pending = JSON.parse(fs.readFileSync(f.updater.paths.pending, 'utf8'));
    assert.equal(pending.version, '1.4.0');
    assert.equal(pending.sha256, sha256);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(f.updater.paths.pending), pending.file)), payload);
    assert.equal(await f.updater.checkAndStage(), 'staged');
    assert.equal(state.downloads, 1);
    assert.equal(f.spawned.length, 0, 'nothing is installed while Drift is running');
  });

  await test('the install id is stable between checks', async () => {
    reset();
    const f = fixture(server);
    await f.updater.checkAndStage();
    await f.updater.checkAndStage();
    const ids = state.requests.filter((r) => r.action === 'latest').map((r) => r.install_id);
    assert.equal(new Set(ids).size, 1);
  });

  await test('a download that fails the SHA-256 check is discarded', async () => {
    reset(); state.corruptDownload = true;
    const f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'error');
    assert.ok(!fs.existsSync(f.updater.paths.pending));
    const leftovers = fs.readdirSync(path.dirname(f.updater.paths.pending)).filter((n) => n.startsWith('Drift-Setup-'));
    assert.deepEqual(leftovers, []);
  });

  await test('nothing is downloaded when Drift is current, newer, or updates are switched off', async () => {
    reset(); state.latestVersion = '1.3.1';
    let f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'up-to-date');
    reset(); state.latestVersion = '1.2.0';
    f = fixture(server, { version: '1.3.1' });
    assert.equal(await f.updater.checkAndStage(), 'up-to-date'); // never a downgrade
    reset();
    f = fixture(server); f.flags.enabled = false;
    assert.equal(await f.updater.checkAndStage(), 'disabled');
    assert.equal(state.requests.length, 0);
    assert.equal(state.downloads, 0);
  });

  await test('closing Drift starts the hidden helper with the staged installer', async () => {
    reset();
    const f = fixture(server);
    f.updater.start();
    await f.updater.checkAndStage();
    f.fakeApp.handlers['will-quit']();
    assert.equal(f.spawned.length, 1);
    const [command, args, options] = f.spawned[0];
    assert.equal(command, 'cmd.exe');
    assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(args[3], `""${f.updater.paths.cmd}""`);
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
    assert.notEqual(path.resolve(options.cwd), path.resolve(f.installDir), 'helper must not sit inside the install folder');
    const script = fs.readFileSync(f.updater.paths.cmd, 'utf8');
    assert.match(script, new RegExp(`DRIFT_PID=${process.pid}`));
    assert.ok(!script.includes('--force-run'));
    assert.ok(fs.existsSync(f.updater.paths.lock));
    assert.equal(JSON.parse(fs.readFileSync(f.updater.paths.pending, 'utf8')).attempts, 1);
    f.fakeApp.handlers['will-quit'](); // a second quit event must not launch a second installer
    assert.equal(f.spawned.length, 1);
  });

  await test('switching updates off before closing prevents the install and removes the download', async () => {
    reset();
    const f = fixture(server);
    f.updater.start();
    await f.updater.checkAndStage();
    f.flags.enabled = false;
    f.updater.settingsChanged();
    f.fakeApp.handlers['will-quit']();
    assert.equal(f.spawned.length, 0);
    assert.ok(!fs.existsSync(f.updater.paths.pending));
  });

  await test('next launch applies a staged update that was not installed on close, then Drift reopens itself', async () => {
    reset();
    const f = fixture(server);
    await f.updater.checkAndStage();
    const restarted = createUpdater({ // a fresh updater over the same profile, as after a restart
      app: f.fakeApp, force: true, execPath: path.join(f.installDir, 'Drift.exe'), fetch, isEnabled: () => true, applyWaitMs: 3000,
      spawn: (...args) => { f.spawned.push(args); return { on() {}, unref() {} }; },
      config: { appId: 'drift', gatewayUrl: 'http://127.0.0.1:1/', allowInsecure: true, firstCheckDelayMs: 1e9, checkIntervalMs: 1e9, stallTimeoutMs: 1000, requestTimeoutMs: 1000, maxInstallAttempts: 3, minInstallerBytes: 1024, maxInstallerBytes: 1e9 }
    });
    assert.equal(await restarted.prepareStartup(), 'exit');
    assert.equal(f.spawned.length, 1);
    const script = fs.readFileSync(f.updater.paths.cmd, 'utf8');
    assert.match(script, /--force-run/);
    assert.match(script, /start "" "%DRIFT_EXE%"/);
  });

  await test('a launch that finds nothing staged simply continues', async () => {
    reset();
    const f = fixture(server);
    assert.equal(await f.updater.prepareStartup(), 'continue');
    assert.equal(f.spawned.length, 0);
  });

  await test('a launch during an install waits, then restarts once the helper has finished', async () => {
    reset();
    const f = fixture(server);
    fs.mkdirSync(path.dirname(f.updater.paths.lock), { recursive: true });
    fs.writeFileSync(f.updater.paths.lock, JSON.stringify({ startedAt: Date.now(), version: '1.4.0' }));
    setTimeout(() => fs.rmSync(f.updater.paths.lock, { force: true }), 700);
    assert.equal(await f.updater.prepareStartup(), 'restart');
  });

  await test('an abandoned lock does not block startup', async () => {
    reset();
    const f = fixture(server);
    fs.mkdirSync(path.dirname(f.updater.paths.lock), { recursive: true });
    fs.writeFileSync(f.updater.paths.lock, JSON.stringify({ startedAt: Date.now() - 3600 * 1000 }));
    assert.equal(await f.updater.prepareStartup(), 'continue');
    assert.ok(!fs.existsSync(f.updater.paths.lock));
  });

  await test('after repeated failed installs the version is skipped until a newer one is published', async () => {
    reset();
    const f = fixture(server);
    f.updater.start();
    await f.updater.checkAndStage();
    const pendingFile = f.updater.paths.pending;
    const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    fs.writeFileSync(pendingFile, JSON.stringify({ ...pending, attempts: 3 }));
    f.fakeApp.handlers['will-quit']();
    assert.equal(f.spawned.length, 0);
    assert.ok(!fs.existsSync(pendingFile));
    const before = state.downloads;
    assert.equal(await f.updater.checkAndStage(), 'skipped');
    assert.equal(state.downloads, before);
    state.latestVersion = '1.4.1';
    assert.equal(await f.updater.checkAndStage(), 'staged');
  });

  await test('an installer that is damaged on disk is not run', async () => {
    reset();
    const f = fixture(server);
    f.updater.start();
    await f.updater.checkAndStage();
    const pending = JSON.parse(fs.readFileSync(f.updater.paths.pending, 'utf8'));
    fs.appendFileSync(path.join(path.dirname(f.updater.paths.pending), pending.file), 'tampered');
    f.fakeApp.handlers['will-quit']();
    assert.equal(f.spawned.length, 0);
  });

  await test('an install folder that cannot be written (administrator install) turns updates off', async () => {
    reset();
    const f = fixture(server);
    const blocked = createUpdater({ app: f.fakeApp, force: true, execPath: path.join(f.root, 'does-not-exist', 'Drift.exe'), fetch, isEnabled: () => true, spawn() {},
      config: { appId: 'drift', gatewayUrl: 'http://127.0.0.1:1/', allowInsecure: true } });
    assert.equal(blocked.supported(), false);
    assert.equal(await blocked.checkAndStage(), 'unsupported');
  });

  await test('unsupported platforms and development runs never contact the server', async () => {
    reset();
    const f = fixture(server);
    const mac = createUpdater({ app: f.fakeApp, platform: 'darwin', fetch, config: { appId: 'drift', gatewayUrl: 'http://127.0.0.1:1/', allowInsecure: true } });
    assert.equal(await mac.checkAndStage(), 'unsupported');
    const dev = createUpdater({ app: { ...f.fakeApp, isPackaged: false }, platform: 'win32', arch: 'x64', fetch, config: { appId: 'drift', gatewayUrl: 'http://127.0.0.1:1/', allowInsecure: true } });
    assert.equal(await dev.checkAndStage(), 'unsupported');
    assert.equal(state.requests.length, 0);
  });

  await test('a plain-HTTP gateway address is refused', async () => {
    reset();
    const f = fixture(server);
    const insecure = createUpdater({ app: f.fakeApp, force: true, execPath: path.join(f.installDir, 'Drift.exe'), fetch, isEnabled: () => true, spawn() {},
      config: { appId: 'drift', gatewayUrl: `http://127.0.0.1:${server.address().port}/x`, requestTimeoutMs: 1000 } });
    assert.equal(await insecure.checkAndStage(), 'error');
    assert.equal(state.requests.length, 0);
  });

  server.close();
  let failed = 0;
  for (const [ok, name, error] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) { failed += 1; console.log(`     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
