'use strict';
// Browser profiles for Drift.
//
// A profile is a completely separate browsing identity: its own cookies, logins, site storage, cache,
// permissions, bookmarks, history, downloads list, settings, session, recently-closed tabs and
// extensions. Isolation comes from giving every profile its own Electron `userData` directory, so
// Chromium itself keeps the data apart (nothing is filtered or tagged by Drift).
//
// Layout (root = the shared Drift data folder, e.g. %APPDATA%\Drift):
//
//   <root>\profiles.json          registry: names, colours, last used          (shared)
//   <root>\Updates\               updater + usage identity                      (shared)
//   <root>\<profile files>        the "Default" profile lives in the root so existing installs keep
//                                 all of their data without any migration
//   <root>\Profiles\<Name>\       every additional profile; the folder is named after the profile the user
//                                 typed (and renamed when the profile is renamed). The stable 12-hex id stays the
//                                 profile's identity (command line, taskbar id, registry), the folder is just
//                                 where its data lives and is recorded in the registry (`dir`).
//   <root>\Icons\<id>.ico         the taskbar icon generated for each profile (written by the app)
//
// One Drift process runs one profile. Opening another profile starts another Drift process with
// `--profile=<id>`; Electron's single-instance lock is per userData directory, so launching a profile
// that is already open simply focuses its window.
//
// This module only needs Node, so it is unit-tested without Electron (npm run test:profiles).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStorage } = require('./storage');

const DEFAULT_ID = 'default';
const REGISTRY_FILE = 'profiles.json';
const PROFILES_DIR = 'Profiles';
const ICONS_DIR = 'Icons';
const TRASH_PREFIX = '.deleting-';
const INFO_FILE = 'profile-info.json'; // small marker inside every profile folder: id, name, colour
const MAX_PROFILES = 20;
const MAX_NAME_LENGTH = 40;
const ID_RE = /^[a-f0-9]{12}$/;
const RUNNING_CACHE_MS = 2000;

// Avatar colours (any one of these can be picked; the first is the default profile's colour).
const PROFILE_COLORS = ['#7c5cff', '#0ea5e9', '#22a06b', '#e5484d', '#f59e0b', '#4f46e5', '#64748b', '#14b8a6'];

class ProfileError extends Error {
  constructor(code, message) { super(message); this.name = 'ProfileError'; this.code = code; }
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}

function isValidId(id) { return id === DEFAULT_ID || (typeof id === 'string' && ID_RE.test(id)); }

