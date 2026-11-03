'use strict';

// Exercises src/main/vpn.js: validation, proxy rules, the authenticated SOCKS5 relay (against a
// fake upstream proxy) and the profile store. No Electron needed:
//   npm run test:vpn

const assert = require('node:assert/strict');
const net = require('node:net');
const { validateProfile, buildProxyConfig, cleanHost, startSocksRelay, friendlyError, createVpn } = require('../src/main/vpn.js');

const results = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const base = { name: 'Work', type: 'https', server: 'vpn.example.com', port: 443, signIn: 'password', username: 'ann', password: 'secret' };

// ---- validation
test('a complete profile validates and keeps the password out of the profile object', () => {
  const r = validateProfile(base);
  assert.equal(r.error, undefined);
  assert.equal(r.password, 'secret');
  assert.equal(r.profile.password, undefined);
  assert.equal(r.profile.server, 'vpn.example.com');
});
test('a pasted scheme, path and trailing dot are cleaned from the server', () => {
  assert.equal(cleanHost('https://VPN.Example.com./path'), 'vpn.example.com');
  assert.equal(cleanHost('vpn.example.com:8443'), 'vpn.example.com');
  assert.equal(cleanHost('[2001:db8::1]'), '2001:db8::1');
});
test('bad names, hosts, ports and types are rejected', () => {
  assert.ok(validateProfile({ ...base, name: '  ' }).error);
  assert.ok(validateProfile({ ...base, server: 'not a host' }).error);
  assert.ok(validateProfile({ ...base, server: '' }).error);
  assert.ok(validateProfile({ ...base, port: 0 }).error);
  assert.ok(validateProfile({ ...base, port: 70000 }).error);
  assert.ok(validateProfile({ ...base, port: 'abc' }).error);
  assert.ok(validateProfile({ ...base, type: 'sstp' }).error);
});
test('an empty port falls back to the type default', () => {
  assert.equal(validateProfile({ ...base, type: 'socks5', port: '' }).profile.port, 1080);
});
test('password sign-in needs a user name; "none" needs nothing', () => {
  assert.ok(validateProfile({ ...base, username: '' }).error);
  const none = validateProfile({ ...base, signIn: 'none', username: '', password: '' });
  assert.equal(none.error, undefined);
  assert.equal(none.profile.username, '');
});
test('editing with a blank password keeps the stored one (password === null)', () => {
  const r = validateProfile({ ...base, password: '' }, { hasPassword: true, signIn: 'password' });
  assert.equal(r.password, null);
});

// ---- proxy rules
test('proxy rules per type, IPv6 bracketed, localhost bypassed', () => {
  assert.equal(buildProxyConfig({ type: 'https', server: 'a.com', port: 443 }).proxyRules, 'https://a.com:443');
  assert.equal(buildProxyConfig({ type: 'http', server: 'a.com', port: 8080 }).proxyRules, 'http://a.com:8080');
  assert.equal(buildProxyConfig({ type: 'socks5', server: '2001:db8::1', port: 1080 }).proxyRules, 'socks5://[2001:db8::1]:1080');
  const viaRelay = buildProxyConfig({ type: 'socks5', server: 'a.com', port: 1080 }, 5555);
  assert.equal(viaRelay.proxyRules, 'socks5://127.0.0.1:5555');
  assert.equal(viaRelay.proxyBypassRules, '<local>');
  assert.equal(viaRelay.mode, 'fixed_servers');
});

// ---- friendly errors
test('error messages are readable', () => {
  assert.match(friendlyError(new Error('net::ERR_NAME_NOT_RESOLVED')), /could not be found/);
  assert.match(friendlyError(new Error('net::ERR_CONNECTION_REFUSED')), /refused/);
  assert.match(friendlyError(new Error('whatever'), true), /username or password/);
});

// ---- relay against a fake authenticated SOCKS5 upstream
function fakeUpstream({ user, pass }) {
  const seen = { auth: null, target: null };
  const server = net.createServer((sock) => {
    let stage = 0; let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(2)) { sock.end(Buffer.from([5, 0xff])); return; }
        sock.write(Buffer.from([5, 2])); stage = 1;
      }
      if (stage === 1 && buf.length >= 2 && buf.length >= 2 + buf[1] + 1 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        const ulen = buf[1]; const u = buf.subarray(2, 2 + ulen).toString();
        const plen = buf[2 + ulen]; const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        seen.auth = [u, p];
        if (u !== user || p !== pass) { sock.end(Buffer.from([1, 1])); return; }
        sock.write(Buffer.from([1, 0])); stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        const atyp = buf[3]; let need = atyp === 3 ? 5 + buf[4] + 2 : atyp === 1 ? 10 : 22;
        if (buf.length < need) return;
        const host = atyp === 3 ? buf.subarray(5, 5 + buf[4]).toString() : '';
        const port = buf.readUInt16BE(need - 2);
        seen.target = [host, port];
        buf = buf.subarray(need);
        const out = net.connect({ host: '127.0.0.1', port }, () => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (buf.length) out.write(buf);
          sock.pipe(out); out.pipe(sock); stage = 3;
        });
        out.on('error', () => sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        stage = 2.5;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}
function echoServer() {
  const server = net.createServer((s) => { s.on('error', () => {}); s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function socksConnectVia(relayPort, host, port) {
  return new Promise((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port: relayPort });
    let buf = Buffer.alloc(0); let step = 0; let reply = null;
    c.on('error', reject);
    c.on('connect', () => c.write(Buffer.from([5, 1, 0])));
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0 && buf.length >= 2) {
        buf = buf.subarray(2); step = 1;
        const h = Buffer.from(host);
        const req = Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]);
        c.write(req);
      }
      if (step === 1 && buf.length >= 10) {
        reply = buf[1]; buf = buf.subarray(10); step = 2;
        if (reply !== 0) { c.destroy(); resolve({ reply }); return; }
        c.write('hello');
      }
      if (step === 2 && buf.toString().includes('echo:hello')) { c.destroy(); resolve({ reply, data: buf.toString() }); }
    });
    setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, 4000);
  });
}

