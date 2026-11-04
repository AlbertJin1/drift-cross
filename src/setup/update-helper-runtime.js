'use strict';

const fs = require('fs');
const path = require('path');

function processIsAlive(pid, killProcess = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { killProcess(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function waitForProcessExit(pid, options = {}) {
  const currentPid = Number.isSafeInteger(options.currentPid) ? options.currentPid : process.pid;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 180000;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const killProcess = options.killProcess || process.kill;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid) throw new Error('The update helper received an invalid parent Drift PID.');
  const deadline = now() + timeoutMs;
  while (processIsAlive(pid, killProcess)) {
    if (now() >= deadline) throw new Error(`Drift process ${pid} did not close within ${Math.round(timeoutMs / 1000)} seconds.`);
    await sleep(Math.min(200, Math.max(1, deadline - now())));
  }
  return true;
}

function writeHelperReadyMarker(file, token, allowedDirectory, fsImpl = fs) {
  const resolvedFile = String(file || '');
  const secret = String(token || '');
  if (!resolvedFile && !secret) return false; // legacy PowerShell-driven updates do not use this marker
  if (!resolvedFile || !/^[a-f0-9]{32,64}$/i.test(secret)) throw new Error('The update helper readiness parameters are invalid.');
  const root = path.resolve(String(allowedDirectory || ''));
  const target = path.resolve(resolvedFile);
  const relative = path.relative(root, target);
  if (!root || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The update helper readiness file is outside the Drift Updates folder.');
  }
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  fsImpl.writeFileSync(target, secret, { encoding: 'ascii', flag: 'w' });
  return true;
}

module.exports = { processIsAlive, waitForProcessExit, writeHelperReadyMarker };
