'use strict';

// Exercises Drift's product-review submission path using a local fake Monitor gateway.
// No Electron, network service or production review is required.

const assert = require('node:assert/strict');
const http = require('node:http');
const { finish } = require('./test-exit.cjs');
const { createReviewService } = require('../src/main/reviews.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (error) { results.push([false, name, error]); }
}

function createServer(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.searchParams.get('resource') !== 'telemetry') return reply(404, { ok: false, error: 'resource' });
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'method' });
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'json' }); }
      state.requests.push(body);
      if (state.wait) {
        state.waitStarted?.();
        state.wait.then(() => reply(state.status || 200, state.answer || { ok: true, app_id: 'drift', install_id: state.canonicalId || body.install_id }));
        return;
      }
      const status = state.status || 200;
      if (status !== 200) return reply(status, state.answer || { ok: false, error: 'test failure' });
      if (body.event !== 'review' || body.app_id !== 'drift' || body.app !== 'drift') return reply(400, { ok: false, error: 'event' });
      if (!/^[a-f0-9]{32}$/.test(body.install_id || '')) return reply(400, { ok: false, error: 'install id' });
      if (!/^\d+\.\d+\.\d+$/.test(body.version || '')) return reply(400, { ok: false, error: 'version' });
      if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) return reply(400, { ok: false, error: 'rating' });
      if (typeof body.name !== 'string' || body.name.length > 60) return reply(400, { ok: false, error: 'name' });
      if (typeof body.message !== 'string' || body.message.length > 1500) return reply(400, { ok: false, error: 'message' });
      return reply(200, { ok: true, app_id: 'drift', install_id: state.canonicalId || body.install_id });
    });
  });
}

function makeFixture(server) {
  const identity = { id: 'a'.repeat(32), adopted: [] };
  const app = { getVersion: () => '1.3.6' };
  const config = {
    appId: 'drift',
    gatewayUrl: `http://127.0.0.1:${server.address().port}/api/client-gateway.php`,
    allowInsecure: true
  };
  const service = createReviewService({
    app,
    config,
    fetch: (url, init) => fetch(url, init),
    identity: { get: () => identity.id, set: (id) => { identity.id = id; identity.adopted.push(id); } },
    timeoutMs: 1000
  });
  return { service, identity };
}

(async () => {
  const state = { requests: [], status: 0, answer: null, canonicalId: null, wait: null, waitStarted: null };
  const server = createServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const reset = () => {
    state.requests.length = 0;
    state.status = 0;
    state.answer = null;
    state.canonicalId = null;
    state.wait = null;
    state.waitStarted = null;
  };

  await test('submits a valid review through resource=telemetry using the existing Drift installation identity', async () => {
    reset();
    const { service } = makeFixture(server);
    const result = await service.submit({ rating: 5, name: '  Alex  ', message: 'Fast browser\r\nGreat UI' });
    assert.deepEqual(result, { ok: true });
    assert.equal(state.requests.length, 1);
    assert.deepEqual(state.requests[0], {
      event: 'review', app_id: 'drift', app: 'drift', install_id: 'a'.repeat(32), version: '1.3.6',
      rating: 5, name: 'Alex', message: 'Fast browser\nGreat UI'
    });
  });

  await test('does not submit invalid ratings or malformed payloads', async () => {
    reset();
    const { service } = makeFixture(server);
    assert.equal((await service.submit({ rating: 0 })).ok, false);
    assert.equal((await service.submit({ rating: 6 })).ok, false);
    assert.equal((await service.submit(null)).ok, false);
    assert.equal(state.requests.length, 0);
  });

  await test('does not send machine name, LAN address, browsing data or other unnecessary fields', async () => {
    reset();
    const { service } = makeFixture(server);
    const result = await service.submit({ rating: 4, name: '', message: 'Nice and simple.' });
    assert.equal(result.ok, true);
    const keys = Object.keys(state.requests[0]).sort();
    assert.deepEqual(keys, ['app', 'app_id', 'event', 'install_id', 'message', 'name', 'rating', 'version']);
  });

  await test('adopts the monitor canonical installation id after an accepted review', async () => {
    reset();
    state.canonicalId = 'b'.repeat(32);
    const { service, identity } = makeFixture(server);
    assert.equal((await service.submit({ rating: 3 })).ok, true);
    assert.equal(identity.id, 'b'.repeat(32));
    assert.deepEqual(identity.adopted, ['b'.repeat(32)]);
  });

  await test('returns server rate-limit and network validation errors without reporting success', async () => {
    reset();
    state.status = 429;
    state.answer = { ok: false, error: 'Too many reviews. Please try tomorrow.' };
    const { service } = makeFixture(server);
    const result = await service.submit({ rating: 5 });
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 429/);
    assert.equal(state.requests.length, 1);
  });

  await test('prevents concurrent duplicate submissions from the same Drift process', async () => {
    reset();
    let release;
    let started;
    const began = new Promise((resolve) => { started = resolve; });
    state.wait = new Promise((resolve) => { release = resolve; });
    state.waitStarted = started;
    const { service } = makeFixture(server);
    const first = service.submit({ rating: 5, message: 'Good.' });
    await began;
    const second = await service.submit({ rating: 4, message: 'Double click.' });
    assert.equal(second.ok, false);
    assert.match(second.error, /already being submitted/i);
    release();
    assert.equal((await first).ok, true);
    assert.equal(state.requests.length, 1);
  });

  let failed = 0;
  for (const [ok, name, error] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) {
      failed += 1;
      console.log(`     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await finish(failed, [server]);
})();
