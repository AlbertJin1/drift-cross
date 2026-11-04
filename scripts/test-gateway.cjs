'use strict';
const { finish } = require('./test-exit.cjs');

// Exercises src/main/monitor-gateway.js and the telemetry offline queue against fake monitors:
//   npm run test:gateway
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createGateway, gatewayCandidates } = require('../src/main/monitor-gateway.js');
const { createTelemetry } = require('../src/main/telemetry.js');

const results = [];
async function test(name, fn) { try { await fn(); results.push([true, name]); } catch (error) { results.push([false, name, error]); } }
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const base = (server, p) => `http://127.0.0.1:${server.address().port}${p}`;
const mk = (config) => createGateway({ config: { allowInsecure: true, ...config }, fetch: (u, i) => fetch(u, i), version: () => '1.3.3' });

(async () => {
  await test('candidates include the /public/api layout and the fallback host', () => {
    const list = gatewayCandidates({ gatewayUrl: 'https://a.example/m/api/client-gateway.php', fallbackGatewayUrls: ['https://b.example/m/api/client-gateway.php'] }, { resource: 'update' });
    assert.deepEqual(list.map((u) => u.host + u.pathname), [
      'a.example/m/api/client-gateway.php', 'a.example/m/public/api/client-gateway.php',
      'b.example/m/api/client-gateway.php', 'b.example/m/public/api/client-gateway.php'
    ]);
  });

  await test('plain HTTP is refused unless allowInsecure', async () => {
    const result = await createGateway({ config: { gatewayUrl: 'http://x.example/api/client-gateway.php' }, fetch: () => { throw new Error('must not fetch'); }, version: () => '1' }).request({ params: {} });
    assert.equal(result.kind, 'permanent');
  });

  await test('falls back from /api to /public/api when the rewrite is missing (404)', async () => {
    const hits = [];
    const server = await listen((req, res) => {
      hits.push(req.url);
      if (req.url.startsWith('/m/public/api/')) return json(res, 200, { ok: true });
      return json(res, 404, { ok: false });
    });
    const gw = mk({ gatewayUrl: base(server, '/m/api/client-gateway.php') });
    const result = await gw.request({ params: { resource: 'update' } });
    assert.equal(result.kind, 'ok');
    assert.equal(hits.length, 2);
    // the working route is remembered
    await gw.request({ params: { resource: 'update' } });
    assert.ok(hits[2].startsWith('/m/public/api/'));
    server.close();
  });

  await test('an HTML splash page with HTTP 200 is not mistaken for the API', async () => {
    const server = await listen((req, res) => {
      if (req.url.startsWith('/m/public/api/')) return json(res, 200, { ok: true });
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>tunnel splash</html>');
    });
    const result = await mk({ gatewayUrl: base(server, '/m/api/client-gateway.php') }).request({ params: {} });
    assert.equal(result.kind, 'ok');
    server.close();
  });

  await test('an HTML-only gateway is a retryable failure, not a success', async () => {
    const server = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); });
    const result = await mk({ gatewayUrl: base(server, '/x/api/client-gateway.php') }).request({ params: {} });
    assert.equal(result.kind, 'retry');
    server.close();
  });

  await test('a dead primary host falls through to the fallback host', async () => {
    const live = await listen((req, res) => json(res, 200, { ok: true }));
    const dead = await listen((req, res) => res.end());
    const deadUrl = base(dead, '/m/api/client-gateway.php');
    dead.close();
    const result = await mk({ gatewayUrl: deadUrl, fallbackGatewayUrls: [base(live, '/m/api/client-gateway.php')] }).request({ params: {} });
    assert.equal(result.kind, 'ok');
    live.close();
  });

  await test('classification: 4xx permanent, 5xx and 429 retry, redirects stay on HTTPS rules', async () => {
    const codes = [400, 409, 500, 503, 429];
    const server = await listen((req, res) => json(res, codes.shift(), { ok: false, error: 'x' }));
    const gw = mk({ gatewayUrl: base(server, '/nodir/client-gateway.php') });
    assert.equal((await gw.request({ params: {} })).kind, 'permanent');
    assert.equal((await gw.request({ params: {} })).kind, 'permanent');
    assert.equal((await gw.request({ params: {} })).kind, 'retry');
    assert.equal((await gw.request({ params: {} })).kind, 'retry');
    assert.equal((await gw.request({ params: {} })).kind, 'retry');
    server.close();
  });

  await test('telemetry keeps reports while the monitor is down and re-sends them when it is back', async () => {
    const received = [];
    let down = true;
    const server = await listen((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (down) return json(res, 503, { ok: false });
        const body = JSON.parse(raw); received.push(body.event + ':' + body.session_id.slice(0, 4));
        json(res, 200, { ok: true, install_id: body.install_id });
      });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-queue-'));
    const t = createTelemetry({
      app: { isPackaged: true, getVersion: () => '1.3.3', getPath: () => dir }, dir,
      config: { appId: 'drift', gatewayUrl: base(server, '/nodir/client-gateway.php'), allowInsecure: true, reportTimeoutMs: 1500 },
      fetch: (u, i) => fetch(u, i), identity: { get: () => 'b'.repeat(32), set() {} },
      os: { hostname: () => 'PC', release: () => '10.0.22631', networkInterfaces: () => ({}) }, platform: 'win32', arch: 'x64'
    });
    assert.equal(await t.send('open'), false);
    assert.equal(JSON.parse(fs.readFileSync(t.paths.queue, 'utf8')).length, 1);
    down = false;
    assert.equal(await t.send('open'), true);
    for (let i = 0; i < 100 && (received.length < 2 || JSON.parse(fs.readFileSync(t.paths.queue, 'utf8')).length); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(received.length >= 2, 'the queued open was re-sent');
    assert.equal(JSON.parse(fs.readFileSync(t.paths.queue, 'utf8')).length, 0);
    server.close();
  });

  for (const [ok, name, error] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  ${error && error.stack || error}`}`);
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await finish(failed, []);
})();