test('relay signs in upstream and tunnels data (domain target resolved by the proxy)', async () => {
  const echo = await echoServer();
  const up = await fakeUpstream({ user: 'ann', pass: 'p@ss' });
  const relay = await startSocksRelay({ host: '127.0.0.1', port: up.port, username: 'ann', password: 'p@ss' });
  try {
    const out = await socksConnectVia(relay.port, 'localhost', echo.port);
    assert.equal(out.reply, 0);
    assert.match(out.data, /echo:hello/);
    assert.deepEqual(up.seen.auth, ['ann', 'p@ss']);
    assert.deepEqual(up.seen.target, ['localhost', echo.port]);
  } finally { relay.close(); up.server.close(); echo.server.close(); }
});
test('relay reports a refused sign-in to the browser instead of tunnelling', async () => {
  const up = await fakeUpstream({ user: 'ann', pass: 'right' });
  let flagged = false;
  const relay = await startSocksRelay({ host: '127.0.0.1', port: up.port, username: 'ann', password: 'wrong', onError: (e) => { flagged = !!e.socksAuth; } });
  try {
    const out = await socksConnectVia(relay.port, 'localhost', 9);
    assert.notEqual(out.reply, 0);
    assert.equal(flagged, true);
  } finally { relay.close(); up.server.close(); }
});
test('relay listens on loopback only', async () => {
  const relay = await startSocksRelay({ host: '127.0.0.1', port: 1, username: 'a', password: 'b' });
  try {
    await new Promise((resolve, reject) => { const c = net.connect({ host: '127.0.0.1', port: relay.port }, () => { c.destroy(); resolve(); }); c.on('error', reject); });
  } finally { relay.close(); }
});

// ---- profile store (fake storage and encryption)
function makeVpn(initial) {
  const files = { 'vpn.json': initial || { profiles: [] } };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`enc(${t})`), decryptString: (b) => b.toString().slice(4, -1) };
  const vpn = createVpn({ getSession: () => ({}), net: {}, safeStorage, readJson: (f, d) => files[f] ?? d, writeJson: (f, v) => { files[f] = JSON.parse(JSON.stringify(v)); return true; }, log: { warn() {} } });
  vpn.load();
  return { vpn, files };
}
test('saved passwords are encrypted on disk and never exposed to the UI', () => {
  const { vpn, files } = makeVpn();
  const r = vpn.save(base);
  assert.equal(r.ok, true);
  const stored = files['vpn.json'].profiles[0];
  assert.notEqual(stored.pw, 'secret');
  assert.ok(stored.pw);
  assert.equal(JSON.stringify(vpn.publicState()).includes('secret'), false);
  assert.equal(JSON.stringify(vpn.publicState()).includes(stored.pw), false);
  assert.equal(vpn.publicState().profiles[0].hasPassword, true);
});
test('"remember" off stores no password; editing with blank password keeps the old one', () => {
  const { vpn, files } = makeVpn();
  const a = vpn.save({ ...base, name: 'A', remember: false });
  assert.equal(files['vpn.json'].profiles[0].pw, '');
  const b = vpn.save({ ...base, name: 'B' });
  const before = files['vpn.json'].profiles[1].pw;
  vpn.save({ ...base, id: b.id, name: 'B2', password: '' });
  assert.equal(files['vpn.json'].profiles[1].pw, before);
  assert.equal(a.ok, true);
});
test('duplicate names are refused and delete works', () => {
  const { vpn } = makeVpn();
  const first = vpn.save(base);
  assert.ok(vpn.save({ ...base, name: 'work' }).error);
  vpn.remove(first.id);
  assert.equal(vpn.publicState().profiles.length, 0);
});
test('proxy sign-in is answered only for the connected server, and only a few times', () => {
  const { vpn } = makeVpn();
  assert.equal(vpn.credentialsFor({ isProxy: true, host: 'vpn.example.com', port: 443 }), null); // not connected
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); results.push([true, name]); } catch (error) { results.push([false, name, error]); }
  }
  let failed = 0;
  for (const [ok, name, error] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) { failed += 1; console.log(`     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
