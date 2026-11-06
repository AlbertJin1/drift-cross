'use strict';
// Google account sign-in compatibility (src/main/google-compat.js).
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const g = require('../src/main/google-compat');

// 1. User agent: clean, current Chrome UA with no Electron / Drift tokens.
const raw = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Drift/1.4.0 Chrome/142.0.7444.59 Electron/45.0.0 Safari/537.36';
const ua = g.chromeUserAgent(raw, '142.0.7444.59', 'win32');
assert.equal(ua, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');
assert.ok(!/electron|drift/i.test(ua));
assert.equal(g.chromeUserAgent(raw.replace('Drift/', 'drift/'), '142.0.1.2', 'win32'), ua, 'lower-case app token is removed too');
assert.match(g.chromeUserAgent('', '150.0.1.1', 'win32'), /Chrome\/150\.0\.0\.0 Safari\/537\.36$/, 'empty UA gets a Chrome UA');

// 2. Firefox fallback UA tracks the release train and never runs ahead of it.
assert.match(g.firefoxUserAgent(Date.UTC(2026, 10, 7), 'win32'), /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64; rv:(\d+)\.0\) Gecko\/20100101 Firefox\/\1\.0$/);
const ffVersion = Number(/Firefox\/(\d+)/.exec(g.firefoxUserAgent(Date.UTC(2025, 10, 20)))[1]);
assert.ok(ffVersion >= 144 && ffVersion <= 145, `Firefox version for Nov 2025 was ${ffVersion}`);

// 3. Sign-in hosts and pages.
for (const host of ['accounts.google.com', 'accounts.google.com.ph', 'accounts.google.co.uk', 'accounts.youtube.com', 'oauth2.googleapis.com', 'ssl.gstatic.com']) {
  assert.ok(g.isGoogleSigninHost(host), host);
}
for (const host of ['www.google.com', 'doubleclick.net', 'googleadservices.com', 'evil-accounts.google.com.attacker.net', '']) {
  assert.ok(!g.isGoogleSigninHost(host), `not a sign-in host: ${host}`);
}
assert.ok(g.isGoogleRejectionUrl('https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmail.google.com'));
assert.ok(g.isGoogleRejectionUrl('https://accounts.google.com/signin/rejected?rrk=46'));
assert.ok(!g.isGoogleRejectionUrl('https://accounts.google.com/v3/signin/identifier?continue=x'));
assert.ok(!g.isGoogleRejectionUrl('https://example.com/signin/rejected'));

// 4. OAuth popups keep window.opener (real popup window); plain new-tab links stay tabs.
assert.ok(g.shouldOpenAsPopupWindow({ url: 'https://example.com/auth', disposition: 'new-window' }));
assert.ok(g.shouldOpenAsPopupWindow({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', disposition: 'foreground-tab' }));
assert.ok(!g.shouldOpenAsPopupWindow({ url: 'https://example.com/', disposition: 'foreground-tab' }));
assert.deepEqual(g.popupBounds('width=500,height=600,left=10,top=20'), { width: 500, height: 600, x: 10, y: 20 });
const centred = g.popupBounds('', { x: 0, y: 0, width: 1500, height: 900 });
assert.equal(centred.width, 500); assert.equal(centred.x, 500);
assert.equal(g.popupBounds('width=5,height=99999').width, 320);

// 5. Sign-in needs storage access.
assert.ok(g.SIGNIN_PERMISSIONS.includes('storage-access'));

// 6. main.js wiring.
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
for (const needle of [
  "require('./google-compat')",
  'javascript: true',
  'contextIsolation: true',
  'googleCompat.chromeUserAgent(ses.getUserAgent()',
  'app.userAgentFallback = googleCompat.chromeUserAgent',
  "on('did-create-window'",
  'installGoogleSigninFallback(wc)',
  'googleCompat.isGoogleSigninHost(initiatorHost)',
  'googleCompat.SIGNIN_PERMISSIONS'
]) assert.ok(main.includes(needle), `main.js is missing: ${needle}`);
assert.ok(!/onBeforeSendHeaders/.test(main), 'Drift must not rewrite request headers (Sec-Fetch-*, Sec-CH-UA) — Google rejects that');

console.log('Google sign-in compatibility tests passed.');
