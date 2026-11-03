'use strict';

// VPN Gate's public CSV is a server directory, not a proxy API. Drift converts a
// compatible inline OpenVPN profile into a private userspace tunnel and applies
// its loopback SOCKS5 bridge only to the browser session. Profile hooks are never
// executed, and system routes or adapters are never modified.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const netAddress = require('node:net');

const API_URL = 'https://www.vpngate.net/api/iphone/';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_PROFILE_BYTES = 1024 * 1024;
const ALLOWED_BLOCKS = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2']);
const ALLOWED_DIRECTIVES = new Set([
  'client', 'dev', 'proto', 'remote', 'resolv-retry', 'nobind', 'persist-key',
  'persist-tun', 'cipher', 'auth', 'auth-nocache', 'auth-user-pass', 'verb',
  'mute', 'remote-cert-tls', 'reneg-sec', 'key-direction', 'tls-version-min',
  'data-ciphers', 'data-ciphers-fallback', 'explicit-exit-notify', 'connect-retry',
  'connect-retry-max', 'connect-timeout', 'ping', 'ping-restart', 'ping-exit',
  'float', 'keepalive', 'comp-lzo', 'compress', 'allow-compression',
  'setenv', 'ignore-unknown-option', 'tls-auth', 'verify-x509-name'
]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((part) => String(part).trim() !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((part) => String(part).trim() !== '')) rows.push(row);
  }
  return rows;
}

function finiteNumber(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.+-]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeServerHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.length > 253 || /[^a-z0-9.:-]/.test(host)) return false;
  if (host.includes(':')) return /^[0-9a-f:]+$/i.test(host); // IPv6 literal
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host);
}

