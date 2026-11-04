'use strict';

/*
 * Drift usage reporting (Universal App Monitor, app id "drift").
 *
 * While Drift is open it tells the monitor's public client gateway that it is running, so the Drift tab shows
 * which PCs have the browser open right now:
 *
 *   open       once, a few seconds after launch (a new session)
 *   heartbeat  about once a minute while Drift stays open ("seconds" = total open time so far)
 *   close      when Drift quits (best effort, a few seconds at most - the monitor also treats a session whose
 *              heartbeats stopped as ended)
 *
 * Every event repeats the full session data and is an upsert on the monitor, so a lost, late or repeated event
 * is harmless. The shared monitor API key is never in this app: the gateway adds it on the server.
 *
 * What is sent: the random install id (shared with the updater), the Drift version, the Windows/macOS/Linux
 * version, the PC name and its LAN address, and a random per-launch session id. What is NEVER sent: sites,
 * tabs, searches, bookmarks, history, downloads or anything else the user does in the browser.
 *
 * Reporting only happens in packaged builds (development runs would pollute the statistics) and can be switched
 * off in Settings > General. Failures are written to <profile>\Updates\telemetry.log and never reach the user.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createGateway } = require('./monitor-gateway');

const HEX32_RE = /^[a-f0-9]{32}$/;
const LOG_LIMIT_BYTES = 100 * 1024;

const clip = (value, max) => String(value == null ? '' : value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

// First private/LAN IPv4 address of this PC, or '' (the monitor ignores an empty or invalid value).
function lanAddress(networkInterfaces) {
  try {
    const all = networkInterfaces() || {};
    for (const list of Object.values(all)) {
      for (const entry of list || []) {
        if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && entry.address && !entry.address.startsWith('169.254.')) {
          return entry.address;
        }
      }
    }
  } catch { /* some sandboxes refuse to list interfaces */ }
  return '';
}

// "Windows 11 (10.0.22631) x64", "macOS 24.1.0 arm64", "Linux 6.8.0 x64" - at most 120 characters.
function osLabel(platform, release, arch) {
  let name;
  if (platform === 'win32') {
    const parts = String(release).split('.');
    const build = Number(parts[2]);
    name = `Windows ${Number(parts[0]) >= 10 && build >= 22000 ? '11' : '10'} (${release})`;
  } else if (platform === 'darwin') name = `macOS ${release}`;
  else if (platform === 'linux') name = `Linux ${release}`;
  else name = `${platform} ${release}`;
  return clip(`${name} ${arch}`, 120);
}

