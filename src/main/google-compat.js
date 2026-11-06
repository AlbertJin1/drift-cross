'use strict';
// Google account sign-in compatibility.
//
// Google only lets "supported browsers" sign in (https://support.google.com/accounts/answer/7675428).
// Its checklist, and what Drift does for each item:
//   1. JavaScript on            -> every page view is created with javascript: true and contextIsolation: true
//                                  (contextIsolation: false is what triggers Google's "JavaScript is off" error).
//   2. Extensions off           -> Drift's own page features (ad blocker, popup blocker) never touch Google's
//                                  sign-in hosts; third-party extensions stay the user's choice.
//   3. Latest browser version   -> the user agent is a clean, current Chrome UA built from the bundled Chromium
//                                  version, with no Electron/Drift tokens (Google blocks "embedded" browsers).
//   4. google.com allowed       -> sign-in hosts are always allowed by the ad blocker, storage-access permissions are
//                                  granted, and "Sign in with Google" popups open as real popup windows that keep
//                                  window.opener (turning them into tabs breaks the hand-back to the site).
//   5. Firewall / anti-virus    -> outside Drift's control; nothing in Drift rewrites security headers
//                                  (Sec-Fetch-*, Sec-CH-UA) on the normal path.
// If Google still rejects the browser, the tab retries sign-in once with a Firefox user agent (the fallback other
// Electron browsers use), limited to Google's sign-in pages and reverted as soon as the tab leaves them.

// Hosts that make up the Google sign-in flow. accounts.google.<any ccTLD> is matched separately.
const GOOGLE_SIGNIN_HOSTS = [
  'accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com', 'gds.google.com',
  'oauth2.googleapis.com', 'accounts.googleapis.com', 'apis.google.com', 'content.googleapis.com',
  'ssl.gstatic.com', 'www.gstatic.com', 'fonts.gstatic.com', 'lh3.googleusercontent.com',
  'signaler-pa.googleapis.com'
];
const ACCOUNTS_CCTLD = /^accounts\.google\.[a-z]{2,3}(\.[a-z]{2})?$/;

// Permissions Chrome grants (or prompts for) that sign-in and federated-login flows rely on.
const SIGNIN_PERMISSIONS = ['storage-access', 'top-level-storage-access'];

function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

function isGoogleSigninHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (ACCOUNTS_CCTLD.test(h)) return true;
  return GOOGLE_SIGNIN_HOSTS.includes(h);
}

/** Pages where Google is asking for (or rejecting) a sign-in: the only place the Firefox fallback is used. */
function isGoogleAccountsPage(url) {
  const h = hostOf(url);
  return h === 'accounts.google.com' || ACCOUNTS_CCTLD.test(h) || h === 'accounts.youtube.com';
}

/** Google's "Couldn't sign you in — this browser or app may not be secure" page. */
function isGoogleRejectionUrl(url) {
  return isGoogleAccountsPage(url) && /\/signin\/(v2\/)?rejected|\/signin\/v\d\/rejected|\/v3\/signin\/rejected/i.test(String(url));
}

/**
 * Turns Electron's default UA into the UA real Chrome sends:
 *   "...AppleWebKit/537.36 (KHTML, like Gecko) Drift/1.4.0 Chrome/142.0.7444.59 Electron/45.0.0 Safari/537.36"
 *   -> "...AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
 * Chrome's reduced UA always reports MAJOR.0.0.0, and the major version comes from the bundled Chromium so it is
 * never older than the engine that actually renders the page.
 */
function chromeUserAgent(rawUserAgent, chromeVersion, platform = process.platform) {
  const major = String(chromeVersion || '').split('.')[0] || '';
  let ua = String(rawUserAgent || '');
  if (!ua) {
    const os = platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
    ua = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major || '0'}.0.0.0 Safari/537.36`;
  }
  ua = ua
    .replace(/\s+Electron\/\S+/gi, '')
    .replace(/\s+drift\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (major) ua = ua.replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`);
  return ua;
}

/** A current Firefox UA for the sign-in fallback. Firefox ships every four weeks; stay one release behind. */
function firefoxUserAgent(now = Date.now(), platform = process.platform) {
  const base = Date.UTC(2024, 6, 9); // Firefox 128
  const releases = Math.floor(Math.max(0, now - base) / (28 * 24 * 3600 * 1000));
  const version = 128 + Math.max(0, releases - 1);
  const os = platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
}

/**
 * window.open() with window features (disposition "new-window") is how "Sign in with Google", Microsoft, GitHub and
 * other OAuth popups open. Chrome gives those a real popup window so the page keeps window.opener; Drift does too.
 * Links that merely target a new tab still become tabs.
 */
function shouldOpenAsPopupWindow(details) {
  if (!details) return false;
  if (details.disposition === 'new-window') return true;
  return isGoogleAccountsPage(details.url);
}

/** Size and position a popup the way the page asked (window features), within sane bounds. */
function popupBounds(features, parentBounds) {
  const read = (name) => {
    const m = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i').exec(String(features || ''));
    return m ? Number(m[1]) : NaN;
  };
  const width = Math.min(Math.max(Number.isFinite(read('width')) ? read('width') : 500, 320), 1400);
  const height = Math.min(Math.max(Number.isFinite(read('height')) ? read('height') : 640, 360), 1000);
  const bounds = { width, height };
  const left = read('left'); const top = read('top');
  if (Number.isFinite(left) && Number.isFinite(top)) { bounds.x = left; bounds.y = top; }
  else if (parentBounds) {
    bounds.x = Math.round(parentBounds.x + (parentBounds.width - width) / 2);
    bounds.y = Math.round(parentBounds.y + Math.max(40, (parentBounds.height - height) / 3));
  }
  return bounds;
}

module.exports = {
  GOOGLE_SIGNIN_HOSTS,
  SIGNIN_PERMISSIONS,
  isGoogleSigninHost,
  isGoogleAccountsPage,
  isGoogleRejectionUrl,
  chromeUserAgent,
  firefoxUserAgent,
  shouldOpenAsPopupWindow,
  popupBounds
};
