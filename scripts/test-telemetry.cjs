'use strict';
const { finish } = require('./test-exit.cjs');

// Exercises src/main/telemetry.js against a fake monitor gateway that applies the same validation as the real
// client-gateway.php (resource=telemetry): no Electron and no Windows needed.
//   npm run test:telemetry

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createTelemetry, osLabel } = require('../src/main/telemetry.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); } catch (error) { results.push([false, name, error]); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return true; await sleep(10); }
  return predicate();
}

// ---- fake gateway: mirrors the checks in public/api/client-gateway.php (case 'telemetry')
function startGateway(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.searchParams.get('resource') !== 'telemetry') return reply(404, { ok: false });
      if (req.method !== 'POST') return reply(405, { ok: false });
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'json' }); }
      state.requests.push(body);
      if (state.hang) return; // never answers
      if (state.statuses.length) { const status = state.statuses.shift(); if (status !== 200) return reply(status, { ok: false }); }
      if (!['open', 'heartbeat', 'close'].includes(body.event)) return reply(400, { ok: false, error: 'event' });
      if (body.app_id !== 'drift' || body.app !== 'drift') return reply(400, { ok: false, error: 'app' });
      if (!/^[a-f0-9]{16,64}$/i.test(body.install_id || '')) return reply(400, { ok: false, error: 'install' });
      if (!/^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]{1,64})?$/.test(body.version || '')) return reply(400, { ok: false, error: 'version' });
      if (!/^[a-f0-9]{32}$/i.test(body.session_id || '')) return reply(400, { ok: false, error: 'session' });
      if (!Number.isInteger(body.started_at) || body.started_at < 1) return reply(400, { ok: false, error: 'started_at' });
      if (!Number.isInteger(body.seconds) || body.seconds < 0) return reply(400, { ok: false, error: 'seconds' });
      return reply(200, { ok: true, app_id: 'drift', install_id: state.canonicalInstallId || body.install_id });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function fixture(server, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-telemetry-'));
  const fakeApp = { isPackaged: options.packaged !== false, getVersion: () => options.version || '1.3.1', getPath: () => root };
  const flags = { enabled: options.enabled !== false };
  const identity = { id: options.installId || 'a'.repeat(32), adopted: [] };
  const config = {
    appId: 'drift',
    gatewayUrl: `http://127.0.0.1:${server.address().port}/api/client-gateway.php`,
    allowInsecure: true,
    reportFirstDelayMs: 50, reportIntervalMs: 250, reportRetryMs: 150, reportTimeoutMs: 1200, reportCloseTimeoutMs: 500
  };
  const telemetry = createTelemetry({
    app: fakeApp,
    config,
    fetch: (url, init) => fetch(url, init),
    isEnabled: () => flags.enabled,
    identity: { get: () => identity.id, set: (id) => { identity.id = id; identity.adopted.push(id); } },
    os: { hostname: () => 'OFFICE-PC-07', release: () => '10.0.22631', networkInterfaces: () => ({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }] }) },
    platform: 'win32',
    arch: 'x64'
  });
  return { telemetry, flags, identity, root };
}

const newState = () => ({ requests: [], statuses: [], hang: false, canonicalInstallId: null });

