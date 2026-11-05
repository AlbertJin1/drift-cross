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
//   <root>\Profiles\<id>\         every additional profile
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
const TRASH_PREFIX = '.deleting-';
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

function createProfileManager({ rootDir, pid = process.pid, isPidAlive = defaultIsPidAlive, now = Date.now, log = console }) {
  if (!rootDir) throw new Error('createProfileManager needs a root directory.');
  const root = path.resolve(rootDir);
  const profilesRoot = path.join(root, PROFILES_DIR);
  const registryStore = createStorage({ getDir: () => root, log });
  let runningCache = { at: 0, value: null, selfId: null };

  const isInside = (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  function dirFor(id) {
    if (!isValidId(id)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    if (id === DEFAULT_ID) return root;
    const dir = path.join(profilesRoot, id);
    if (!isInside(profilesRoot, dir)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    return dir;
  }

  // ---- registry --------------------------------------------------------------------------
  // Always re-read from disk before changing anything: several Drift processes (one per open
  // profile) share this file.
  function sanitize(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set([DEFAULT_ID]);
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
      profiles.push({
        id: entry.id,
        name,
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
  function readRunState(id) {
    // Only the main file: the .bak copy holds the *previous* state and could wrongly say "running".
    try { return JSON.parse(fs.readFileSync(path.join(dirFor(id), 'run-state.json'), 'utf8')); } catch { return null; }
  }
  function isRunning(id, selfId = null) {
    if (selfId && id === selfId) return true;
    const state = readRunState(id);
    return !!state && state.running === true && Number.isInteger(state.pid) && state.pid !== pid && isPidAlive(state.pid);
  }
  function othersRunning(selfId) {
    const t = now();
    if (runningCache.selfId === selfId && runningCache.value !== null && t - runningCache.at < RUNNING_CACHE_MS) return runningCache.value;
    let value = false;
    for (const p of readRegistry().profiles) { if (p.id !== selfId && isRunning(p.id)) { value = true; break; } }
    runningCache = { at: t, value, selfId };
    return value;
  }
  const decorate = (p, selfId) => ({ ...p, isDefault: p.id === DEFAULT_ID, running: isRunning(p.id, selfId) });
  function list(selfId = null) { return readRegistry().profiles.map((p) => decorate(p, selfId)); }
  function get(id, selfId = null) { const p = readRegistry().profiles.find((x) => x.id === id); return p ? decorate(p, selfId) : null; }
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

  function create({ name, color } = {}) {
    const registry = readRegistry();
    if (registry.profiles.length >= MAX_PROFILES) throw new ProfileError('limit', `Drift supports up to ${MAX_PROFILES} profiles.`);
    const clean = validateName(name, registry);
    const used = new Set(registry.profiles.map((p) => p.color));
    const fallback = PROFILE_COLORS.find((c) => !used.has(c)) || PROFILE_COLORS[registry.profiles.length % PROFILE_COLORS.length];
    let id;
    do { id = crypto.randomBytes(6).toString('hex'); } while (registry.profiles.some((p) => p.id === id));
    const profile = { id, name: clean, color: validateColor(color, fallback), createdAt: now() };
    try { fs.mkdirSync(dirFor(id), { recursive: true }); }
    catch (error) { throw new ProfileError('write-failed', `Drift could not create the profile folder: ${error && error.message ? error.message : error}`); }
    registry.profiles.push(profile);
    try { writeRegistry(registry); }
    catch (error) { try { fs.rmSync(dirFor(id), { recursive: true, force: true }); } catch { /* nothing was stored yet */ } throw error; }
    runningCache.value = null;
    return decorate(profile, null);
  }

  function update(id, { name, color } = {}) {
    if (!isValidId(id)) throw new ProfileError('invalid-id', 'That profile does not exist.');
    const registry = readRegistry();
    const profile = registry.profiles.find((p) => p.id === id);
    if (!profile) throw new ProfileError('not-found', 'That profile no longer exists.');
    if (name !== undefined) profile.name = validateName(name, registry, id);
    if (color !== undefined) profile.color = validateColor(color, profile.color);
    writeRegistry(registry);
    return decorate(profile, null);
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
    if (isRunning(id)) throw new ProfileError('running', 'This profile is open in another Drift window. Close that window first, then delete the profile.');
    const dir = dirFor(id);
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
    return removed;
  }

  return {
    DEFAULT_ID, PROFILE_COLORS, MAX_PROFILES,
    dirFor, list, get, count, resolveActive, parseArg, launchArgs,
    create, update, remove, markUsed, sweep, isRunning, othersRunning
  };
}

module.exports = { createProfileManager, ProfileError, DEFAULT_ID, PROFILE_COLORS, MAX_PROFILES, MAX_NAME_LENGTH, cleanName, isValidId };
