'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Validate that an installation directory is writable by the current user.
 * Drift never self-elevates: installation paths that would need UAC are
 * rejected before any application files are copied.
 */
function verifyUserWritableInstallDirectory(candidate, fallbackHint = 'the default Local AppData folder') {
  if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) {
    throw new Error('Choose a valid absolute install folder. Drift installs for your Windows account and does not request administrator access.');
  }

  const target = path.resolve(candidate);
  if (target === path.parse(target).root) {
    throw new Error('Choose a folder inside a drive, not the drive root. Drift installs per-user and does not require administrator rights.');
  }

  const probe = path.join(target, `.drift-user-write-check-${process.pid}-${Date.now()}`);
  let fd = null;
  try {
    fs.mkdirSync(target, { recursive: true });
    fd = fs.openSync(probe, 'wx');
    fs.writeSync(fd, 'Drift current-user install permission check');
    fs.closeSync(fd);
    fd = null;
    fs.unlinkSync(probe);
    return target;
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(probe, { force: true }); } catch {}
    const detail = error && error.code ? ` (${error.code})` : '';
    throw new Error(`This folder is not writable by your Windows account${detail}. Choose a folder you own, such as ${fallbackHint}. Drift will not request administrator permission.`);
  }
}

module.exports = { verifyUserWritableInstallDirectory };