function decodeProfile(encoded) {
  const compact = String(encoded || '').replace(/\s+/g, '');
  if (!compact || compact.length > Math.ceil(MAX_PROFILE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return '';
  let decoded;
  try { decoded = Buffer.from(compact, 'base64'); } catch { return ''; }
  if (!decoded.length || decoded.length > MAX_PROFILE_BYTES) return '';
  const text = decoded.toString('utf8');
  if (text.includes('\u0000') || text.includes('\uFFFD')) return '';
  return text;
}

/**
 * The Drift helper is based on an OpenVPN3-compatible userspace client. Unlike
 * the previous AEAD-only engine, it supports standard VPN Gate TLS profiles
 * using AES-CBC + HMAC, optional inline tls-auth/tls-crypt keys, or an unwrapped
 * TLS control channel. Profiles still remain subject to a conservative
 * compatibility gate: no BF-CBC, compression, TAP, tls-crypt-v2 or external
 * key-file references. Script hooks are removed and never executed.
 */
function inspectOpenVpnCompatibility(profile) {
  const source = String(profile || '');
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  const failures = [];
  const cipherLines = lines.filter((line) => /^(?:cipher|data-ciphers|data-ciphers-fallback)\s+/i.test(line));
  const supportedCiphers = new Set([
    'AES-128-GCM', 'AES-192-GCM', 'AES-256-GCM',
    'AES-128-CBC', 'AES-192-CBC', 'AES-256-CBC'
  ]);
  for (const line of cipherLines) {
    const match = line.match(/^(?:cipher|data-ciphers|data-ciphers-fallback)\s+(.+)$/i);
    if (!match) continue;
    const values = match[1].split(/[,\s:]+/).filter(Boolean).map((value) => value.toUpperCase());
    if (values.some((value) => !supportedCiphers.has(value))) {
      failures.push(`unsupported data cipher: ${values.find((value) => !supportedCiphers.has(value))}`);
      break;
    }
    if (/^data-ciphers(?:-fallback)?\s+/i.test(line)) {
      failures.push('this profile uses data-ciphers negotiation directives not implemented by the pinned helper');
      break;
    }
  }
  const authLine = lines.find((line) => /^auth\s+/i.test(line));
  if (authLine) {
    const digest = authLine.replace(/^auth\s+/i, '').trim().toUpperCase();
    if (!['SHA1', 'SHA256', 'SHA512'].includes(digest)) {
      failures.push(`unsupported CBC HMAC digest: ${digest || '(empty)'}`);
    }
  }
  for (const line of lines.filter((entry) => /^(?:comp-lzo|compress)\b/i.test(entry))) {
    const [, directive, ...parts] = line.match(/^(comp-lzo|compress)\b\s*(.*)$/i) || [];
    const option = String(parts.join(' ') || '').trim().toLowerCase();
    const disabledOrStub = directive?.toLowerCase() === 'comp-lzo'
      ? option === 'no'
      : directive?.toLowerCase() === 'compress' && ['stub', 'stub-v2'].includes(option);
    if (!disabledOrStub) {
      failures.push('this profile enables legacy VPN-link compression; Drift blocks it because compression can expose information about encrypted traffic');
      break;
    }
  }
  for (const line of lines.filter((entry) => /^allow-compression\b/i.test(entry))) {
    const mode = line.replace(/^allow-compression\s*/i, '').trim().toLowerCase();
    if (!['no', 'asym'].includes(mode)) {
      failures.push('allow-compression must be set to no or asym for Drift to accept this profile');
      break;
    }
  }
  if (/^\s*dev\s+tap\b/im.test(source)) failures.push('TAP profiles are not supported; this engine requires TUN/IP mode');
  if (/^\s*secret\s+/im.test(source)) failures.push('static-key profiles are not supported; TLS client profiles are required');
  // Inline tls-auth and tls-crypt are supported by the pinned OpenVPN
  // implementation. File-path forms are rejected because Drift deliberately
  // exports one self-contained sanitized .ovpn file and never resolves
  // arbitrary sidecar key paths from a downloaded profile.
  const hasInlineTlsAuth = /<tls-auth>[\s\S]*?<\/tls-auth>/i.test(source);
  const hasInlineTlsCrypt = /<tls-crypt>[\s\S]*?<\/tls-crypt>/i.test(source);
  if (/^[ \t]*tls-auth[ \t]+\S+/im.test(source) && !hasInlineTlsAuth) failures.push('tls-auth references an external key file; only inline keys are supported');
  if (/^[ \t]*tls-crypt[ \t]+\S+/im.test(source) && !hasInlineTlsCrypt) failures.push('tls-crypt references an external key file; only inline keys are supported');
  if (hasInlineTlsAuth && hasInlineTlsCrypt) failures.push('this helper cannot combine tls-auth and tls-crypt in one profile');
  if (/^[ \t]*tls-crypt-v2[ \t]+/im.test(source) || /<tls-crypt-v2>[\s\S]*?<\/tls-crypt-v2>/i.test(source)) failures.push('tls-crypt-v2 profiles are not supported by this helper build');
  if (/^[ \t]*(?:cert|key)[ \t]+\S+/im.test(source)) failures.push('client certificate and key file paths are unsupported; embedded certificate blocks are required');
  if (/^[ \t]*auth-user-pass[ \t]+\S+/im.test(source)) failures.push('external username/password files are unsupported; VPN Gate shared credentials are supplied by Drift');
  if (!/^\s*client\s*$/im.test(source)) failures.push('profile is not an OpenVPN client configuration');
  if (!/<ca>[\s\S]*?<\/ca>/i.test(source)) failures.push('profile has no inline CA certificate');
  if (!/^\s*remote\s+\S+\s+\d{1,5}(?:\s+(?:udp|tcp|tcp-client))?\s*$/im.test(source)) failures.push('profile has no supported remote endpoint');
  if (/^\s*proto\s+(?!udp\s*$|tcp\s*$|tcp-client\s*$)/im.test(source)) failures.push('profile uses an unsupported OpenVPN transport protocol');
  if (failures.length) return { supported: false, reason: failures[0], reasons: failures };
  return { supported: true, reason: '', reasons: [] };
}

function parseServerList(csvText) {
  const rows = parseCsv(csvText);
  const headerIndex = rows.findIndex((row) => String(row[0] || '').trim().replace(/^#/, '').toLowerCase() === 'hostname');
  if (headerIndex < 0) throw new Error('VPN Gate returned an unrecognized server list.');
  const headers = rows[headerIndex].map((item) => String(item || '').trim().replace(/^#/, '').toLowerCase());
  const index = Object.fromEntries(headers.map((name, i) => [name, i]));
  const required = ['hostname', 'ip', 'countrylong', 'countryshort', 'openvpn_configdata_base64'];
  if (required.some((key) => index[key] == null)) throw new Error('VPN Gate server data is missing required fields.');

  const servers = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const hostName = String(row[index.hostname] || '').trim();
    const ip = String(row[index.ip] || '').trim();
    const country = String(row[index.countrylong] || '').trim();
    const countryCode = String(row[index.countryshort] || '').trim().toUpperCase();
    const profile = decodeProfile(row[index.openvpn_configdata_base64]);
    if (!hostName || !safeServerHost(hostName) || netAddress.isIP(ip) === 0 || !country || !/^[A-Z]{2}$/.test(countryCode) || !profile) continue;

    const id = `${ip}-${hostName}`.toLowerCase();
    const speedRaw = finiteNumber(row[index.speed]);
    const ping = finiteNumber(row[index.ping]);
    const sessions = finiteNumber(row[index.numvpnsessions]);
    const score = finiteNumber(row[index.score]);
    const speedMbps = speedRaw == null ? null : Math.round((speedRaw / 1000000) * 10) / 10;
    const remote = profile.match(/^[ \t]*remote[ \t]+(\S+)[ \t]+(\d{1,5})(?:[ \t]+(\S+))?/im);
    const port = remote && Number(remote[2]) >= 1 && Number(remote[2]) <= 65535 ? Number(remote[2]) : null;
    const proto = String(remote?.[3] || profile.match(/^\s*proto\s+(\S+)/im)?.[1] || '').toLowerCase();
    if (!port || !['udp', 'tcp', 'tcp-client'].includes(proto)) continue;

    const compatibility = inspectOpenVpnCompatibility(profile);
    servers.push({
      id, hostName, ip, country, countryCode,
      score, pingMs: ping, speedMbps, sessions,
      uptime: finiteNumber(row[index.uptime]),
      operator: String(row[index.operator] || '').slice(0, 100),
      port, protocol: proto.startsWith('tcp') ? 'TCP' : 'UDP',
      profileSupported: compatibility.supported,
      engineSupported: compatibility.supported,
      engineReason: compatibility.reason,
      // The profile remains in the main process; it is not sent to renderer JS.
      _profile: profile
    });
  }
  servers.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.speedMbps ?? -1) - (a.speedMbps ?? -1));
  return servers;
}

function sanitizeOpenVpnProfile(raw, expectedHosts = [], selectedEndpoint = null) {
  const source = String(raw ?? '');
  if (!source || Buffer.byteLength(source, 'utf8') > MAX_PROFILE_BYTES || source.includes('\u0000')) {
    throw new Error('The OpenVPN profile is empty or too large.');
  }

  const endpoint = selectedEndpoint && typeof selectedEndpoint === 'object' ? selectedEndpoint : null;
  const endpointIp = endpoint && netAddress.isIP(String(endpoint.ip || '').trim()) ? String(endpoint.ip).trim() : '';
  const endpointPort = endpoint ? Number(endpoint.port) : 0;
  const endpointProtocol = endpoint ? String(endpoint.protocol || '').toUpperCase() : '';
  const endpointProto = endpointProtocol === 'TCP' ? 'tcp-client' : 'udp';
  if (endpoint && (!endpointIp || !Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535 || !['TCP', 'UDP'].includes(endpointProtocol))) {
    throw new Error('VPN Gate supplied an invalid IP address or OpenVPN port for this relay.');
  }

  const output = [];
  const seen = new Set();
  const allowedHosts = new Set((Array.isArray(expectedHosts) ? expectedHosts : []).map((host) => String(host || '').toLowerCase()));
  let inBlock = '';
  let keepBlock = false;
  let hasClient = false;
  let hasRemote = false;
  let hasCa = false;
  let hasAuth = false;
  let hasProto = false;

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const open = line.match(/^<([a-z0-9-]+)>$/i);
    const close = line.match(/^<\/([a-z0-9-]+)>$/i);
    if (open && !inBlock) {
      inBlock = open[1].toLowerCase();
      keepBlock = ALLOWED_BLOCKS.has(inBlock);
      if (keepBlock) {
        output.push(`<${inBlock}>`);
        if (inBlock === 'ca') hasCa = true;
      }
      continue;
    }
    if (close && inBlock && close[1].toLowerCase() === inBlock) {
      if (keepBlock) output.push(`</${inBlock}>`);
      inBlock = ''; keepBlock = false;
      continue;
    }
    if (inBlock) {
      if (keepBlock) {
        if (/^[\x20-\x7e\t]+$/.test(rawLine)) output.push(rawLine);
        else throw new Error('The OpenVPN profile contains invalid certificate data.');
      }
      continue;
    }

    const match = line.match(/^([a-z][a-z0-9-]*)(?:\s+(.*))?$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const args = String(match[2] || '').trim();
    if (!ALLOWED_DIRECTIVES.has(key)) continue; // drops scripts, plugins, includes, shell hooks and route changes
    if (key === 'client') hasClient = true;
    if (key === 'remote') {
      const parts = args.split(/\s+/);
      const remotePort = parts.length >= 2 && /^\d{1,5}$/.test(parts[1]) ? Number(parts[1]) : 0;
      if (parts.length < 2 || !safeServerHost(parts[0]) || remotePort < 1 || remotePort > 65535) continue;
      if (parts[2] && !/^(udp|tcp|tcp-client)$/i.test(parts[2])) continue;
      if (endpoint) {
        // VPN Gate itself recommends IP-based .ovpn profiles where opengw.net
        // DNS is blocked. Pin the remote to the IP and port in its live CSV
        // row, not the hostname embedded in the downloaded profile.
        if (!hasRemote) output.push(`remote ${endpointIp} ${endpointPort}`);
        hasRemote = true;
      } else {
        if (allowedHosts.size && !allowedHosts.has(parts[0].toLowerCase())) continue;
        if (!hasRemote) output.push(`remote ${parts[0]} ${remotePort}${parts[2] ? ` ${parts[2].toLowerCase()}` : ''}`);
        hasRemote = true;
      }
      continue;
    }
    if (key === 'auth-user-pass') { output.push('auth-user-pass'); hasAuth = true; continue; }
    if (key === 'proto') {
      const proto = endpoint ? endpointProto : args.toLowerCase() === 'tcp' ? 'tcp-client' : args.toLowerCase();
      if (!/^(udp|tcp-client)$/.test(proto)) continue;
      if (!hasProto) output.push(`proto ${proto}`);
      hasProto = true;
      continue;
    }
    // External static-key paths cannot be shipped safely as a single-file relay.
    if (key === 'tls-auth' && args) continue;
    if (key === 'dev' && !/^tun(?:\s+\d+)?$/i.test(args)) continue;
    if (key === 'setenv' && !/^opt\s+block-outside-dns$/i.test(args)) continue;
    if (key === 'ignore-unknown-option' && !/^(data-ciphers|data-ciphers-fallback)$/i.test(args)) continue;
    if (args.length > 512 || /[\r\n\u0000]/.test(args)) continue;
    const normalized = args ? `${key} ${args}` : key;
    // Avoid repeated directives that might produce conflicting connection behavior.
    if (['client', 'dev', 'proto', 'auth-user-pass'].includes(key) && seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  if (inBlock) throw new Error('The OpenVPN profile contains an incomplete certificate block.');
  if (!hasClient || !hasRemote || !hasCa) throw new Error('The VPN Gate profile is missing required OpenVPN client, server, or CA settings.');
  if (endpoint && !hasProto) output.splice(1, 0, `proto ${endpointProto}`);
  if (!hasAuth) output.push('auth-user-pass'); // VPN Gate publishes the shared vpn / vpn credentials.
  output.push('', '# VPN Gate public relay credentials: username vpn / password vpn');
  output.push('# Remote endpoint pinned to the IP address supplied by the current VPN Gate directory row.');
  output.push('# Volunteer-operated server. Review the operator and VPN Gate policies before connecting.');
  return `${output.join('\n')}\n`;
}

function requestText(electronNet, url = API_URL) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    let body = '';
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const request = electronNet.request({ method: 'GET', url });
    request.setHeader('User-Agent', 'Drift Browser VPN Gate directory/1.0');
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume?.();
        finish(reject, new Error(`VPN Gate returned HTTP ${response.statusCode}.`));
        return;
      }
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          request.abort();
          finish(reject, new Error('VPN Gate server list exceeded the allowed size.'));
          return;
        }
        body += chunk.toString('utf8');
      });
      response.on('end', () => finish(resolve, body));
      response.on('error', (error) => finish(reject, error));
    });
    request.on('error', (error) => finish(reject, error));
    const timer = setTimeout(() => {
      try { request.abort(); } catch { /* request already closed */ }
      finish(reject, new Error('VPN Gate did not respond in time.'));
    }, 30000);
    request.end();
  });
}

