'use strict';

// Exercises src/main/profiles.js (registry, isolation paths, validation, safe deletion, running
// detection). No Electron needed:   npm run test:profiles

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProfileManager, ProfileError, PROFILE_COLORS, INFO_FILE, cleanName, folderSafeName, isValidId } = require('../src/main/profiles.js');
const { parseIconImages, buildIco } = require('../src/main/taskbar-icon.js');

const results = [];
const silent = { warn() {}, error() {} };
async function test(name, fn, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-profiles-'));
  const alive = new Set(options.alive || []);
  const manager = createProfileManager({ rootDir: root, pid: options.pid || 1000, isPidAlive: (p) => alive.has(p), log: silent, now: options.now });
  try { await fn(manager, root, alive); results.push([true, name]); }
  catch (error) { results.push([false, name, error]); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof ProfileError && e.code === code, `expected ProfileError ${code}`);
const writeRun = (dir, state) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'run-state.json'), JSON.stringify(state)); };

(async () => {
  await test('a fresh install has exactly one profile, "Default", stored in the root (no migration needed)', (m, root) => {
    const list = m.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'default');
    assert.equal(list[0].name, 'Default');
    assert.equal(list[0].isDefault, true);
    assert.equal(m.dirFor('default'), path.resolve(root));
    assert.equal(m.resolveActive([]), 'default');
  });

  await test('create makes an isolated folder under Profiles/ and persists to the registry', (m, root) => {
    const p = m.create({ name: '  Work  ', color: PROFILE_COLORS[1] });
    assert.match(p.id, /^[a-f0-9]{12}$/);
    assert.equal(p.name, 'Work');
    assert.equal(p.color, PROFILE_COLORS[1]);
    assert.equal(m.dirFor(p.id), path.join(root, 'Profiles', 'Work')); // the folder carries the name the user typed
    assert.ok(fs.statSync(m.dirFor(p.id)).isDirectory());
    // A second manager (another Drift process) sees the same registry.
    const other = createProfileManager({ rootDir: root, pid: 2000, log: silent });
    assert.deepEqual(other.list().map((x) => x.name), ['Default', 'Work']);
  });

  await test('profile data folders never overlap', (m, root) => {
    const a = m.create({ name: 'A' }); const b = m.create({ name: 'B' });
    const dirs = [m.dirFor('default'), m.dirFor(a.id), m.dirFor(b.id)];
    assert.equal(new Set(dirs).size, 3);
    assert.ok(!m.dirFor(a.id).startsWith(m.dirFor(b.id) + path.sep));
    assert.ok(m.dirFor(a.id).startsWith(path.join(root, 'Profiles') + path.sep));
  });

  await test('names are cleaned, required, unique (case-insensitive) and length-limited', (m) => {
    assert.equal(cleanName('a\u202eb\u0000c\n  d'), 'a b c d');
    assert.equal(cleanName('x'.repeat(100)).length, 40);
    throwsCode(() => m.create({ name: '   ' }), 'invalid-name');
    throwsCode(() => m.create({ name: '\u202e\u0000' }), 'invalid-name');
    m.create({ name: 'Personal' });
    throwsCode(() => m.create({ name: 'personal' }), 'duplicate-name');
    throwsCode(() => m.create({ name: 'DEFAULT' }), 'duplicate-name');
    throwsCode(() => m.create({ name: 'Ok', color: 'red; background:url(x)' }), 'invalid-color');
  });

  await test('profiles are limited to 20', (m) => {
    for (let i = 1; i < 20; i++) m.create({ name: `P${i}` });
    assert.equal(m.list().length, 20);
    throwsCode(() => m.create({ name: 'one too many' }), 'limit');
  });

  await test('ids are strictly validated, so a crafted id can never escape the Profiles folder', (m) => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', null, undefined, 'DEFAULT', 'zzzzzzzzzzzz', '0123456789abc']) {
      assert.equal(isValidId(bad), false, String(bad));
      assert.throws(() => m.dirFor(bad));
    }
    throwsCode(() => m.remove('../..'), 'invalid-id');
    throwsCode(() => m.update('../..', { name: 'x' }), 'invalid-id');
  });

  await test('rename and recolour work, including the Default profile', (m) => {
    const p = m.create({ name: 'Old' });
    m.update(p.id, { name: 'New', color: PROFILE_COLORS[4] });
    assert.equal(m.get(p.id).name, 'New');
    assert.equal(m.get(p.id).color, PROFILE_COLORS[4]);
    m.update('default', { name: 'Me' });
    assert.equal(m.get('default').name, 'Me');
    throwsCode(() => m.update(p.id, { name: 'Me' }), 'duplicate-name');
    throwsCode(() => m.update('0123456789ab', { name: 'Ghost' }), 'not-found');
  });

  await test('resolveActive: --profile=<id>, --profile <id>, unknown ids and last-used fallback', (m) => {
    const p = m.create({ name: 'Work' });
    assert.equal(m.resolveActive(['Drift.exe', `--profile=${p.id}`]), p.id);
    assert.equal(m.resolveActive(['Drift.exe', '--profile', p.id]), p.id);
    assert.equal(m.resolveActive(['Drift.exe', '--profile=ffffffffffff']), 'default');
    assert.equal(m.resolveActive(['Drift.exe', '--profile=../../etc']), 'default');
    assert.equal(m.markUsed(p.id), true);
    assert.equal(m.resolveActive(['Drift.exe']), p.id); // like Chrome: plain launch = last used profile
    assert.equal(m.resolveActive(['Drift.exe', '--profile=default']), 'default'); // explicit choice wins
    assert.equal(m.markUsed('ffffffffffff'), false);
    assert.deepEqual(m.launchArgs(p.id), [`--profile=${p.id}`]);
  });

  await test('a corrupt or hostile registry falls back safely and keeps valid profiles', (m, root) => {
    const p = m.create({ name: 'Keep' });
    fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({
      lastUsed: 'nope',
      profiles: [{ id: 'default', name: '' }, { id: p.id, name: 'Keep', color: 'javascript:alert(1)' }, { id: '../../x', name: 'Evil' }, { id: p.id, name: 'Dup' }, null, 5]
    }));
    const list = m.list();
    assert.deepEqual(list.map((x) => x.id), ['default', p.id]);
    assert.equal(list[0].name, 'Default');
    assert.ok(PROFILE_COLORS.includes(list[1].color));
    assert.equal(m.resolveActive([]), 'default');
    fs.writeFileSync(path.join(root, 'profiles.json'), '{ broken');
    fs.rmSync(path.join(root, 'profiles.json.bak'), { force: true });
    assert.deepEqual(m.list().map((x) => x.id), ['default']);
  });

  await test('remove erases the profile folder and registry entry, and falls back to Default', (m, root) => {
    const p = m.create({ name: 'Temp' });
    fs.writeFileSync(path.join(m.dirFor(p.id), 'bookmarks.json'), '[]');
    fs.mkdirSync(path.join(m.dirFor(p.id), 'Local Storage'));
    m.markUsed(p.id);
    assert.equal(m.remove(p.id, { activeId: 'default' }), true);
    assert.equal(fs.existsSync(m.dirFor(p.id)), false);
    assert.deepEqual(m.list().map((x) => x.id), ['default']);
    assert.equal(m.resolveActive([]), 'default');
    assert.deepEqual(fs.readdirSync(path.join(root, 'Profiles')), []); // no trash left behind
  });

  await test('remove never deletes the default, the profile in use, or a profile open in another window', (m, root, alive) => {
    const p = m.create({ name: 'Busy' });
    throwsCode(() => m.remove('default'), 'protected');
    throwsCode(() => m.remove(p.id, { activeId: p.id }), 'in-use');
    writeRun(m.dirFor(p.id), { running: true, pid: 4242 });
    alive.add(4242);
    assert.equal(m.isRunning(p.id), true);
    throwsCode(() => m.remove(p.id, { activeId: 'default' }), 'running');
    assert.ok(fs.existsSync(m.dirFor(p.id)), 'data must survive a refused delete');
    // The other window closes (clean exit) -> deletion is allowed.
    writeRun(m.dirFor(p.id), { running: false, pid: 4242 });
    assert.equal(m.remove(p.id, { activeId: 'default' }), true);
  });

  await test('a stale "running" flag from a crash (dead PID) does not block anything', (m, root) => {
    const p = m.create({ name: 'Crashed' });
    writeRun(m.dirFor(p.id), { running: true, pid: 999999 });
    assert.equal(m.isRunning(p.id), false);
    assert.equal(m.remove(p.id, { activeId: 'default' }), true);
  });

  await test('the .bak copy of run-state is ignored so an old "running" state cannot block deletion', (m) => {
    const p = m.create({ name: 'Bak' });
    writeRun(m.dirFor(p.id), { running: false, pid: 4242 });
    fs.writeFileSync(path.join(m.dirFor(p.id), 'run-state.json.bak'), JSON.stringify({ running: true, pid: 4242 }));
    assert.equal(m.isRunning(p.id), false);
  }, { alive: [4242] });

  await test('othersRunning sees other profiles but not itself, and is cached briefly', (m, root, alive) => {
    let t = 1000;
    const mgr = createProfileManager({ rootDir: root, pid: 1000, isPidAlive: (p) => alive.has(p), log: silent, now: () => t });
    const p = mgr.create({ name: 'Other' });
    writeRun(root, { running: true, pid: 1000 });          // this process (the default profile)
    assert.equal(mgr.othersRunning('default'), false);
    writeRun(mgr.dirFor(p.id), { running: true, pid: 5000 });
    alive.add(5000);
    assert.equal(mgr.othersRunning('default'), false, 'cached result');
    t += 3000;
    assert.equal(mgr.othersRunning('default'), true);
    assert.equal(mgr.othersRunning(p.id), false, 'from the other profile the default is not running');
  });

  await test('sweep removes folders left by an interrupted delete', (m, root) => {
    fs.mkdirSync(path.join(root, 'Profiles', '.deleting-abc-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Profiles', '.deleting-abc-1', 'x'), '1');
    const keep = m.create({ name: 'Keep' });
    assert.equal(m.sweep(), 1);
    assert.deepEqual(fs.readdirSync(path.join(root, 'Profiles')), ['Keep']);
  });

  await test('concurrent managers do not lose each other’s profiles (read-modify-write from disk)', (m, root) => {
    const other = createProfileManager({ rootDir: root, pid: 2000, log: silent });
    m.create({ name: 'From A' });
    other.create({ name: 'From B' });
    m.create({ name: 'From A2' });
    assert.deepEqual(other.list().map((x) => x.name), ['Default', 'From A', 'From B', 'From A2']);
  });


  await test('the AppData folder is named after the profile and holds a marker saying which profile it is', (m, root) => {
    const p = m.create({ name: 'Work' });
    assert.deepEqual(fs.readdirSync(path.join(root, 'Profiles')), ['Work']);
    const info = JSON.parse(fs.readFileSync(path.join(m.dirFor(p.id), INFO_FILE), 'utf8'));
    assert.deepEqual(info, { app: 'Drift', id: p.id, name: 'Work', color: p.color });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8')).profiles[1].dir, 'Work');
  });

  await test('renaming a profile renames its folder, keeps its data and updates the marker', (m, root) => {
    const p = m.create({ name: 'Old' });
    fs.writeFileSync(path.join(m.dirFor(p.id), 'bookmarks.json'), '[1]');
    m.update(p.id, { name: 'School' });
    assert.deepEqual(fs.readdirSync(path.join(root, 'Profiles')), ['School']);
    assert.equal(m.dirFor(p.id), path.join(root, 'Profiles', 'School'));
    assert.equal(fs.readFileSync(path.join(m.dirFor(p.id), 'bookmarks.json'), 'utf8'), '[1]');
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.dirFor(p.id), INFO_FILE), 'utf8')).name, 'School');
    // A colour-only change must not touch the folder name but must refresh the marker.
    m.update(p.id, { color: PROFILE_COLORS[3] });
    assert.equal(m.dirFor(p.id), path.join(root, 'Profiles', 'School'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.dirFor(p.id), INFO_FILE), 'utf8')).color, PROFILE_COLORS[3]);
  });

  await test('a case-only rename ("work" -> "Work") is applied to the folder too', (m, root) => {
    const p = m.create({ name: 'work' });
    m.update(p.id, { name: 'Work' });
    assert.deepEqual(fs.readdirSync(path.join(root, 'Profiles')), ['Work']);
  });

  await test('the folder of an open profile is never moved; its marker updates now and the folder follows once it closes', (m, root, alive) => {
    const p = m.create({ name: 'Live' });
    writeRun(m.dirFor(p.id), { running: true, pid: 4242 });
    alive.add(4242);
    m.update(p.id, { name: 'Renamed' });                       // renamed from another window while it is open
    assert.equal(m.get(p.id).name, 'Renamed');
    assert.equal(m.dirFor(p.id), path.join(root, 'Profiles', 'Live'), 'folder stays put while in use');
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.dirFor(p.id), INFO_FILE), 'utf8')).name, 'Renamed');
    assert.equal(m.reconcile(), 0);
    // the profile's own process must also never move itself, even if its run-state were missing
    fs.rmSync(path.join(m.dirFor(p.id), 'run-state.json'));
    assert.equal(m.reconcile({ selfId: p.id }), 0);
    assert.equal(m.dirFor(p.id), path.join(root, 'Profiles', 'Live'));
    writeRun(m.dirFor(p.id), { running: false, pid: 4242 });  // window closed
    assert.equal(m.reconcile(), 1);
    assert.deepEqual(fs.readdirSync(path.join(root, 'Profiles')), ['Renamed']);
    assert.equal(m.dirFor(p.id), path.join(root, 'Profiles', 'Renamed'));
  });

  await test('profiles from older builds (folder named by id) move to a name-based folder at the next start', (m, root) => {
    const id = 'abcdef012345';
    fs.mkdirSync(path.join(root, 'Profiles', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'Profiles', id, 'history.json'), '[]');
    fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({ version: 1, lastUsed: 'default', profiles: [{ id: 'default', name: 'Default' }, { id, name: 'Legacy', color: PROFILE_COLORS[2], createdAt: 1 }] }));
    assert.equal(m.dirFor(id), path.join(root, 'Profiles', id), 'works unchanged before the migration');
    assert.equal(m.reconcile(), 1);
    assert.equal(m.dirFor(id), path.join(root, 'Profiles', 'Legacy'));
    assert.ok(fs.existsSync(path.join(root, 'Profiles', 'Legacy', 'history.json')));
    assert.equal(fs.existsSync(path.join(root, 'Profiles', id)), false);
  });

  await test('folder names are safe on every OS and unique even when two names clean up the same', (m, root) => {
    assert.equal(folderSafeName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
    assert.equal(folderSafeName('..hidden. '), 'hidden');
    assert.equal(folderSafeName('CON'), 'CON profile');
    assert.equal(folderSafeName('nul.txt'), 'nul.txt profile');
    assert.equal(folderSafeName('///'), 'Profile');
    assert.equal(folderSafeName('日本語 プロフィール'), '日本語 プロフィール');
    const a = m.create({ name: 'a/b' }); const b = m.create({ name: 'ab' }); const c = m.create({ name: 'A:B' });
    assert.deepEqual([m.dirFor(a.id), m.dirFor(b.id), m.dirFor(c.id)].map((d) => path.basename(d)), ['ab', 'ab (2)', 'AB (3)']);
    fs.mkdirSync(path.join(root, 'Profiles', 'Stray'));                     // a leftover folder is never reused
    assert.equal(path.basename(m.dirFor(m.create({ name: 'Stray' }).id)), 'Stray (2)');
  });

  await test('a tampered folder name in the registry can never point outside Profiles/', (m, root) => {
    const p = m.create({ name: 'Real' });
    for (const dir of ['../../evil', '..', '.hidden', 'a/b', 'a\\b', 'C:\\x', '', 'CON', 'x.']) {
      fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({ profiles: [{ id: 'default', name: 'Default' }, { id: p.id, name: 'Real', dir }] }));
      assert.equal(m.dirFor(p.id), path.join(root, 'Profiles', p.id), `dir ${JSON.stringify(dir)}`);
    }
  });

  await test('removing a profile deletes the renamed folder and its generated taskbar icon', (m, root) => {
    const p = m.create({ name: 'Gone' });
    fs.mkdirSync(path.dirname(m.iconFile(p.id)), { recursive: true });
    fs.writeFileSync(m.iconFile(p.id), 'ico');
    fs.writeFileSync(m.iconFile('0123456789ab'), 'orphan');
    m.remove(p.id, { activeId: 'default' });
    assert.equal(fs.existsSync(m.iconFile(p.id)), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'Profiles')), []);
    m.sweep();
    assert.equal(fs.existsSync(m.iconFile('0123456789ab')), false, 'orphan icons are swept');
  });

  await test('taskbar icon: PNGs are packed into a valid .ico and anything else is rejected', () => {
    const png = (size, extra = 40) => {
      const b = Buffer.alloc(33 + extra);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
      b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(size, 16); b.writeUInt32BE(size, 20);
      return `data:image/png;base64,${b.toString('base64')}`;
    };
    const parsed = parseIconImages([{ size: 256, dataUrl: png(256) }, { size: 16, dataUrl: png(16) }, { size: 32, dataUrl: png(32) }]);
    assert.deepEqual(parsed.map((x) => x.size), [16, 32, 256]);
    const ico = buildIco(parsed);
    assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 3);
    assert.equal(ico.readUInt8(6), 16); assert.equal(ico.readUInt8(6 + 32), 0, '256px is stored as 0');
    for (let i = 0; i < 3; i++) { // every entry points at its own PNG
      const len = ico.readUInt32LE(6 + 16 * i + 8); const off = ico.readUInt32LE(6 + 16 * i + 12);
      assert.equal(ico.subarray(off, off + 8).equals(parsed[i].png.subarray(0, 8)), true);
      assert.equal(ico.readUInt32BE(off + 16), parsed[i].size);
      assert.equal(len, parsed[i].png.length);
    }
    assert.equal(ico.length, 6 + 48 + parsed.reduce((n, x) => n + x.png.length, 0));
    assert.equal(parseIconImages([]), null);
    assert.equal(parseIconImages('x'), null);
    assert.equal(parseIconImages([{ size: 32, dataUrl: png(48) }]), null, 'stated size must match the PNG');
    assert.equal(parseIconImages([{ size: 32, dataUrl: 'data:image/png;base64,AAAA' }]), null);
    assert.equal(parseIconImages([{ size: 32, dataUrl: `data:text/html;base64,${Buffer.from('<script>').toString('base64')}` }]), null);
    assert.equal(parseIconImages([{ size: 32, dataUrl: png(32) }, { size: 32, dataUrl: png(32) }]), null, 'duplicate sizes');
    assert.equal(parseIconImages([{ size: 512, dataUrl: png(256) }]), null);
  });

  let failed = 0;
  for (const [ok, name, error] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) { failed++; console.log(`      ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} profile tests passed.`);
  process.exit(failed ? 1 : 0);
})();
