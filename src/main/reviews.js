'use strict';

/*
 * Drift product reviews -> Universal App Monitor.
 *
 * Reviews use the existing public client gateway (resource=telemetry, event=review).
 * The browser renderer never receives the monitor URL or any server credential.
 * We intentionally do not include a PC hostname, LAN address, or browsing data in
 * review submissions. The monitor associates a review with the anonymous install
 * id and records the request IP for its existing abuse-prevention rules.
 */

const { createGateway } = require('./monitor-gateway');

const INSTALL_ID_RE = /^[a-f0-9]{32}$/i;
const VERSION_RE = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]{1,64})?$/;
const REVIEW_TIMEOUT_MS = 15000;

function cleanText(value, maxLength, keepLines = false) {
  if (typeof value !== 'string') return '';
  let text = value;
  if (keepLines) text = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  else text = text.replace(/[\x00-\x1F\x7F]+/g, ' ');
  return text.trim().slice(0, maxLength);
}

function createReviewService(deps) {
  if (!deps || !deps.app || typeof deps.fetch !== 'function' || !deps.identity) {
    throw new TypeError('Review service requires app, fetch, and installation identity dependencies.');
  }

  const app = deps.app;
  const config = deps.config || require('./update-config');
  const identity = deps.identity;
  const gateway = deps.gateway || createGateway({
    config,
    fetch: deps.fetch,
    userAgent: 'Drift',
    version: () => app.getVersion()
  });
  let busy = false;

  async function submit(input) {
    if (busy) return { ok: false, error: 'A review is already being submitted. Please wait.' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, error: 'Review details are invalid.' };
    }

    const rating = input.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { ok: false, error: 'Please choose a rating from 1 to 5 stars.' };
    }

    const name = cleanText(input.name, 60);
    const message = cleanText(input.message, 1500, true);
    const installId = String(identity.get() || '').toLowerCase();
    if (!INSTALL_ID_RE.test(installId)) {
      return { ok: false, error: 'Drift could not identify this installation. Restart the browser and try again.' };
    }

    const version = String(app.getVersion() || '').trim();
    if (!VERSION_RE.test(version)) {
      return { ok: false, error: 'The installed Drift version is invalid. Please update Drift and try again.' };
    }

    busy = true;
    try {
      const body = {
        event: 'review',
        app_id: config.appId || 'drift',
        app: config.appId || 'drift',
        install_id: installId,
        version,
        rating,
        name,
        message
      };
      const result = await gateway.request({
        params: { resource: 'telemetry' },
        method: 'POST',
        body,
        timeoutMs: deps.timeoutMs || REVIEW_TIMEOUT_MS
      });

      if (result.kind !== 'ok') {
        return { ok: false, error: result.message || 'Drift could not send your review. Please try again.' };
      }

      let answer = null;
      try { answer = await result.response.json(); } catch { /* handled as an invalid gateway reply below */ }
      if (!answer || answer.ok !== true) {
        const detail = answer && typeof answer.error === 'string' ? cleanText(answer.error, 240) : '';
        return { ok: false, error: detail || 'The review service returned an invalid response. Please try again.' };
      }

      // Keep reviews aligned with the monitor's canonical ID, just like updates and usage reports.
      const canonical = String(answer.install_id || '').toLowerCase();
      if (INSTALL_ID_RE.test(canonical) && canonical !== installId && typeof identity.set === 'function') {
        try { identity.set(canonical); } catch { /* the accepted review remains successful */ }
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, error: cleanText(error && error.message ? error.message : 'The review service is unavailable.', 240) };
    } finally {
      busy = false;
    }
  }

  return { submit };
}

module.exports = { createReviewService, cleanText };
