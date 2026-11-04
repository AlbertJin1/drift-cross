'use strict';

/*
 * Drift -> Universal App Monitor transport (used by the updater and by usage reporting).
 *
 * Modelled on PDF Studio's gateway handling (electron/monitor-api.cjs + fetchHttpsResponse/postMonitorUsage):
 *
 *   - HTTPS only, no embedded credentials, redirects followed by hand (max 5) and only to HTTPS.
 *   - Two deployment layouts are tried automatically: the normal  <base>/api/...  (root rewrite) and
 *     <base>/public/api/...  (hosts that serve public/ directly).
 *   - Optional fallback gateway addresses (config.fallbackGatewayUrls), e.g. a second tunnel host.
 *   - A tunnel splash page / web-server fallback that answers HTTP 200 with HTML is NOT mistaken for the API.
 *   - The address that worked last is tried first next time.
 *   - Only the allowlisted client-gateway.php script is ever called; the monitor's API key is added on the
 *     server and never exists in this app.
 *
 * Results are classified so callers can decide whether to retry later:
 *   'ok'         the monitor answered successfully
 *   'retry'      network error, timeout, 5xx, 408/425/429, tunnel offline - try again later
 *   'permanent'  the monitor understood and refused (4xx): retrying the same payload cannot help
 */

const CANONICAL_MARKER = '/api/';
const DIRECT_MARKER = '/public/api/';
const MAX_REDIRECTS = 5;
const ROUTE_FALLBACK_STATUSES = new Set([401, 403, 404, 405, 502, 503, 504]);
const RETRYABLE_STATUSES = new Set([0, 408, 425, 429]);

function parseHttps(value, allowInsecure) {
  const url = value instanceof URL ? new URL(value.toString()) : new URL(String(value));
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) throw new Error('the monitor gateway must use HTTPS');
  if (url.username || url.password) throw new Error('the monitor gateway address cannot contain credentials');
  return url;
}

// <host>/x/api/client-gateway.php <-> <host>/x/public/api/client-gateway.php
function alternatePath(url) {
  const alternate = new URL(url.toString());
  if (url.pathname.includes(DIRECT_MARKER)) alternate.pathname = url.pathname.replace(DIRECT_MARKER, CANONICAL_MARKER);
  else if (url.pathname.includes(CANONICAL_MARKER)) alternate.pathname = url.pathname.replace(CANONICAL_MARKER, DIRECT_MARKER);
  else return null;
  return alternate;
}

function configuredBases(config) {
  const list = [config.gatewayUrl, ...(Array.isArray(config.fallbackGatewayUrls) ? config.fallbackGatewayUrls : [])];
  return list.filter((value) => typeof value === 'string' && value.trim());
}

/** All addresses worth trying for these query parameters, preferred (last good) first. */
function gatewayCandidates(config, params = {}, state = {}) {
  const seen = new Set();
  const out = [];
  const add = (url) => {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const key = url.toString();
    if (!seen.has(key)) { seen.add(key); out.push(url); }
  };
  for (const base of configuredBases(config)) {
    const url = parseHttps(base, config.allowInsecure);
    add(url);
    const alt = alternatePath(url);
    if (alt) add(alt);
  }
  if (state.lastGood) {
    const index = out.findIndex((url) => url.origin + url.pathname === state.lastGood);
    if (index > 0) out.unshift(out.splice(index, 1)[0]);
  }
  return out;
}

function looksLikeJson(response) {
  const type = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : null;
  return type === null || type === undefined || /\bjson\b/i.test(type); // fakes without headers are treated as JSON
}

function createGateway(deps) {
  const config = deps.config;
  const fetchImpl = deps.fetch;
  const userAgent = deps.userAgent || 'Drift';
  const state = { lastGood: '' };

  async function followRedirects(startUrl, init) {
    let current = parseHttps(startUrl, config.allowInsecure);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current.toString(), { ...init, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers && response.headers.get ? response.headers.get('location') : null;
        if (!location) throw new Error('the monitor sent an incomplete redirect');
        if (hop === MAX_REDIRECTS) throw new Error('too many redirects from the monitor');
        current = parseHttps(new URL(location, current), config.allowInsecure);
        continue;
      }
      return { response, finalUrl: current };
    }
    throw new Error('could not reach the monitor');
  }

  /**
   * One gateway call with automatic route / host fallback.
   * options: { params, method, body (object), accept, timeoutMs, signal, expectJson }
   * Returns { kind: 'ok'|'retry'|'permanent', response?, status, message?, url? }. Never throws.
   * On 'ok' the caller reads response.json() / response.body itself.
   */
  async function request(options) {
    const { params = {}, method = 'GET', body = null, accept = 'application/json', timeoutMs = 25000, signal = null } = options;
    const expectJson = options.expectJson !== false && /json/i.test(accept);
    let candidates;
    try { candidates = gatewayCandidates(config, params, state); } catch (error) { return { kind: 'permanent', status: 0, message: error.message }; }
    if (candidates.length === 0) return { kind: 'permanent', status: 0, message: 'no monitor gateway address is configured' };

    let last = { kind: 'retry', status: 0, message: 'the monitor could not be reached' };
    const deadOrigins = new Set(); // hosts that did not answer at all: their other path cannot work either
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (deadOrigins.has(candidate.origin)) continue;
      const more = candidates.slice(index + 1).some((c) => !deadOrigins.has(c.origin));
      const headers = {
        accept,
        'ngrok-skip-browser-warning': '1',
        'user-agent': `${userAgent}/${deps.version()}`,
        ...(body === null ? {} : { 'content-type': 'application/json' }),
        ...(options.headers || {})
      };
      try {
        const { response, finalUrl } = await followRedirects(candidate, {
          method,
          headers,
          signal: signal || AbortSignal.timeout(timeoutMs),
          ...(body === null ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
        });
        if (!response.ok) {
          let detail = '';
          try {
            const raw = (await response.text()).slice(0, 1200);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.error === 'string') detail = parsed.error.replace(/[\r\n\t]+/g, ' ').slice(0, 300);
          } catch { /* a non-JSON proxy page is summarised by its status */ }
          const kind = response.status >= 500 || RETRYABLE_STATUSES.has(response.status) ? 'retry' : 'permanent';
          last = { kind, status: response.status, message: `the monitor answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`, detail };
          if (more && ROUTE_FALLBACK_STATUSES.has(response.status)) continue;
          return last;
        }
        if (expectJson && !looksLikeJson(response)) {
          last = { kind: 'retry', status: response.status, message: 'the monitor gateway returned a web page instead of JSON (tunnel or route problem)' };
          if (more) continue;
          return last;
        }
        state.lastGood = finalUrl.origin + finalUrl.pathname;
        return { kind: 'ok', response, status: response.status, url: finalUrl };
      } catch (error) {
        const name = error && error.name;
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        last = { kind: 'retry', status: 0, message: timedOut ? 'the monitor did not respond in time' : `the monitor could not be reached: ${String(error && error.message || error).slice(0, 200)}` };
        deadOrigins.add(candidate.origin);
        if (!candidates.slice(index + 1).some((c) => !deadOrigins.has(c.origin))) return last;
      }
    }
    return last;
  }

  return { request, candidates: (params) => gatewayCandidates(config, params, state), state };
}

module.exports = { createGateway, gatewayCandidates, alternatePath };