function createTelemetry(deps) {
  const app = deps.app;
  const config = deps.config || require('./update-config');
  const fetchImpl = deps.fetch;
  const isEnabled = deps.isEnabled || (() => true);
  const identity = deps.identity; // { get(): install id, set(id): adopt the id the monitor says is canonical }
  const now = deps.now || Date.now;
  const osImpl = deps.os || os;
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const dir = deps.dir || path.join(app.getPath('userData'), 'Updates');
  const logFile = path.join(dir, 'telemetry.log');
  const queueFile = path.join(dir, 'telemetry-queue.json');
  const gateway = deps.gateway || createGateway({ config, fetch: fetchImpl, userAgent: 'Drift', version: () => app.getVersion() });
  const QUEUE_MAX = 50;
  const QUEUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  let flushing = false;
  const interval = config.reportIntervalMs || 60 * 1000;
  const firstDelay = config.reportFirstDelayMs || 4 * 1000;
  const retryDelay = config.reportRetryMs || 15 * 1000;
  const requestTimeout = config.reportTimeoutMs || 10 * 1000;
  const closeTimeout = config.reportCloseTimeoutMs || 2500;

  let started = false;
  let stopped = false;
  let timer = null;
  let busy = false;
  let session = null;      // { id, startedAt (seconds), startedMs } - null until the first report of a launch
  let supportReason;       // undefined = not evaluated, null = supported, string = why not

  function log(message) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.renameSync(logFile, `${logFile}.1`); } catch { /* no log yet */ }
      fs.appendFileSync(logFile, `[${new Date(now()).toISOString()}] ${message}\n`);
    } catch { /* logging must never break the browser */ }
  }

  function unsupportedReason() {
    if (supportReason !== undefined) return supportReason;
    supportReason = !deps.force && !app.isPackaged ? 'this is a development run' : null;
    if (supportReason) log(`usage reporting is off: ${supportReason}`);
    return supportReason;
  }

  function newSession() {
    const startedMs = now();
    session = { id: crypto.randomBytes(16).toString('hex'), startedAt: Math.floor(startedMs / 1000), startedMs, opened: false };
    return session;
  }

  function payload(event) {
    return {
      event,
      app_id: config.appId,
      app: config.appId,
      install_id: identity.get(),
      version: app.getVersion(),
      session_id: session.id,
      started_at: session.startedAt,
      seconds: Math.max(0, Math.floor((now() - session.startedMs) / 1000)),
      hostname: clip(osImpl.hostname(), 64),
      os: osLabel(platform, osImpl.release(), arch),
      local_ip: lanAddress(() => osImpl.networkInterfaces())
    };
  }

  // ---- offline queue: open/close reports that could not be delivered are kept on disk and re-sent later
  // (the monitor upserts by session id, so a late or repeated event is harmless).
  function readQueue() {
    try {
      const parsed = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && item.payload && typeof item.payload === 'object') : [];
    } catch { return []; }
  }
  function writeQueue(items) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${queueFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(items.slice(-QUEUE_MAX)));
      fs.renameSync(temp, queueFile);
    } catch { /* never break the browser over a queue file */ }
  }
  function enqueue(body) {
    // One heartbeat per session is enough (the newest); open and close stay.
    const key = `${body.session_id}:${body.event === 'heartbeat' ? 'heartbeat' : body.event}`;
    const kept = readQueue().filter((item) => `${item.payload.session_id}:${item.payload.event}` !== key
      && now() - Number(item.queuedAt || 0) < QUEUE_MAX_AGE_MS);
    kept.push({ queuedAt: now(), payload: body });
    writeQueue(kept);
  }

  // One POST through the gateway. Returns { kind, answer }.
  async function post(body, timeoutMs) {
    const result = await gateway.request({ params: { resource: 'telemetry' }, method: 'POST', body, timeoutMs });
    if (result.kind !== 'ok') return result;
    let answer = null;
    try { answer = await result.response.json(); } catch { /* an empty body is still a success */ }
    if (answer && answer.ok === false) return { kind: 'permanent', status: 200, message: `the monitor refused the report: ${clip(answer.error, 120)}` };
    return { kind: 'ok', answer };
  }

  async function flushQueue(timeoutMs = requestTimeout) {
    if (flushing) return;
    flushing = true;
    try {
      const items = readQueue();
      if (items.length === 0) return;
      const remaining = [];
      let blocked = false;
      for (const item of items) {
        if (blocked || now() - Number(item.queuedAt || 0) >= QUEUE_MAX_AGE_MS) { if (blocked) remaining.push(item); continue; }
        const result = await post(item.payload, timeoutMs);
        if (result.kind === 'retry') { blocked = true; remaining.push(item); }
        // 'permanent' (for example a malformed or cross-app event) is dropped: retrying cannot help.
      }
      writeQueue(remaining);
      if (items.length !== remaining.length) log(`re-sent ${items.length - remaining.length} queued report(s)`);
    } finally { flushing = false; }
  }

  // Sends one event. Resolves true when the monitor accepted it; never rejects.
  async function send(event, timeoutMs = requestTimeout) {
    try {
      if (!session) newSession();
      const body = payload(event);
      if (!HEX32_RE.test(body.install_id || '')) throw new Error('there is no valid install id yet');
      const result = await post(body, timeoutMs);
      if (result.kind !== 'ok') {
        if (result.status === 409) {
          // The monitor says this session id belongs to another app: start a fresh session next time.
          session = null;
          throw new Error('the monitor refused the session id (HTTP 409)');
        }
        if (result.kind === 'retry') enqueue(body);
        throw new Error(result.message || 'the monitor did not accept the report');
      }
      const answer = result.answer;
      // One PC is one install: when the monitor folds this PC into an older install id, keep using that one.
      const canonical = answer && typeof answer.install_id === 'string' ? answer.install_id.toLowerCase() : '';
      if (HEX32_RE.test(canonical) && canonical !== body.install_id) {
        try { identity.set(canonical); log(`adopted the monitor's canonical install id (…${canonical.slice(-6)})`); } catch { /* retried next time */ }
      }
      if (session && event !== 'close') session.opened = true;
      // The monitor is reachable again: deliver anything that was queued while it was not.
      if (event !== 'close') flushQueue(timeoutMs).catch(() => {});
      return true;
    } catch (error) {
      log(`${event} report failed: ${error && error.message ? error.message : error}`);
      return false;
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(tick, delay);
    if (timer.unref) timer.unref();
  }

  // Close an open session because reporting was switched off (or the app is quitting).
  async function closeSession(timeoutMs) {
    if (!session || !session.opened) { session = null; return; }
    await send('close', timeoutMs);
    session = null; // a later re-enable starts a new session: a closed session id can never reopen
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    let ok = true;
    try {
      if (unsupportedReason()) return;
      if (!isEnabled()) { await closeSession(requestTimeout); return; }
      ok = await send(session && session.opened ? 'heartbeat' : 'open');
    } finally {
      busy = false;
      if (!stopped && !unsupportedReason()) schedule(ok ? interval : retryDelay);
    }
  }

  function start() {
    if (started) return;
    started = true;
    schedule(firstDelay);
  }

  // Called when the Settings switch changes.
  function settingsChanged() {
    if (!started || stopped || unsupportedReason()) return;
    if (isEnabled()) schedule(1500);
    else { clearTimeout(timer); closeSession(requestTimeout).finally(() => schedule(interval)); }
  }

  // Called when Drift quits. Waits at most a few seconds so closing the browser is never slowed down.
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (!started || unsupportedReason() || !isEnabled()) return;
    await closeSession(closeTimeout);
  }

  return {
    start,
    stop,
    settingsChanged,
    send,
    supported: () => unsupportedReason() === null,
    hasOpenSession: () => !!(session && session.opened),
    flushQueue,
    paths: { log: logFile, queue: queueFile }
  };
}

module.exports = { createTelemetry, osLabel, lanAddress };