function createVpnGate({
  net, dialog, app, getWindow = () => null, getSession = () => null,
  helperPath = '', spawn = childProcess.spawn, probe = null,
  log = console, onChange = () => {}
}) {
  let servers = [];
  let fetchedAt = 0;
  const byId = new Map();
  let helper = null;
  let tempDirectory = '';
  let connectingToken = 0;
  let localPort = 0;
  let state = {
    status: 'disconnected', error: '', serverId: '', name: '', country: '', countryCode: '',
    exitIp: '', localPort: 0, startedAt: 0
  };

  const publish = () => { try { onChange(publicState()); } catch { /* UI notification must not break the tunnel */ } };
  const publicState = () => ({ ...state });
  const getHelperPath = () => {
    if (helperPath) return helperPath;
    const binary = process.platform === 'win32' ? 'openvpn2socks.exe' : 'openvpn2socks';
    const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'vpn', binary) : '';
    const development = path.resolve(__dirname, '..', '..', 'resources', 'vpn', binary);
    if (packaged && fs.existsSync(packaged)) return packaged;
    return development;
  };

  async function list({ force = false } = {}) {
    if (!force && servers.length && Date.now() - fetchedAt < 60_000) {
      return { servers: servers.map(({ _profile, ...item }) => item), fetchedAt };
    }
    const csv = await requestText(net);
    const parsed = parseServerList(csv);
    if (!parsed.length) throw new Error('VPN Gate did not return any usable OpenVPN servers. Try refreshing later.');
    const helperAvailable = fs.existsSync(getHelperPath());
    servers = parsed.map((server) => {
      if (!server.profileSupported || helperAvailable) return server;
      return {
        ...server,
        engineSupported: false,
        engineReason: 'this OpenVPN profile is compatible, but the bundled VPN helper has not been built into this Windows package'
      };
    });
    byId.clear();
    for (const server of servers) byId.set(server.id, server);
    fetchedAt = Date.now();
    return { servers: servers.map(({ _profile, ...item }) => item), fetchedAt };
  }

  function probeExitIp() {
    if (typeof probe === 'function') return probe(getSession());
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const request = net.request({ method: 'GET', url: 'https://cloudflare.com/cdn-cgi/trace', session: getSession(), useSessionCookies: false });
      const timer = setTimeout(() => { try { request.abort(); } catch { /* already closed */ } done(reject, new Error('VPN exit-IP check timed out.')); }, 20000);
      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => { if (body.length < 4096) body += chunk.toString(); });
        response.on('end', () => {
          if (response.statusCode >= 400) return done(reject, new Error(`Exit-IP check returned HTTP ${response.statusCode}.`));
          const ip = (body.match(/^ip=(.+)$/m) || [])[1]?.trim() || '';
          done(ip ? resolve : reject, ip || new Error('Could not verify the VPN exit address.'));
        });
        response.on('error', (error) => done(reject, error));
      });
      request.on('error', (error) => done(reject, error));
      request.end();
    });
  }

  function waitForProxyPort(child, token, timeoutMs = 70_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const collect = (chunk) => {
        output = `${output}${String(chunk || '')}`.slice(-12000);
        const match = output.match(/SOCKS5 listening"?\s+addr=127\.0\.0\.1:(\d+)/i);
        if (match) finish(resolve, Number(match[1]));
        else if (/error:\s*(?:openvpn dial|profile|config|netstack)/i.test(output)) {
          finish(reject, new Error(output.trim().slice(-1600)));
        }
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) => finish(reject, error));
      child.once('exit', (code, signal) => finish(reject, new Error(`The userspace VPN engine exited before connecting (code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}). ${output.trim().slice(-1200)}`)));
      const timer = setTimeout(() => finish(reject, new Error(`VPN Gate did not establish a tunnel within ${Math.round(timeoutMs / 1000)} seconds. ${output.trim().slice(-1200)}`)), timeoutMs);
      if (token !== connectingToken) finish(reject, new Error('Connection cancelled.'));
    });
  }

  async function stopHelper({ restoreProxy = true } = {}) {
    const child = helper;
    helper = null;
    localPort = 0;
    if (child && !child.killed) {
      try { child.kill(); } catch { /* already gone */ }
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (restoreProxy) {
      try {
        const ses = getSession();
        await ses?.setProxy?.({ mode: 'system' });
        await ses?.closeAllConnections?.();
      } catch (error) { log.warn?.('Drift VPN Gate: could not restore browser proxy:', error?.message || error); }
    }
    if (tempDirectory) {
      const directory = tempDirectory;
      tempDirectory = '';
      try { await fs.promises.rm(directory, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
    }
  }

  async function disconnect() {
    connectingToken += 1;
    await stopHelper({ restoreProxy: true });
    state = { status: 'disconnected', error: '', serverId: '', name: '', country: '', countryCode: '', exitIp: '', localPort: 0, startedAt: 0 };
    publish();
    return { ok: true, state: publicState() };
  }

  async function connect(id) {
    const server = byId.get(String(id || ''));
    if (!server) return { error: 'That VPN Gate server is no longer in the list. Refresh the list and try again.' };
    if (!server.engineSupported) return { error: `This relay cannot be used by Drift’s browser-only engine: ${server.engineReason || 'unsupported OpenVPN profile'}. Choose a relay marked “Drift compatible”.` };

    const token = ++connectingToken;
    await stopHelper({ restoreProxy: true });
    const executable = getHelperPath();
    if (!fs.existsSync(executable)) {
      state = { ...state, status: 'error', error: 'Drift’s built-in OpenVPN bridge is missing. Build it with scripts\\build_vpn_helper.bat, then rebuild Drift.', serverId: server.id, name: `${server.country} VPN Gate`, country: server.country, countryCode: server.countryCode, exitIp: '', localPort: 0, startedAt: 0 };
      publish();
      return { error: state.error, state: publicState() };
    }

    state = {
      status: 'connecting', error: '', serverId: server.id,
      name: `${server.country} · ${server.hostName}`, country: server.country,
      countryCode: server.countryCode, exitIp: '', localPort: 0, startedAt: 0
    };
    publish();

    try {
      const safeProfile = sanitizeOpenVpnProfile(server._profile, [server.hostName, server.ip], { ip: server.ip, port: server.port, protocol: server.protocol });
      tempDirectory = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'drift-vpngate-'));
      const profilePath = path.join(tempDirectory, 'server.ovpn');
      await fs.promises.writeFile(profilePath, safeProfile, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

      // The helper is a separate, loopback-only userspace tunnel process. It
      // implements OpenVPN + gVisor netstack and does not open a TUN adapter,
      // install routes, request elevation, or alter other applications.
      const child = spawn(executable, [
        '-config', profilePath,
        '-listen', '127.0.0.1:0'
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OVPN_USER: 'vpn', OVPN_PASS: 'vpn' }
      });
      helper = child;
      child.once('exit', (code, signal) => {
        if (helper !== child) return;
        helper = null;
        // Keep Chromium pointed at the now-dead loopback proxy. This is a
        // fail-closed state: do not silently switch browsing to the direct ISP
        // connection when the VPN process drops.
        state = {
          ...state, status: 'error',
          error: `The VPN Gate tunnel stopped unexpectedly (code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}). Disconnect to resume direct browsing or reconnect.`,
          exitIp: ''
        };
        publish();
      });

      const port = await waitForProxyPort(child, token);
      if (token !== connectingToken) throw new Error('Connection cancelled.');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The VPN engine returned an invalid local proxy port.');
      localPort = port;

      const ses = getSession();
      if (!ses?.setProxy) throw new Error('Drift could not access its browser network session.');
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '' });
      await ses.closeAllConnections?.();
      if (token !== connectingToken) throw new Error('Connection cancelled.');

      const exitIp = await probeExitIp();
      if (token !== connectingToken) throw new Error('Connection cancelled.');
      state = { ...state, status: 'connected', error: '', exitIp, localPort: port, startedAt: Date.now() };
      publish();
      return { ok: true, state: publicState() };
    } catch (error) {
      const message = token !== connectingToken ? 'Connection cancelled.' : (String(error?.message || error).includes('ENOENT')
        ? 'The bundled VPN engine could not be started. Rebuild Drift with the VPN helper included.'
        : String(error?.message || error).replace(/OVPN_PASS=[^\s]+/g, 'OVPN_PASS=[hidden]').slice(0, 1800));
      await stopHelper({ restoreProxy: true });
      if (token === connectingToken) {
        state = { ...state, status: 'error', error: message, exitIp: '', localPort: 0 };
        publish();
      }
      log.warn?.(`Drift VPN Gate: connection failed for ${server.hostName}: ${message}`);
      return { error: message, state: publicState() };
    }
  }

  async function download(id) {
    const server = byId.get(String(id || ''));
    if (!server) return { error: 'That VPN Gate server is no longer in the list. Refresh the list and try again.' };
    let safeProfile;
    try { safeProfile = sanitizeOpenVpnProfile(server._profile, [server.hostName, server.ip], { ip: server.ip, port: server.port, protocol: server.protocol }); }
    catch (error) { return { error: error.message || 'The OpenVPN profile could not be prepared safely.' }; }

    const defaultName = `VPN-Gate-${server.countryCode}-${server.ip.replace(/[^0-9a-f:.]/gi, '-')}.ovpn`;
    const result = await dialog.showSaveDialog(getWindow(), {
      title: 'Save VPN Gate OpenVPN profile',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      buttonLabel: 'Save OpenVPN profile',
      filters: [{ name: 'OpenVPN profile', extensions: ['ovpn'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    try {
      await fs.promises.writeFile(result.filePath, safeProfile, { encoding: 'utf8', flag: 'w' });
      return { ok: true, filePath: result.filePath };
    } catch (error) {
      log.warn?.('Drift VPN Gate: could not write profile:', error?.message || error);
      return { error: 'Drift could not save the OpenVPN profile to that location.' };
    }
  }

  return {
    list, download, connect, disconnect, publicState,
    isActive: () => state.status === 'connecting' || state.status === 'connected' || state.status === 'error' && !!state.localPort,
    shutdown: () => {
      connectingToken += 1;
      try { helper?.kill(); } catch { /* process already stopped */ }
      helper = null;
      try { const ses = getSession(); void ses?.setProxy?.({ mode: 'system' }); } catch { /* app is exiting */ }
      if (tempDirectory) void fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
      tempDirectory = '';
    }
  };
}

module.exports = {
  API_URL, parseCsv, parseServerList, inspectOpenVpnCompatibility, sanitizeOpenVpnProfile,
  createVpnGate
};
