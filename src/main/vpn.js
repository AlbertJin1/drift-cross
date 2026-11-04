'use strict';
// Browser-only VPN for Drift.
//
// A Drift "VPN" is an encrypted-or-authenticated proxy tunnel applied to Drift's own session
// only, so every tab, extension and download goes through it while the rest of the PC does not.
// Supported connection types:
//   https  - HTTP proxy reached over TLS (traffic to the server is encrypted), user name + password
//   http   - plain HTTP proxy, user name + password (CONNECT keeps HTTPS sites end-to-end encrypted)
//   socks5 - SOCKS5 proxy, optional user name + password. Chromium cannot sign in to SOCKS proxies
//            by itself, so when a login is set Drift runs a tiny loopback relay that does the
//            RFC 1929 sign-in upstream. Host names are resolved by the proxy (no DNS leak).
//
// Operating-system tunnels (SSTP, L2TP/IPsec, IKEv2, OpenVPN, WireGuard) need a virtual network
// adapter and cannot live inside a browser process, so they are intentionally not offered.
//
// Connections fail closed: while a VPN is connected Chromium never falls back to a direct
// connection when the proxy is unreachable, pages simply fail to load.

const net = require('net');

const TYPES = {
  https: { label: 'HTTPS proxy (encrypted)', scheme: 'https', defaultPort: 443, auth: true },
  http: { label: 'HTTP proxy', scheme: 'http', defaultPort: 8080, auth: true },
  socks5: { label: 'SOCKS5', scheme: 'socks5', defaultPort: 1080, auth: true }
};
const MAX_PROFILES = 50;
const PROBE_URL = 'https://cloudflare.com/cdn-cgi/trace';

// ---------------------------------------------------------------- validation
function cleanHost(value) {
  let host = String(value ?? '').trim();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // a pasted scheme is not part of the address
  host = host.replace(/\/.*$/, '');
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'));
  else if ((host.match(/:/g) || []).length === 1) host = host.split(':')[0]; // host:port pasted
  return host.replace(/\.$/, '').toLowerCase();
}

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  if (net.isIP(host)) return true;
  return /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/.test(host);
}

/** Returns { profile } or { error }. `existing` supplies values the form leaves blank (saved password). */
function validateProfile(input, existing = null) {
  const src = input && typeof input === 'object' ? input : {};
  const name = String(src.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Give the connection a name.' };
  if (name.length > 60) return { error: 'The connection name is too long (60 characters at most).' };

  const type = String(src.type ?? '');
  if (!Object.hasOwn(TYPES, type)) return { error: 'Choose a VPN type.' };

  const server = cleanHost(src.server);
  if (!isValidHost(server)) return { error: 'Enter a valid server name or IP address, for example vpn.example.com.' };

  const portNumber = Number(src.port === '' || src.port == null ? TYPES[type].defaultPort : src.port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return { error: 'The port must be a number from 1 to 65535.' };

  const signIn = src.signIn === 'none' ? 'none' : 'password';
  let username = '';
  let password = null; // null = keep what is stored, '' = none
  if (signIn === 'password') {
    username = String(src.username ?? '');
    if (username.length > 255) return { error: 'The user name is too long.' };
    if (!username) return { error: 'Enter the user name, or set sign-in to “None”.' };
    if (typeof src.password === 'string' && src.password !== '') {
      if (src.password.length > 255) return { error: 'The password is too long.' };
      password = src.password;
    } else if (!existing?.hasPassword || existing.signIn === 'none') password = ''; // nothing stored yet
  } else password = '';
  // SOCKS5 user names/passwords are length-prefixed with a single byte.
  if (type === 'socks5' && (Buffer.byteLength(username) > 255 || Buffer.byteLength(password || '') > 255)) {
    return { error: 'SOCKS5 sign-in details can be at most 255 bytes.' };
  }

  return {
    profile: {
      name, type, server, port: portNumber, signIn,
      username: signIn === 'password' ? username : '',
      remember: signIn === 'password' ? src.remember !== false : false
    },
    password // null keeps the stored secret
  };
}

/** What Chromium needs for a profile; `relayPort` replaces the upstream for authenticated SOCKS5. */
function buildProxyConfig(profile, relayPort = 0) {
  const t = TYPES[profile.type];
  const hostPart = net.isIPv6(profile.server) ? `[${profile.server}]` : profile.server;
  const rules = relayPort ? `socks5://127.0.0.1:${relayPort}` : `${t.scheme}://${hostPart}:${profile.port}`;
  return { mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<local>' };
}

// ---------------------------------------------------------------- SOCKS5 relay (adds sign-in)
class ByteReader {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.waiters = []; this.error = null; this.ended = false;
    this.onData = (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this.flush(); };
    const finish = (error) => { this.ended = true; this.error = error || this.error; this.flush(); };
    socket.on('data', this.onData);
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', finish);
  }
  flush() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.buf.length >= waiter.n) {
        this.waiters.shift();
        const out = Buffer.from(this.buf.subarray(0, waiter.n));
        this.buf = this.buf.subarray(waiter.n);
        waiter.resolve(out);
      } else if (this.ended) {
        this.waiters.shift();
        waiter.reject(this.error || new Error('Connection closed'));
      } else break;
    }
  }
  read(n) { return new Promise((resolve, reject) => { this.waiters.push({ n, resolve, reject }); this.flush(); }); }
  detach() { this.socket.off('data', this.onData); const rest = this.buf; this.buf = Buffer.alloc(0); return rest; }
}

