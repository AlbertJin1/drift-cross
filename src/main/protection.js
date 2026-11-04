'use strict';

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return url;
  } catch { return null; }
}

function referrerUrl(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.url === 'string') return value.url;
  return '';
}

/**
 * Evaluate a window.open / target=_blank request. Electron does not expose a
 * stable userGesture flag in every version, so Drift combines it (when present)
 * with a short-lived timestamp recorded from trusted native input events.
 */
function evaluatePopup(details, options = {}) {
  const url = safeWebUrl(details?.url);
  if (!url) return { block: true, reason: 'unsupported-url', host: '' };

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const gestureAt = Number.isFinite(options.lastGestureAt) ? options.lastGestureAt : 0;
  const gestureWindowMs = Number.isFinite(options.gestureWindowMs) ? options.gestureWindowMs : 2500;
  const hasGesture = details?.userGesture === true || (gestureAt > 0 && now >= gestureAt && now - gestureAt <= gestureWindowMs);
  const referrer = safeWebUrl(referrerUrl(details?.referrer));
  const initiatorHost = referrer?.hostname?.toLowerCase() || String(options.initiatorHost || '').toLowerCase();
  const host = url.hostname.toLowerCase();
  const siteAllowed = typeof options.isSiteAllowed === 'function' && options.isSiteAllowed(initiatorHost);
  const blockedHost = typeof options.blockedDomainFor === 'function' ? options.blockedDomainFor(host) : '';

  if (!siteAllowed && options.adBlockEnabled !== false && blockedHost) {
    return { block: true, reason: 'advertising-host', host, blockedHost, initiatorHost };
  }
  if (options.popupBlockEnabled !== false && !hasGesture) {
    return { block: true, reason: 'no-recent-user-gesture', host, initiatorHost };
  }
  return { block: false, reason: 'allowed', host, initiatorHost };
}

module.exports = { safeWebUrl, evaluatePopup };
