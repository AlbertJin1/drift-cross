'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { parseCsv, parseServerList, inspectOpenVpnCompatibility, sanitizeOpenVpnProfile, createVpnGate } = require('../src/main/vpn-gate');

const TLS_STATIC_KEY = 'a'.repeat(512);
const PROFILE = [
  'client',
  'dev tun',
  'proto tcp',
  'remote public-vpn-1.opengw.net 443',
  'resolv-retry infinite',
  'nobind',
  'persist-key',
  'persist-tun',
  'remote-cert-tls server',
  'auth-user-pass',
  'cipher AES-128-CBC',
  'auth SHA1',
  'key-direction 1',
  'verb 3',
  '<tls-auth>',
  '-----BEGIN OpenVPN Static key V1-----',
  TLS_STATIC_KEY,
  '-----END OpenVPN Static key V1-----',
  '</tls-auth>',
  'up C:/evil.cmd',
  'plugin malicious.dll',
  'route 0.0.0.0 0.0.0.0',
  '<ca>',
  '-----BEGIN CERTIFICATE-----',
  'MIIBAA==',
  '-----END CERTIFICATE-----',
  '</ca>',
  ''
].join('\n');

function makeCsv(profile = PROFILE) {
  const b64 = Buffer.from(profile, 'utf8').toString('base64');
  return [
    '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64',
    `public-vpn-1.opengw.net,219.100.37.1,90000,12,250000000,Japan,JP,42,864000,1200,5000000,1,Volunteer,"Fast, stable relay",${b64}`,
    ''
  ].join('\n');
}

const csvRows = parseCsv('a,b,"c,d","line 1\nline 2"\r\n1,2,3,4');
assert.deepEqual(csvRows[0], ['a', 'b', 'c,d', 'line 1\nline 2']);
assert.deepEqual(csvRows[1], ['1', '2', '3', '4']);

const servers = parseServerList(makeCsv());
assert.equal(servers.length, 1);
assert.equal(servers[0].country, 'Japan');
assert.equal(servers[0].countryCode, 'JP');
assert.equal(servers[0].hostName, 'public-vpn-1.opengw.net');
assert.equal(servers[0].port, 443);
assert.equal(servers[0].protocol, 'TCP');
assert.equal(servers[0].speedMbps, 250);
assert.match(servers[0]._profile, /<ca>/);
assert.equal(servers[0].engineSupported, true, 'AES-CBC + HMAC profiles with inline tls-auth are accepted');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace(/<tls-auth>[\s\S]*?<\/tls-auth>/, '').replace('key-direction 1\n', '')).supported, true, 'plain TLS control-channel profiles are accepted');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('AES-128-CBC', 'BF-CBC')).supported, false, 'Blowfish-CBC profiles are rejected');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace(/<tls-auth>[\s\S]*?<\/tls-auth>/, '').replace('key-direction 1', 'tls-auth ta.key 1\nkey-direction 1')).supported, false, 'external tls-auth key paths are rejected');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('auth SHA1', 'auth SHA384')).supported, false, 'unsupported HMAC digests are rejected');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('</tls-auth>', '</tls-auth>\n<tls-crypt>\n' + TLS_STATIC_KEY + '\n</tls-crypt>')).supported, false, 'mutually exclusive tls-auth and tls-crypt blocks are rejected');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('auth-user-pass', 'auth-user-pass credentials.txt')).supported, false, 'external credentials files are rejected');
const TLS_CRYPT_PROFILE = PROFILE
  .replace('key-direction 1\n', '')
  .replace('<tls-auth>', '<tls-crypt>')
  .replace('</tls-auth>', '</tls-crypt>');
assert.equal(inspectOpenVpnCompatibility(TLS_CRYPT_PROFILE).supported, true, 'inline tls-crypt profiles are accepted');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('AES-128-CBC', 'AES-256-GCM')).supported, true, 'AES-GCM profiles are accepted');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('auth SHA1', 'auth SHA1\ncomp-lzo')).supported, false, 'active compression profiles are rejected');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('auth SHA1', 'auth SHA1\ncomp-lzo no')).supported, true, 'profiles that explicitly disable compression are accepted');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('auth SHA1', 'auth SHA1\ncompress stub-v2')).supported, true, 'non-compressing stub framing is accepted');
assert.equal(inspectOpenVpnCompatibility(PROFILE.replace('auth SHA1', 'auth SHA1\ndata-ciphers AES-256-GCM:AES-128-GCM')).supported, false, 'unimplemented data-cipher negotiation is rejected');

assert.throws(() => parseServerList('not a VPN Gate CSV'), /unrecognized server list/);
assert.equal(parseServerList(makeCsv(PROFILE.replace('remote public-vpn-1.opengw.net 443', 'remote invalid host 443'))).length, 0);