// Trims, collapses whitespace and strips control / bidi-override characters so a name can never
// disguise itself or break the window title.
function cleanName(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A folder name that is safe on Windows, macOS and Linux and still reads as the profile's name.
function folderSafeName(name) {
  let n = cleanName(name)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')      // no hidden / dot folders (those are reserved for Drift's own trash folders)
    .replace(/[.\s]+$/, '')      // Windows silently drops trailing dots and spaces
    .trim();
  if (!n) n = 'Profile';
  if (WINDOWS_RESERVED.test(n.split('.')[0])) n = `${n} profile`;
  return n.slice(0, 60).replace(/[.\s]+$/, '') || 'Profile';
}
// A stored folder name must be one plain path segment, otherwise it is ignored and the id is used.
function isSafeDirName(dir) {
  return typeof dir === 'string' && dir.length > 0 && dir.length <= 80 && dir === dir.trim()
    && !/[<>:"/\\|?*\u0000-\u001f]/.test(dir) && !dir.startsWith('.') && !/[.\s]$/.test(dir) && !WINDOWS_RESERVED.test(dir.split('.')[0]);
}

function createProfileManager({ rootDir, pid = process.pid, isPidAlive = defaultIsPidAlive, now = Date.now, log = console }) {
  if (!rootDir) throw new Error('createProfileManager needs a root directory.');
  const root = path.resolve(rootDir);
  const profilesRoot = path.join(root, PROFILES_DIR);
  const iconFile = (id) => { if (!isValidId(id)) throw new ProfileError('invalid-id', 'That profile does not exist.'); return path.join(root, ICONS_DIR, `${id}.ico`); };
  const registryStore = createStorage({ getDir: () => root, log });
  let runningCache = { at: 0, value: null, selfId: null };

  const isInside = (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  // Folder of a profile inside a given registry snapshot (falls back to the id for profiles from older builds).
  function dirIn(registry, id) {
    if (!isValidId(id)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    if (id === DEFAULT_ID) return root;
    const entry = registry && registry.profiles.find((p) => p.id === id);
    const dir = path.join(profilesRoot, entry && entry.dir ? entry.dir : id);
    if (!isInside(profilesRoot, dir)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    return dir;
  }
  function dirFor(id) {
    if (!isValidId(id)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    if (id === DEFAULT_ID) return root;
    return dirIn(readRegistry(), id);
  }

  // ---- registry --------------------------------------------------------------------------
  // Always re-read from disk before changing anything: several Drift processes (one per open
  // profile) share this file.
  function sanitize(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set([DEFAULT_ID]);
    const usedDirs = new Set();
    const savedDefault = Array.isArray(input.profiles) ? input.profiles.find((p) => p && p.id === DEFAULT_ID) : null;
    const profiles = [{
      id: DEFAULT_ID,
      name: cleanName(savedDefault && savedDefault.name) || 'Default',
      color: PROFILE_COLORS.includes(savedDefault && savedDefault.color) ? savedDefault.color : PROFILE_COLORS[0],
      createdAt: Number.isFinite(savedDefault && savedDefault.createdAt) ? savedDefault.createdAt : 0
    }];
    for (const entry of Array.isArray(input.profiles) ? input.profiles : []) {
      if (!entry || !ID_RE.test(entry.id) || seen.has(entry.id) || profiles.length >= MAX_PROFILES) continue;
      const name = cleanName(entry.name);
      if (!name) continue;
      seen.add(entry.id);
      const dir = isSafeDirName(entry.dir) && !usedDirs.has(entry.dir.toLowerCase()) ? entry.dir : entry.id;
      usedDirs.add(dir.toLowerCase());
      profiles.push({
        id: entry.id,
        name,
        dir,
        color: PROFILE_COLORS.includes(entry.color) ? entry.color : PROFILE_COLORS[profiles.length % PROFILE_COLORS.length],
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0
      });
    }
    const lastUsed = seen.has(input.lastUsed) ? input.lastUsed : DEFAULT_ID;
    return { version: 1, lastUsed, profiles };
  }
  const readRegistry = () => sanitize(registryStore.readJson(REGISTRY_FILE, null));
  function writeRegistry(registry) {
    if (!registryStore.writeJson(REGISTRY_FILE, registry)) throw new ProfileError('write-failed', 'Drift could not save the profile list. Check that your disk is not full or read-only.');
    return registry;
  }

  // ---- reading ---------------------------------------------------------------------------
  function readRunState(id, registry = null) {
    // Only the main file: the .bak copy holds the *previous* state and could wrongly say "running".
    try { return JSON.parse(fs.readFileSync(path.join(registry ? dirIn(registry, id) : dirFor(id), 'run-state.json'), 'utf8')); } catch { return null; }
  }
  function isRunning(id, selfId = null, registry = null) {
    if (selfId && id === selfId) return true;
    const state = readRunState(id, registry);
    return !!state && state.running === true && Number.isInteger(state.pid) && state.pid !== pid && isPidAlive(state.pid);
  }
  function othersRunning(selfId) {
    const t = now();
    if (runningCache.selfId === selfId && runningCache.value !== null && t - runningCache.at < RUNNING_CACHE_MS) return runningCache.value;
    let value = false;
    const registry = readRegistry();
    for (const p of registry.profiles) { if (p.id !== selfId && isRunning(p.id, null, registry)) { value = true; break; } }
    runningCache = { at: t, value, selfId };
    return value;
  }
  const decorate = (p, selfId, registry = null) => ({ id: p.id, name: p.name, color: p.color, createdAt: p.createdAt, isDefault: p.id === DEFAULT_ID, running: isRunning(p.id, selfId, registry) });
  function list(selfId = null) { const registry = readRegistry(); return registry.profiles.map((p) => decorate(p, selfId, registry)); }
  function get(id, selfId = null) { const registry = readRegistry(); const p = registry.profiles.find((x) => x.id === id); return p ? decorate(p, selfId, registry) : null; }
  function count() { return readRegistry().profiles.length; }

  // `--profile=<id>` or `--profile <id>`; anything unknown falls back to the last used profile.
  function parseArg(argv) {
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]);
      if (a.startsWith('--profile=')) return a.slice('--profile='.length).trim();
      if (a === '--profile' && i + 1 < args.length) return String(args[i + 1]).trim();
    }
    return '';
  }
  function resolveActive(argv) {
    try {
      const registry = readRegistry();
      const requested = parseArg(argv);
      if (requested && registry.profiles.some((p) => p.id === requested)) return requested;
      return registry.lastUsed;
    } catch { return DEFAULT_ID; }
  }
  const launchArgs = (id) => [`--profile=${id}`];

  // ---- changing --------------------------------------------------------------------------
  function validateName(name, registry, exceptId = null) {
    const clean = cleanName(name);
    if (!clean) throw new ProfileError('invalid-name', 'Enter a name for the profile.');
    if (registry.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === clean.toLowerCase())) {
      throw new ProfileError('duplicate-name', `A profile named “${clean}” already exists.`);
    }
    return clean;
  }
  function validateColor(color, fallback) {
    if (color == null || color === '') return fallback;
    if (!PROFILE_COLORS.includes(color)) throw new ProfileError('invalid-color', 'Pick one of the available profile colours.');
    return color;
  }

  // ---- folders (AppData\Drift\Profiles\<Name>) ------------------------------------------------
  // The folder name follows the profile's name. Names are unique (case-insensitive) but two different names can
  // clean up to the same folder name ("a/b" and "ab"), or a stray folder may already exist, so a " (2)" is added.
  function uniqueDirName(registry, name, exceptId) {
    const base = folderSafeName(name);
    const own = registry.profiles.find((p) => p.id === exceptId);
    const ownDir = own && own.dir ? own.dir.toLowerCase() : null;
    const takenByOthers = new Set(registry.profiles.filter((p) => p.id !== exceptId && p.id !== DEFAULT_ID).map((p) => (p.dir || p.id).toLowerCase()));
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? base : `${base} (${n})`.slice(0, 80);
      const key = candidate.toLowerCase();
      if (takenByOthers.has(key)) continue;
      if (key !== ownDir && fs.existsSync(path.join(profilesRoot, candidate))) continue;
      return candidate;
    }
    return `${base} ${crypto.randomBytes(3).toString('hex')}`;
  }
  // A tiny marker inside each profile folder so the folder itself says which profile it is. Updated immediately on
  // every rename (even for a profile whose folder cannot be renamed yet because the profile is open).
  function writeInfo(profile) {
    if (profile.id === DEFAULT_ID) return; // the default profile's folder is the shared Drift folder itself
    try {
      const dir = path.join(profilesRoot, profile.dir || profile.id);
      if (!fs.existsSync(dir)) return;
      const text = JSON.stringify({ app: 'Drift', id: profile.id, name: profile.name, color: profile.color }, null, 2);
      const target = path.join(dir, INFO_FILE);
      let current = null;
      try { current = fs.readFileSync(target, 'utf8'); } catch { /* not written yet */ }
      if (current !== text) fs.writeFileSync(target, text);
    } catch { /* cosmetic marker; never block the profile */ }
  }
  // Renames every profile folder that no longer matches its profile's name. A folder is never touched while its
  // profile is open (its window holds files in it, and its process already points at the old path); that profile is
  // handled the next time any Drift window starts or its profile list changes. Returns the renames made so a failed
  // registry save can undo them.
  function syncFolders(registry, selfId) {
    const renames = [];
    for (const profile of registry.profiles) {
      if (profile.id === DEFAULT_ID) continue;
      const current = profile.dir || profile.id;
      const desired = uniqueDirName(registry, profile.name, profile.id);
      if (desired !== current && !isRunning(profile.id, selfId, registry)) {
        const from = path.join(profilesRoot, current);
        const to = path.join(profilesRoot, desired);
        try {
          if (fs.existsSync(from)) fs.renameSync(from, to);
          profile.dir = desired;
          renames.push({ from, to });
        } catch (error) {
          log.warn && log.warn(`Drift could not rename the folder of profile “${profile.name}” yet:`, error && error.message);
        }
      }
      writeInfo(profile);
    }
    return renames;
  }
  function commitFolders(registry, selfId) {
    const renames = syncFolders(registry, selfId);
    if (!renames.length) return 0;
    try { writeRegistry(registry); }
    catch (error) {
      for (const r of renames.reverse()) { try { fs.renameSync(r.to, r.from); } catch { /* leave it; the registry is re-read next time */ } }
      log.warn && log.warn('Drift could not save renamed profile folders:', error && error.message);
      return 0;
    }
    for (const profile of registry.profiles) writeInfo(profile);
    runningCache.value = null;
    return renames.length;
  }
  // Brings every folder in line with its profile's name. Runs at every start (this also moves profiles made by
  // older builds from their id-named folder to a name-based one) and after the profile list changes.
  function reconcile({ selfId = null } = {}) {
    try { return commitFolders(readRegistry(), selfId); }
    catch (error) { log.warn && log.warn('Drift could not tidy its profile folders:', error && error.message); return 0; }
  }

  function create({ name, color } = {}) {
    const registry = readRegistry();
    if (registry.profiles.length >= MAX_PROFILES) throw new ProfileError('limit', `Drift supports up to ${MAX_PROFILES} profiles.`);
    const clean = validateName(name, registry);
    const used = new Set(registry.profiles.map((p) => p.color));
    const fallback = PROFILE_COLORS.find((c) => !used.has(c)) || PROFILE_COLORS[registry.profiles.length % PROFILE_COLORS.length];
    let id;
    do { id = crypto.randomBytes(6).toString('hex'); } while (registry.profiles.some((p) => p.id === id));
    const profile = { id, name: clean, dir: uniqueDirName(registry, clean, null), color: validateColor(color, fallback), createdAt: now() };
    const folder = path.join(profilesRoot, profile.dir);
    try { fs.mkdirSync(folder, { recursive: true }); }
    catch (error) { throw new ProfileError('write-failed', `Drift could not create the profile folder: ${error && error.message ? error.message : error}`); }
    registry.profiles.push(profile);
    try { writeRegistry(registry); }
    catch (error) { try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* nothing was stored yet */ } throw error; }
    writeInfo(profile);
    runningCache.value = null;
    commitFolders(registry, null); // also tidies up any other profile whose folder was waiting for a rename
    return decorate(profile, null, registry);
  }

  function update(id, { name, color } = {}, { activeId = null } = {}) {
    if (!isValidId(id)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    const registry = readRegistry();
    const profile = registry.profiles.find((p) => p.id === id);
    if (!profile) throw new ProfileError('not-found', 'That profile no longer exists.');
    if (name !== undefined) profile.name = validateName(name, registry, id);
    if (color !== undefined) profile.color = validateColor(color, profile.color);
    writeRegistry(registry);
    writeInfo(profile);
    commitFolders(registry, activeId); // rename the folder to match, unless the profile is open right now
    return decorate(profile, activeId, registry);
  }

  function markUsed(id) {
    const registry = readRegistry();
    if (!registry.profiles.some((p) => p.id === id) || registry.lastUsed === id) return false;
    registry.lastUsed = id;
    try { writeRegistry(registry); return true; } catch { return false; }
  }

  // Deletes a profile and every byte of its browsing data. The folder is first renamed out of the
  // way (atomic, and it fails cleanly if Windows still has a file open), then the registry is
  // updated, then the renamed folder is erased. A leftover from a crash is swept at the next start.
  function remove(id, { activeId = null } = {}) {
    if (id === DEFAULT_ID) throw new ProfileError('protected', 'The default profile cannot be deleted. You can rename it instead.');
    if (!isValidId(id)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    if (id === activeId) throw new ProfileError('in-use', 'You are using this profile. Switch to another profile first, then delete it.');
    const registry = readRegistry();
    if (!registry.profiles.some((p) => p.id === id)) throw new ProfileError('not-found', 'That profile no longer exists.');
    if (isRunning(id, null, registry)) throw new ProfileError('running', 'This profile is open in another Drift window. Close that window first, then delete the profile.');
    const dir = dirIn(registry, id);
    const trash = path.join(profilesRoot, `${TRASH_PREFIX}${id}-${now()}`);
    let moved = false;
    if (fs.existsSync(dir)) {
      try { fs.renameSync(dir, trash); moved = true; }
      catch (error) { throw new ProfileError('locked', `Drift could not remove the profile’s folder because it is in use (${error && error.code ? error.code : 'error'}). Close the profile’s window and try again.`); }
    }
    registry.profiles = registry.profiles.filter((p) => p.id !== id);
    if (registry.lastUsed === id) registry.lastUsed = DEFAULT_ID;
    try { writeRegistry(registry); }
    catch (error) { if (moved) { try { fs.renameSync(trash, dir); } catch { /* keep the data in the trash folder rather than lose it */ } } throw error; }
    runningCache.value = null;
    try { fs.rmSync(iconFile(id), { force: true }); } catch { /* the icon is only a cache */ }
    if (moved) { try { fs.rmSync(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { log.warn && log.warn('Drift could not fully erase a deleted profile; it will be retried at the next start:', error && error.message); } }
    return true;
  }

  // Removes folders left behind by an interrupted delete.
  function sweep() {
    let removed = 0;
    let entries = [];
    try { entries = fs.readdirSync(profilesRoot, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TRASH_PREFIX)) continue;
      try { fs.rmSync(path.join(profilesRoot, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); removed++; } catch { /* try again next start */ }
    }
    // Generated taskbar icons of profiles that no longer exist.
    try {
      const known = new Set(readRegistry().profiles.map((p) => p.id));
      for (const f of fs.readdirSync(path.join(root, ICONS_DIR))) {
        const m = /^([a-f0-9]{12}|default)\.ico$/.exec(f);
        if (m && !known.has(m[1])) { try { fs.rmSync(path.join(root, ICONS_DIR, f), { force: true }); } catch { /* next start */ } }
      }
    } catch { /* no icons folder yet */ }
    return removed;
  }

  return {
    DEFAULT_ID, PROFILE_COLORS, MAX_PROFILES,
    dirFor, iconFile, list, get, count, resolveActive, parseArg, launchArgs,
    create, update, remove, markUsed, sweep, reconcile, isRunning, othersRunning
  };
}

module.exports = { createProfileManager, ProfileError, DEFAULT_ID, PROFILE_COLORS, MAX_PROFILES, MAX_NAME_LENGTH, INFO_FILE, cleanName, folderSafeName, isValidId };