async function readSocksAddress(reader, atyp) {
  if (atyp === 1) return reader.read(4 + 2);
  if (atyp === 4) return reader.read(16 + 2);
  if (atyp === 3) {
    const len = await reader.read(1);
    const rest = await reader.read(len[0] + 2);
    return Buffer.concat([len, rest]);
  }
  throw new Error('Unsupported address type');
}

const SOCKS_FAIL = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

async function handleRelayClient(client, upstream) {
  const { host, port, username, password, connect = net.connect } = upstream;
  client.setNoDelay(true);
  client.setTimeout(20000, () => client.destroy());
  const reader = new ByteReader(client);
  let remote = null;
  try {
    // 1. Greeting from Chromium: no authentication needed on the loopback side.
    const head = await reader.read(2);
    if (head[0] !== 5) throw new Error('Not a SOCKS5 client');
    await reader.read(head[1]);
    client.write(Buffer.from([5, 0]));

    // 2. The request itself (only CONNECT is meaningful for a browser).
    const req = await reader.read(4);
    const addr = await readSocksAddress(reader, req[3]);
    if (req[1] !== 1) { client.end(SOCKS_FAIL(7)); return; }
    const request = Buffer.concat([req, addr]);

    // 3. Upstream: negotiate and sign in.
    remote = connect({ host, port });
    remote.setNoDelay(true);
    remote.setTimeout(20000, () => remote.destroy());
    const upReader = new ByteReader(remote);
    await new Promise((resolve, reject) => { remote.once('connect', resolve); remote.once('error', reject); });
    remote.write(Buffer.from(username ? [5, 2, 0, 2] : [5, 1, 0]));
    const choice = await upReader.read(2);
    if (choice[0] !== 5 || choice[1] === 0xff) throw Object.assign(new Error('The server accepts none of the sign-in methods.'), { socksAuth: true });
    if (choice[1] === 2) {
      const u = Buffer.from(username || ''); const p = Buffer.from(password || '');
      remote.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const status = await upReader.read(2);
      if (status[1] !== 0) throw Object.assign(new Error('The server rejected the username or password.'), { socksAuth: true });
    }
    remote.write(request);
    const reply = await upReader.read(4);
    const replyAddr = await readSocksAddress(upReader, reply[3]);
    client.write(Buffer.concat([reply, replyAddr]));
    if (reply[1] !== 0) { client.end(); remote.destroy(); return; }

    // 4. Tunnel established: hand both sockets to pipe().
    const fromClient = reader.detach(); const fromRemote = upReader.detach();
    client.setTimeout(0); remote.setTimeout(0);
    if (fromRemote.length) client.write(fromRemote);
    if (fromClient.length) remote.write(fromClient);
    client.pipe(remote); remote.pipe(client);
    const close = () => { client.destroy(); remote.destroy(); };
    client.on('error', close); remote.on('error', close);
    client.on('close', close); remote.on('close', close);
  } catch (error) {
    if (!client.destroyed) client.end(SOCKS_FAIL(error?.socksAuth ? 2 : 1));
    remote?.destroy();
    upstream.onError?.(error);
  }
}

/** Starts a loopback SOCKS5 server on a random port that forwards to an authenticated SOCKS5 proxy. */
function startSocksRelay(upstream) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((client) => {
      sockets.add(client); client.on('close', () => sockets.delete(client));
      client.on('error', () => {});
      handleRelayClient(client, upstream);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', () => {});
      resolve({
        port: server.address().port,
        close: () => { server.close(); for (const s of sockets) s.destroy(); sockets.clear(); }
      });
    });
  });
}