(async () => {
  const state = newState();
  const server = await startGateway(state);
  const reset = () => { state.requests.length = 0; state.statuses.length = 0; state.hang = false; state.canonicalInstallId = null; };

  await test('os label names Windows 11 by build number and keeps other systems readable', () => {
    assert.equal(osLabel('win32', '10.0.22631', 'x64'), 'Windows 11 (10.0.22631) x64');
    assert.equal(osLabel('win32', '10.0.19045', 'x64'), 'Windows 10 (10.0.19045) x64');
    assert.equal(osLabel('darwin', '24.1.0', 'arm64'), 'macOS 24.1.0 arm64');
    assert.equal(osLabel('linux', '6.8.0', 'x64'), 'Linux 6.8.0 x64');
  });

  await test('sends open, then heartbeats with one stable session id, and a valid gateway payload', async () => {
    reset();
    const { telemetry } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => state.requests.length >= 3), 'expected open + 2 heartbeats');
    await telemetry.stop();
    const events = state.requests.map((r) => r.event);
    assert.equal(events[0], 'open');
    assert.deepEqual(events.slice(1, 3), ['heartbeat', 'heartbeat']);
    assert.equal(new Set(state.requests.map((r) => r.session_id)).size, 1);
    assert.equal(new Set(state.requests.map((r) => r.started_at)).size, 1);
    const first = state.requests[0];
    assert.equal(first.hostname, 'OFFICE-PC-07');
    assert.equal(first.local_ip, '192.168.1.42');
    assert.equal(first.os, 'Windows 11 (10.0.22631) x64');
    assert.equal(first.version, '1.3.1');
    assert.ok(state.requests[2].seconds >= first.seconds);
  });

  await test('reports nothing but status fields - no sites, tabs, searches or history', async () => {
    reset();
    const { telemetry } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => state.requests.length >= 1));
    await telemetry.stop();
    const keys = Object.keys(state.requests[0]).sort();
    assert.deepEqual(keys, ['app', 'app_id', 'event', 'hostname', 'install_id', 'local_ip', 'os', 'seconds', 'session_id', 'started_at', 'version']);
  });

  await test('stop() sends exactly one close for the open session', async () => {
    reset();
    const { telemetry } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => telemetry.hasOpenSession()));
    assert.equal(telemetry.hasOpenSession(), true);
    await telemetry.stop();
    const closes = state.requests.filter((r) => r.event === 'close');
    assert.equal(closes.length, 1);
    assert.equal(closes[0].session_id, state.requests[0].session_id);
    const count = state.requests.length;
    await sleep(350);
    assert.equal(state.requests.length, count, 'nothing is sent after stop()');
  });

  await test('quitting is never held up: a gateway that never answers delays stop() by at most the close timeout', async () => {
    reset();
    const { telemetry } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => telemetry.hasOpenSession()));
    state.hang = true;
    const began = Date.now();
    await telemetry.stop();
    assert.ok(Date.now() - began < 1000, `stop() took ${Date.now() - began} ms`);
  });

  await test('switched off: sends nothing, and a launch with reporting off never contacts the monitor', async () => {
    reset();
    const { telemetry } = fixture(server, { enabled: false });
    telemetry.start();
    await sleep(250);
    await telemetry.stop();
    assert.equal(state.requests.length, 0);
  });

  await test('switching off mid-session closes it; switching back on starts a NEW session', async () => {
    reset();
    const { telemetry, flags } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => telemetry.hasOpenSession()));
    const firstSession = state.requests[0].session_id;
    flags.enabled = false;
    telemetry.settingsChanged();
    assert.ok(await waitFor(() => state.requests.some((r) => r.event === 'close')));
    assert.equal(telemetry.hasOpenSession(), false);
    const afterClose = state.requests.length;
    await sleep(350);
    assert.equal(state.requests.length, afterClose, 'silent while switched off');
    flags.enabled = true;
    telemetry.settingsChanged();
    assert.ok(await waitFor(() => state.requests.filter((r) => r.event === 'open').length >= 2));
    const secondOpen = state.requests.filter((r) => r.event === 'open')[1];
    assert.notEqual(secondOpen.session_id, firstSession, 'a closed session id can never reopen on the monitor');
    await telemetry.stop();
  });

  await test('development runs (not packaged) report nothing', async () => {
    reset();
    const { telemetry } = fixture(server, { packaged: false });
    assert.equal(telemetry.supported(), false);
    telemetry.start();
    await sleep(250);
    await telemetry.stop();
    assert.equal(state.requests.length, 0);
  });

  await test('a failed open is retried soon as an open (not a heartbeat) until the monitor accepts it', async () => {
    reset();
    state.statuses.push(500, 500);
    const { telemetry } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => telemetry.hasOpenSession()));
    await telemetry.stop();
    const events = state.requests.map((r) => r.event);
    assert.deepEqual(events.slice(0, 3), ['open', 'open', 'open']);
    assert.equal(new Set(state.requests.slice(0, 3).map((r) => r.session_id)).size, 1, 'the retries keep the same session');
  });

  await test('a 409 session collision starts a fresh session', async () => {
    reset();
    state.statuses.push(409);
    const { telemetry } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => telemetry.hasOpenSession()));
    await telemetry.stop();
    assert.notEqual(state.requests[0].session_id, state.requests[1].session_id);
  });

  await test("adopts the monitor's canonical install id (one PC = one install)", async () => {
    reset();
    state.canonicalInstallId = 'b'.repeat(32);
    const { telemetry, identity } = fixture(server);
    telemetry.start();
    assert.ok(await waitFor(() => state.requests.length >= 2 && identity.id === 'b'.repeat(32)));
    await telemetry.stop();
    assert.deepEqual(identity.adopted, ['b'.repeat(32)]);
    assert.equal(state.requests[1].install_id, 'b'.repeat(32));
  });

  await test('plain-HTTP gateways are refused unless explicitly allowed (no key or data over cleartext)', async () => {
    reset();
    const fx = fixture(server);
    const strict = createTelemetry({
      app: { isPackaged: true, getVersion: () => '1.3.1', getPath: () => fx.root },
      config: { appId: 'drift', gatewayUrl: `http://127.0.0.1:${server.address().port}/x.php`, reportTimeoutMs: 200 },
      fetch: (url, init) => fetch(url, init),
      identity: { get: () => 'a'.repeat(32), set() {} }
    });
    assert.equal(await strict.send('open'), false);
    assert.equal(state.requests.length, 0);
  });

  let failed = 0;
  for (const [ok, name, error] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) { failed += 1; console.log(`     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await finish(failed, [server]);
})();