const sanitized = sanitizeOpenVpnProfile(PROFILE);
assert.match(sanitized, /client/);
assert.match(sanitized, /remote public-vpn-1\.opengw\.net 443/);
assert.match(sanitized, /cipher AES-128-CBC/);
assert.match(sanitized, /<tls-auth>/);
assert.match(sanitized, new RegExp(TLS_STATIC_KEY));
assert.match(sanitized, /<ca>/);
assert.match(sanitized, /auth-user-pass/);
assert.doesNotMatch(sanitized, /evil\.cmd|malicious\.dll|^route\s/m);
const pinnedSanitized = sanitizeOpenVpnProfile(PROFILE, ['public-vpn-1.opengw.net', '219.100.37.1'], { ip: '219.100.37.1', port: 443, protocol: 'TCP' });
assert.match(pinnedSanitized, /remote 219\.100\.37\.1 443/);
assert.match(pinnedSanitized, /^proto tcp-client$/m);
assert.doesNotMatch(pinnedSanitized, /opengw\.net/);
assert.throws(() => sanitizeOpenVpnProfile(PROFILE.replace(/<ca>[\s\S]*?<\/ca>/, '')), /missing required/);
assert.doesNotMatch(sanitizeOpenVpnProfile(PROFILE.replace('remote public-vpn-1.opengw.net 443', 'remote public-vpn-1.opengw.net 443\nremote attacker.example 443'), ['public-vpn-1.opengw.net', '219.100.37.1']), /attacker\.example/);
assert.throws(() => sanitizeOpenVpnProfile(PROFILE.replace('</ca>', '')), /incomplete certificate/);

async function testDirectoryWorkflow() {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'drift-vpngate-'));
  const profilePath = path.join(temp, 'relay.ovpn');
  const csv = makeCsv();
  const fakeNet = {
    request() {
      const request = new EventEmitter();
      request.setHeader = () => {};
      request.abort = () => {};
      request.end = () => setImmediate(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.resume = () => {};
        request.emit('response', response);
        response.emit('data', Buffer.from(csv));
        response.emit('end');
      });
      return request;
    }
  };
  const fakeDialog = { showSaveDialog: async () => ({ canceled: false, filePath: profilePath }) };
  try {
    const gate = createVpnGate({ net: fakeNet, dialog: fakeDialog, app: { getPath: () => temp }, getWindow: () => null, log: { warn() {} } });
    const listed = await gate.list();
    assert.equal(listed.servers.length, 1);
    assert.equal(Object.hasOwn(listed.servers[0], '_profile'), false, 'raw .ovpn is not sent to the renderer');
    const saved = await gate.download(listed.servers[0].id);
    assert.equal(saved.ok, true);
    const written = await fs.promises.readFile(profilePath, 'utf8');
    assert.match(written, /remote 219\.100\.37\.1 443/);
    assert.doesNotMatch(written, /opengw\.net/);
    assert.match(written, /^proto tcp-client$/m);
    assert.doesNotMatch(written, /evil\.cmd|malicious\.dll/);

    // Exercise the actual browser-session bridge lifecycle with a controlled
    // helper process: connect => loopback SOCKS proxy => verified exit IP =>
    // disconnect restores the session's original system proxy.
    const helperPath = path.join(temp, 'openvpn2socks.test');
    await fs.promises.writeFile(helperPath, 'test helper placeholder');
    let proxyConfig = null;
    let childProcessRef = null;
    const fakeSession = {
      async setProxy(config) { proxyConfig = config; },
      async closeAllConnections() {}
    };
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 0;
        setImmediate(() => child.emit('exit', 0, null));
        return true;
      };
      childProcessRef = child;
      setImmediate(() => child.stderr.emit('data', Buffer.from('time=2026-11-03T12:00:00Z level=INFO msg=\"SOCKS5 listening\" addr=127.0.0.1:23456\n')));
      return child;
    };
    const tunnel = createVpnGate({
      net: fakeNet,
      dialog: fakeDialog,
      app: { getPath: () => temp },
      getSession: () => fakeSession,
      helperPath,
      spawn: fakeSpawn,
      probe: async () => '198.51.100.42',
      log: { warn() {} }
    });
    const tunnelList = await tunnel.list();
    const connected = await tunnel.connect(tunnelList.servers[0].id);
    assert.equal(connected.ok, true);
    assert.equal(tunnel.publicState().status, 'connected');
    assert.equal(tunnel.publicState().exitIp, '198.51.100.42');
    assert.equal(proxyConfig.proxyRules, 'socks5://127.0.0.1:23456');
    await tunnel.disconnect();
    assert.deepEqual(proxyConfig, { mode: 'system' });
    assert.equal(childProcessRef.killed, true);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

testDirectoryWorkflow().then(() => {
  console.log('PASS VPN Gate parsing, compatibility detection, safe profile export, browser-scoped SOCKS tunnel lifecycle and cleanup');
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