// ---------------------------------------------------------------- errors
function friendlyError(error, authFailed) {
  if (authFailed) return 'The server rejected the username or password.';
  const text = String(error?.message || error || '');
  if (error?.socksAuth) return text;
  if (/PROXY_AUTH|407|TUNNEL_CONNECTION_FAILED/i.test(text)) return 'The server rejected the username or password, or does not allow this connection.';
  if (/NAME_NOT_RESOLVED/i.test(text)) return 'The server name could not be found. Check the address.';
  if (/CONNECTION_REFUSED/i.test(text)) return 'The server refused the connection. Check the address and port.';
  if (/TIMED_OUT|timeout/i.test(text)) return 'The server did not respond in time.';
  if (/CERT|SSL|TLS/i.test(text)) return 'The server’s security certificate could not be verified.';
  if (/NO_SUPPORTED_PROXIES|PROXY_CONNECTION_FAILED|CONNECTION_CLOSED|CONNECTION_RESET/i.test(text)) return 'Could not connect to the VPN server. Check the type, address and port.';
  return 'Could not connect to the VPN server.';
}

// ---------------------------------------------------------------- controller
function createVpn({ getSession, net: electronNet, safeStorage, readJson, writeJson, onChange = () => {}, log = console }) {
  const FILE = 'vpn.json';
  let profiles = [];
  let activeId = null;
  let status = 'disconnected'; // disconnected | connecting | connected | error
  let error = '';
  let errorId = '';
  let exitIp = '';
  let relay = null;
  let secret = null;           // { username, password } of the connected profile, memory only
  let authTries = 0;
  let authFailed = false;
  let busy = Promise.resolve();

  // Electron deprecated the synchronous isEncryptionAvailable(): use the async check when it exists and cache the
  // answer (it resolves within milliseconds of startup); older Electron builds and test fakes keep the sync check.
  let encryptionAvailable = false;
  try {
    if (typeof safeStorage?.isAsyncEncryptionAvailable === 'function') {
      Promise.resolve(safeStorage.isAsyncEncryptionAvailable()).then((ok) => { encryptionAvailable = !!ok; }).catch(() => {});
    } else {
      encryptionAvailable = !!safeStorage?.isEncryptionAvailable?.();
    }
  } catch { encryptionAvailable = false; }
  const canEncrypt = () => encryptionAvailable;
  const encrypt = (text) => (text ? safeStorage.encryptString(text).toString('base64') : '');
  const decrypt = (blob) => { try { return blob ? safeStorage.decryptString(Buffer.from(blob, 'base64')) : ''; } catch { return ''; } };

  function load() {
    const data = readJson(FILE, { profiles: [] });
    profiles = (Array.isArray(data?.profiles) ? data.profiles : []).filter((p) => p && p.id && Object.hasOwn(TYPES, p.type)).slice(0, MAX_PROFILES);
  }
  const persist = () => writeJson(FILE, { version: 1, profiles });
  const find = (id) => profiles.find((p) => p.id === id);

  function publicState() {
    return {
      status, error, errorId, exitIp, activeId,
      canStorePasswords: canEncrypt(),
      types: Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, defaultPort: t.defaultPort })),
      profiles: profiles.map((p) => ({
        id: p.id, name: p.name, type: p.type, server: p.server, port: p.port, signIn: p.signIn,
        username: p.username || '', remember: !!p.remember, hasPassword: !!p.pw
      }))
    };
  }

  function save(input) {
    const id = typeof input?.id === 'string' ? input.id : '';
    const existing = id ? find(id) : null;
    if (id && !existing) return { error: 'That connection no longer exists.' };
    if (!existing && profiles.length >= MAX_PROFILES) return { error: 'You can keep up to 50 connections.' };
    const checked = validateProfile(input, existing ? { ...existing, hasPassword: !!existing.pw } : null);
    if (checked.error) return { error: checked.error };
    if (profiles.some((p) => p.id !== id && p.name.toLowerCase() === checked.profile.name.toLowerCase())) return { error: 'You already have a connection with that name.' };

    const next = { ...(existing || {}), ...checked.profile, id: existing?.id || `vpn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
    if (checked.profile.signIn === 'none' || !checked.profile.remember) next.pw = '';
    else if (checked.password) {
      if (!canEncrypt()) return { error: 'This computer cannot encrypt saved passwords. Untick “Remember my sign-in info” to be asked each time.' };
      next.pw = encrypt(checked.password);
    } // else keep the stored password
    if (existing) Object.assign(existing, next); else profiles.push(next);
    persist();
    if (activeId === next.id && status !== 'disconnected') disconnect(); // settings changed: drop the old tunnel
    onChange();
    return { ok: true, id: next.id };
  }

  function remove(id) {
    if (!find(id)) return { ok: true };
    if (activeId === id) disconnect();
    profiles = profiles.filter((p) => p.id !== id);
    persist(); onChange();
    return { ok: true };
  }

  const ses = () => getSession();

  async function teardown() {
    try { relay?.close(); } catch { /* already closed */ }
    relay = null; secret = null; activeId = null; exitIp = '';
    try { await ses().setProxy({ mode: 'system' }); await ses().closeAllConnections(); } catch (e) { log.warn?.('Drift VPN: could not restore proxy settings:', e?.message || e); }
  }

  function probe() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const request = electronNet.request({ method: 'GET', url: PROBE_URL, session: ses(), useSessionCookies: false });
      const timer = setTimeout(() => { try { request.abort(); } catch { /* gone */ } done(reject, new Error('timeout')); }, 15000);
      request.on('login', (info, callback) => {
        if (!info?.isProxy || !secret?.username || ++authTries > 1) { authFailed = true; callback(); return; }
        callback(secret.username, secret.password);
      });
      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => { if (body.length < 4096) body += chunk.toString(); });
        response.on('end', () => {
          if (response.statusCode >= 400) return done(reject, new Error(`HTTP ${response.statusCode}`));
          done(resolve, (body.match(/^ip=(.+)$/m) || [])[1]?.trim() || '');
        });
        response.on('error', (e) => done(reject, e));
      });
      request.on('error', (e) => done(reject, e));
      request.end();
    });
  }

  function connect(id, { password } = {}) {
    busy = busy.then(() => doConnect(id, password)).catch(() => {});
    return busy.then(() => publicState());
  }

  async function doConnect(id, providedPassword) {
    const profile = find(id);
    if (!profile) { error = 'That connection no longer exists.'; status = 'error'; onChange(); return; }
    if (status !== 'disconnected') await teardown();
    status = 'connecting'; error = ''; errorId = ''; exitIp = ''; authTries = 0; authFailed = false; activeId = id;
    onChange();
    try {
      const pass = profile.signIn === 'password' ? (providedPassword ?? decrypt(profile.pw)) : '';
      if (profile.signIn === 'password' && !pass) throw Object.assign(new Error('A password is needed.'), { needsPassword: true });
      secret = profile.signIn === 'password' ? { username: profile.username, password: pass } : null;

      let relayPort = 0;
      if (profile.type === 'socks5' && secret) {
        relay = await startSocksRelay({ host: profile.server, port: profile.port, username: secret.username, password: secret.password, onError: (e) => { if (e?.socksAuth) authFailed = true; } });
        relayPort = relay.port;
      }
      await ses().setProxy(buildProxyConfig(profile, relayPort));
      await ses().closeAllConnections(); // keep-alive sockets opened before the VPN must not survive it
      exitIp = await probe();
      status = 'connected';
      authTries = 0;
    } catch (e) {
      const needsPassword = !!e?.needsPassword;
      const message = needsPassword ? 'A password is needed to connect.' : friendlyError(e, authFailed);
      await teardown();
      status = 'error'; error = message; errorId = id;
      log.warn?.(`Drift VPN: connection to “${profile.name}” failed: ${e?.message || e}`);
    }
    onChange();
  }

  function disconnect() {
    busy = busy.then(async () => {
      await teardown();
      status = 'disconnected'; error = ''; errorId = '';
      onChange();
    }).catch(() => {});
    return busy.then(() => publicState());
  }

  /** For app.on('login'): answers a proxy sign-in request for the connected profile only. */
  function credentialsFor(authInfo) {
    const profile = activeId ? find(activeId) : null;
    if (!profile || !secret || !authInfo?.isProxy || profile.type === 'socks5') return null;
    if (String(authInfo.host || '').toLowerCase() !== profile.server || Number(authInfo.port) !== profile.port) return null;
    if (++authTries > 3) { authFailed = true; return null; } // wrong password: stop instead of looping
    return { username: secret.username, password: secret.password };
  }

  return {
    load, save, remove, connect, disconnect, publicState, credentialsFor,
    isConnected: () => status === 'connected',
    isActive: () => status === 'connected' || status === 'connecting',
    shutdown: () => { try { relay?.close(); } catch { /* ignore */ } }
  };
}

module.exports = { TYPES, validateProfile, buildProxyConfig, cleanHost, isValidHost, startSocksRelay, friendlyError, createVpn };
