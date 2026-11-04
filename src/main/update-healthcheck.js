'use strict';

const fs = require('fs');
const path = require('path');

function buildUpdateHealthcheckPayload(options = {}) {
  const file = String(options.file || '');
  const token = String(options.token || '');
  const expectedVersion = String(options.expectedVersion || '');
  const actualVersion = String(options.actualVersion || '');
  const allowedDirectory = String(options.allowedDirectory || '');
  const pid = Number(options.pid);
  if (!file || !allowedDirectory || !/^[a-f0-9]{32,64}$/i.test(token)
    || !/^\d+\.\d+\.\d+$/.test(expectedVersion) || expectedVersion !== actualVersion
    || !Number.isSafeInteger(pid) || pid <= 0) return null;

  const root = path.resolve(allowedDirectory) + path.sep;
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;

  return { ok: true, version: actualVersion, token, pid, readyAt: Number(options.now || Date.now()) };
}

function writeUpdateHealthcheck(options = {}) {
  const payload = buildUpdateHealthcheckPayload(options);
  if (!payload) return false;
  const fsImpl = options.fs || fs;
  try {
    fsImpl.mkdirSync(path.dirname(options.file), { recursive: true });
    const temp = `${options.file}.tmp-${payload.pid}`;
    fsImpl.writeFileSync(temp, JSON.stringify(payload), { encoding: 'utf8' });
    fsImpl.renameSync(temp, options.file);
    return true;
  } catch {
    try { fsImpl.rmSync(`${options.file}.tmp-${payload.pid}`, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

module.exports = { buildUpdateHealthcheckPayload, writeUpdateHealthcheck };
