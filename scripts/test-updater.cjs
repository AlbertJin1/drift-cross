'use strict';

// Exercises src/main/updater.js against a fake Universal App Monitor client gateway (resource=update). No Electron and
// no Windows needed:   npm run test:updater
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
const GATEWAY_PATH = '/m/api/client-gateway.php';

function startGateway(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    if (url.pathname !== GATEWAY_PATH || url.searchParams.get('resource') !== 'update') { res.statusCode = 404; return res.end('{}'); }
    const action = url.searchParams.get('action');
    if (action === 'latest') {
      state.apiCalls += 1;
      if (state.apiStatus) { res.writeHead(state.apiStatus, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'simulated' })); }
      if (state.splash) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>tunnel</html>'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!state.withRelease) return res.end(JSON.stringify({ ok: true, app_id: 'drift', latest: null, status: 'no_release', update_available: false }));
      const current = url.searchParams.get('version');
      const flag = state.flag === null ? (compareVersions(current, state.latestVersion) === -1) : state.flag;
      const latest = { version: state.latestVersion, notes: 'Notes', size: payload.length, released_at: 1 };
      if (state.announce) latest.sha256 = state.announcedSha;
      return res.end(JSON.stringify({ ok: true, app_id: 'drift', latest, latest_version: state.latestVersion, status: flag ? 'update_available' : 'up_to_date', update_available: flag }));
    }
    if (action === 'download' && url.searchParams.get('version') === state.latestVersion) {
      state.downloads += 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
      return res.end(state.corruptDownload ? Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(payload.length - 2)]) : payload);
    }
    res.statusCode = 400; res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function testConfig(server, extra = {}) {
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    appId: 'drift', gatewayUrl: `${base}${GATEWAY_PATH}`, fallbackGatewayUrls: [], allowInsecure: true,
    firstCheckDelayMs: 1e9, checkIntervalMs: 1e9, stallTimeoutMs: 5000, requestTimeoutMs: 5000,
    maxInstallAttempts: 3, minInstallerBytes: 1024, maxInstallerBytes: 1e9, ...extra
  };
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
    config: testConfig(server)
  });
  return { root, installDir, fakeApp, flags, updater, spawned };
}

(async () => {
  const state = { requests: [], downloads: 0, apiCalls: 0, apiStatus: 0, withRelease: true, announce: true, splash: false, flag: null, latestVersion: '1.4.0', announcedSha: sha256, corruptDownload: false };
  const server = await startGateway(state);
  const reset = () => { state.requests.length = 0; state.downloads = 0; state.apiCalls = 0; state.apiStatus = 0; state.withRelease = true; state.announce = true; state.splash = false; state.flag = null; state.latestVersion = '1.4.0'; state.announcedSha = sha256; state.corruptDownload = false; };

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

  await test('check asks the monitor, then downloads, verifies and stages; a second check does not download again', async () => {
    reset();
    const f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'staged');
    const ask = state.requests.find((r) => r.query.action === 'latest');
    assert.equal(ask.query.resource, 'update');
    assert.equal(ask.query.app_id, 'drift');
    assert.equal(ask.query.version, '1.3.1');
    assert.equal(ask.query.platform, 'windows');
    assert.match(ask.query.install_id, /^[a-f0-9]{32}$/);
    assert.ok(ask.query.hostname, 'the PC name is sent so the monitor folds this PC into one install row');
    assert.match(ask.headers['user-agent'], /^Drift\/1\.3\.1$/);
    const get = state.requests.find((r) => r.query.action === 'download');
    assert.equal(get.query.version, '1.4.0');
    assert.equal(get.query.app_id, 'drift');
    assert.equal(state.downloads, 1);
    const pending = JSON.parse(fs.readFileSync(f.updater.paths.pending, 'utf8'));
    assert.equal(pending.version, '1.4.0');
    assert.equal(pending.sha256, sha256);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(f.updater.paths.pending), pending.file)), payload);
    assert.equal(await f.updater.checkAndStage(), 'staged');
    assert.equal(state.downloads, 1);
    assert.equal(f.spawned.length, 0, 'nothing is installed while Drift is running');
  });

  await test('the install id (shared with usage reporting) is stable and is what the monitor receives', async () => {
    reset();
    const f = fixture(server);
    await f.updater.checkAndStage();
    await f.updater.checkAndStage();
    const id = f.updater.installId();
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.equal(f.updater.installId(), id);
    for (const r of state.requests.filter((x) => x.query.action === 'latest')) assert.equal(r.query.install_id, id);
    assert.equal(f.updater.adoptInstallId('A'.repeat(32).toLowerCase()), true);
    assert.equal(f.updater.installId(), 'a'.repeat(32));
    assert.equal(f.updater.adoptInstallId('nope'), false);
  });

  await test('"newer" is the monitor flag OR our own comparison, but never a downgrade', async () => {
    reset(); state.flag = true; state.latestVersion = '1.4.0';
    let f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'staged'); // flag says update
    reset(); state.flag = false; state.latestVersion = '1.4.0';
    f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'staged'); // flag missed it, our comparison catches it
    reset(); state.flag = true; state.latestVersion = '1.2.0';
    f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'up-to-date'); // a stale flag cannot downgrade
    assert.equal(state.downloads, 0);
  });

  await test('an answer without a SHA-256 checksum is refused', async () => {
    reset(); state.announce = false;
    const f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'error');
    assert.equal(state.downloads, 0);
  });

  await test('a wrong announced checksum means the download is discarded', async () => {
    reset(); state.announcedSha = crypto.randomBytes(32).toString('hex');
    const f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'error');
    assert.ok(!fs.existsSync(f.updater.paths.pending));
  });

  await test('no published release (latest: null) simply means up to date', async () => {
    reset(); state.withRelease = false;
    const f = fixture(server);
    assert.equal(await f.updater.checkAndStage(), 'up-to-date');
    assert.equal(state.downloads, 0);
  });

  await test('a monitor outage, rate limit or tunnel splash page is a retryable error, not an update', async () => {
    for (const status of [503, 429, 500]) {
      reset(); state.apiStatus = status;
      assert.equal(await fixture(server).updater.checkAndStage(), 'error');
    }
    reset(); state.splash = true;
    assert.equal(await fixture(server).updater.checkAndStage(), 'error');
    assert.equal(state.downloads, 0);
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
    assert.equal(command, 'conhost.exe');
    assert.deepEqual(args.slice(0, 5), ['--headless', 'cmd.exe', '/d', '/s', '/c']);
    assert.equal(args[5], `""${f.updater.paths.cmd}""`);
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
      config: testConfig(server)
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
      config: testConfig(server) });
    assert.equal(blocked.supported(), false);
    assert.equal(await blocked.checkAndStage(), 'unsupported');
  });

  await test('unsupported platforms and development runs never contact the server', async () => {
    reset();
    const f = fixture(server);
    const mac = createUpdater({ app: f.fakeApp, platform: 'darwin', fetch, config: testConfig(server) });
    assert.equal(await mac.checkAndStage(), 'unsupported');
    const dev = createUpdater({ app: { ...f.fakeApp, isPackaged: false }, platform: 'win32', arch: 'x64', fetch, config: testConfig(server) });
    assert.equal(await dev.checkAndStage(), 'unsupported');
    assert.equal(state.requests.length, 0);
  });

  await test('a plain-HTTP monitor address is refused', async () => {
    reset();
    const f = fixture(server);
    const insecure = createUpdater({ app: f.fakeApp, force: true, execPath: path.join(f.installDir, 'Drift.exe'), fetch, isEnabled: () => true, spawn() {},
      config: testConfig(server, { allowInsecure: false }) });
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
