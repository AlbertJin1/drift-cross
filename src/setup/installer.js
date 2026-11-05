const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
// original-fs: Electron's normal fs treats "app.asar" as a folder (so copying it fails with EISDIR). The Setup copies
// its own payload, which must be read as plain files, app.asar included.
const path = require('path'), fs = require('original-fs'), os = require('os');
const { spawn, execFile } = require('child_process');
const { spawnDetachedConfirmed } = require('./update-launch');
const { waitForUpdateHealthcheck } = require('./update-healthcheck');
const { verifyUserWritableInstallDirectory } = require('./install-path');
const { waitForProcessExit, writeHelperReadyMarker } = require('./update-helper-runtime');

const APP_USER_MODEL_ID = 'org.drift.browser';
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Drift';
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const isUninstall = process.argv.includes('--uninstall');
const srcDir = path.dirname(process.execPath); // the extracted app: it IS the payload (no second copy shipped)
const defaultDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Drift');
const startMenu = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
app.setPath('userData', path.join(os.tmpdir(), 'drift-setup-ui')); // never touch the real Drift profile
if (isUninstall) process.chdir(os.tmpdir());
let win;
// Headless update mode, used by Drift's silent updater: no window, installs over the existing copy and exits.
const argValue = (name) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null; };
const silentUpdate = process.argv.includes('--silent-update') && !isUninstall;
const forceRun = process.argv.includes('--force-run');
const healthcheckFileArg = argValue('healthcheck-file');
const healthcheckTokenArg = argValue('healthcheck-token');
const helperReadyFileArg = argValue('helper-ready-file');
const helperReadyTokenArg = argValue('helper-ready-token');
const waitPidRaw = argValue('wait-pid');
const waitPidArg = Number(waitPidRaw || 0);
const lockFileArg = argValue('lock-file');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function writeSetupHelperReadyMarker() {
  const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Drift', 'Updates');
  return writeHelperReadyMarker(helperReadyFileArg, helperReadyTokenArg, root, fs);
}
async function cacheVerifiedSetup(log, appVersion) {
  const cacheDir = argValue('base-cache-dir');
  const destination = argValue('base-file');
  const metadataFile = argValue('base-meta');
  const version = argValue('base-version');
  const sha256 = argValue('base-sha256');
  const size = Number(argValue('base-size') || 0);
  if (!cacheDir || !destination || !metadataFile || version !== appVersion || !/^[a-f0-9]{64}$/i.test(sha256 || '') || !Number.isSafeInteger(size) || size <= 0) return false;
  const root = path.resolve(cacheDir) + path.sep;
  const dest = path.resolve(destination);
  const meta = path.resolve(metadataFile);
  if (!dest.startsWith(root) || !meta.startsWith(root)) throw new Error('The differential update cache path is invalid.');
  const source = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const stat = fs.statSync(source);
  if (stat.size !== size) throw new Error('The verified Setup package size changed before it could be cached.');
  fs.mkdirSync(cacheDir, { recursive: true });
  const temp = `${destination}.tmp-${process.pid}`;
  const tempMeta = `${metadataFile}.tmp-${process.pid}`;
  try {
    await fs.promises.copyFile(source, temp);
    await fs.promises.rename(temp, destination).catch(async (error) => {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await fs.promises.rm(destination, { force: true });
      await fs.promises.rename(temp, destination);
    });
    const contents = JSON.stringify({ version, sha256: sha256.toLowerCase(), size, file: path.basename(destination) });
    await fs.promises.writeFile(tempMeta, contents, 'utf8');
    await fs.promises.rename(tempMeta, metadataFile).catch(async (error) => {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await fs.promises.rm(metadataFile, { force: true });
      await fs.promises.rename(tempMeta, metadataFile);
    });
    for (const entry of await fs.promises.readdir(cacheDir, { withFileTypes: true })) {
      if (entry.isFile() && /^Drift-Setup-.+\.exe$/i.test(entry.name) && path.join(cacheDir, entry.name) !== destination) {
        await fs.promises.rm(path.join(cacheDir, entry.name), { force: true }).catch(() => {});
      }
    }
    log(`cached verified Setup v${version} as the next differential update base`);
    return true;
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    await fs.promises.rm(tempMeta, { force: true }).catch(() => {});
  }
}

// timeout: a stuck powershell/reg call must never leave the update (and Drift's launch behind it) hanging forever
const run = (cmd, args, timeout = 20000) => new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout }, (e) => res(!e)));
const reg = (n, t, v) => run('reg', ['add', KEY, '/v', n, '/t', t, '/d', String(v), '/f']);
// Close a running *installed* Drift (never this setup process, which is also named Drift.exe)
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const killInstalled = async (dir) => {
  const root = `${path.resolve(dir).replace(/[\\/]+$/, '')}\\`;
  const command = [
    `$ErrorActionPreference = 'Stop'`,
    `$root = ${psQuote(root)}`,
    '$deadline = [DateTime]::Now.AddSeconds(22)',
    'do {',
    `  $procs = @(Get-CimInstance Win32_Process -Filter "Name='Drift.exe'" -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })`,
    '  foreach ($p in $procs) { & taskkill.exe /PID $p.ProcessId /T /F | Out-Null }',
    '  if ($procs.Count -eq 0) { exit 0 }',
    '  if ([DateTime]::Now -gt $deadline) { exit 1 }',
    '  Start-Sleep -Milliseconds 300',
    '} while ($true)'
  ].join('\r\n');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], 25000);
};
const copy = (s, d, onBytes) => new Promise((res, rej) => {
  const r = fs.createReadStream(s), w = fs.createWriteStream(d);
  r.on('data', (c) => onBytes(c.length)); r.on('error', rej); w.on('error', rej); w.on('close', res); r.pipe(w);
});
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p); } return out; };

// ---------------------------------------------------------------- update progress window
// The silent updater used to run with no window at all, so a stuck update looked like a frozen process in Task Manager.
// This small window shows every step (closing Drift, installing, reopening) and any error.
let updateWin = null;
let updateClosable = false;
let lastUpdateState = { step: 'wait', pct: 2, title: 'Preparing the update', detail: 'Getting ready…' };
function showUpdateWindow() {
  try {
    updateWin = new BrowserWindow({ width: 460, height: 300, frame: false, resizable: false, maximizable: false, minimizable: true, alwaysOnTop: true,
      show: false, center: true, skipTaskbar: false, backgroundColor: '#0b1020', title: 'Updating Drift',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false } });
    updateWin.setMenuBarVisibility(false);
    updateWin.on('close', (event) => { if (!updateClosable) event.preventDefault(); });
    updateWin.webContents.on('did-finish-load', () => { try { updateWin.webContents.send('update-state', lastUpdateState); } catch {} });
    // The first update from an older Drift starts this helper with a hidden-window flag, and Windows then ignores the
    // first ShowWindow call. Showing twice guarantees the window appears for that one transition update as well.
    updateWin.once('ready-to-show', () => {
      try { updateWin.show(); updateWin.focus(); } catch {}
      setTimeout(() => { try { if (updateWin && !updateWin.isDestroyed()) { updateWin.show(); updateWin.moveTop(); } } catch {} }, 250);
    });
    updateWin.loadFile(path.join(__dirname, 'update.html'));
    // Never leave the window invisible: show it even if ready-to-show is missed.
    setTimeout(() => { try { if (updateWin && !updateWin.isDestroyed() && !updateWin.isVisible()) updateWin.show(); } catch {} }, 2500);
  } catch { updateWin = null; }
}
function updateUi(state) {
  lastUpdateState = { ...lastUpdateState, ...state };
  try { if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update-state', lastUpdateState); } catch {}
}
const closeUpdateWindow = () => { updateClosable = true; try { if (updateWin && !updateWin.isDestroyed()) updateWin.destroy(); } catch {} updateWin = null; };

app.whenReady().then(() => {
  if (silentUpdate) {
    try { writeSetupHelperReadyMarker(); }
    catch (error) {
      try { fs.appendFileSync(path.join(process.env.APPDATA || os.tmpdir(), 'Drift', 'Updates', 'updater.log'), `[${new Date().toISOString()}] setup helper readiness failed: ${error.message}\n`); } catch {}
      app.exit(1);
      return;
    }
    showUpdateWindow();
    runSilentUpdate();
    return;
  }
  win = new BrowserWindow({ width: 900, height: 580, frame: false, resizable: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
});
app.on('window-all-closed', () => { if (!silentUpdate) app.quit(); }); // the update helper window closes itself when the update is finished

ipcMain.on('win', (_e, a) => { if (!win) return; if (a === 'min') win.minimize(); if (a === 'close') win.close(); });
ipcMain.on('update-close', () => { if (updateWin && !updateWin.isDestroyed() && updateClosable) updateWin.destroy(); });
ipcMain.handle('browse', async (_e, cur) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: path.dirname(cur || defaultDir) });
  if (r.canceled || !r.filePaths[0]) return null;
  const candidate = path.join(r.filePaths[0], 'Drift');
  try { return verifyUserWritableInstallDirectory(candidate, defaultDir); }
  catch (error) {
    await dialog.showMessageBox(win, { type: 'warning', title: 'Choose a user-writable folder',
      message: 'Drift does not use administrator permissions.', detail: error.message, buttons: ['Choose another folder'] });
    return null;
  }
});
ipcMain.handle('info', () => ({ uninstall: isUninstall, dir: defaultDir, version: app.getVersion() }));

ipcMain.handle('install', async (_e, o) => {
  const send = (pct, phase) => win.webContents.send('progress', { pct, phase });
  try {
    send(2, 'Checking the horizon');
    // Revalidate the renderer-supplied path at the privileged boundary. The
    // installer never self-elevates and never writes to Program Files/HKLM.
    o = { ...o, dir: verifyUserWritableInstallDirectory(o?.dir || defaultDir, defaultDir) };
    if (!(await killInstalled(o.dir))) throw new Error('Drift is still running or Windows could not close it. Close Drift and retry the installation.');
    const files = walk(srcDir), total = files.reduce((s, f) => s + fs.statSync(f).size, 0) || 1;
    const phases = ['Unfurling the sails', 'Gathering the wind', 'Setting the course', 'Trimming the lines'];
    let done = 0, last = 0;
    for (const f of files) {
      const dest = path.join(o.dir, path.relative(srcDir, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await copy(f, dest, (n) => { done += n; const now = Date.now(); if (now - last > 80) { last = now; const p = done / total; send(4 + p * 82, phases[Math.min(3, Math.floor(p * 4))]); } });
    }
    send(88, 'Leaving a trail');
    const exe = path.join(o.dir, 'Drift.exe');
    const link = (dir) => shell.writeShortcutLink(path.join(dir, 'Drift.lnk'), 'create', { target: exe, cwd: o.dir, icon: exe, description: 'Drift Browser', appUserModelId: APP_USER_MODEL_ID });
    if (o.desktop) link(app.getPath('desktop'));
    if (o.startMenu) link(startMenu());
    await reg('DisplayName', 'REG_SZ', 'Drift Browser'); await reg('DisplayVersion', 'REG_SZ', app.getVersion());
    await reg('Publisher', 'REG_SZ', 'Jessie Albert Regualos (Yotsuchi)'); await reg('InstallLocation', 'REG_SZ', o.dir);
    await reg('DisplayIcon', 'REG_SZ', exe); await reg('NoModify', 'REG_DWORD', 1); await reg('NoRepair', 'REG_DWORD', 1);
    await reg('UninstallString', 'REG_SZ', `"${exe}" --uninstall`); // installed Drift.exe doubles as the uninstaller
    send(95, 'Making it yours');
    const sd = path.join(process.env.APPDATA, 'Drift'), sf = path.join(sd, 'settings.json');
    if (!fs.existsSync(sf)) { fs.mkdirSync(sd, { recursive: true }); fs.writeFileSync(sf, JSON.stringify({ colorTheme: o.theme, appearance: o.mode })); }
    if (o.login) await run('reg', ['add', RUN, '/v', 'Drift', '/t', 'REG_SZ', '/d', `"${exe}"`, '/f']);
    send(100, 'Ready');
    return { ok: true, exe };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('uninstall', async (_e, o) => {
  try {
    const dir = srcDir;
    await killInstalled(dir);
    for (const d of [app.getPath('desktop'), startMenu()]) { try { fs.rmSync(path.join(d, 'Drift.lnk')); } catch {} }
    await run('reg', ['delete', KEY, '/f']);
    await run('reg', ['delete', RUN, '/v', 'Drift', '/f']);
    if (o.wipe) fs.rmSync(path.join(process.env.APPDATA, 'Drift'), { recursive: true, force: true });
    const bat = path.join(os.tmpdir(), 'drift-cleanup.bat'); // retries until this process has exited and the folder is free
    fs.writeFileSync(bat, `@echo off\r\nfor /l %%i in (1,1,90) do (\r\n  rmdir /s /q "${dir}" 2>nul\r\n  if not exist "${dir}" goto done\r\n  ping -n 2 127.0.0.1 >nul\r\n)\r\n:done\r\ndel "%~f0"\r\n`);
    // conhost --headless gives the helper (and its ping delays) a console that is never shown. A plain detached
    // cmd.exe opens a visible console, which Windows Terminal turns into a flashing "ping" window.
    const helper = spawn('conhost.exe', ['--headless', 'cmd.exe', '/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() });
    helper.on('error', () => spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() }).unref());
    helper.unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('launch', (_e, p) => {
  const env = { ...process.env }; delete env.PORTABLE_EXECUTABLE_FILE; delete env.PORTABLE_EXECUTABLE_DIR; delete env.PORTABLE_EXECUTABLE_APP_FILENAME; // so Drift starts as the browser, not as setup
  spawn(p, [], { detached: true, stdio: 'ignore', env, cwd: path.dirname(p) }).unref(); setTimeout(() => app.quit(), 400);
});

// ---------------------------------------------------------------- silent update (no UI)
// Copies this extracted payload into a side folder first and swaps it in with two renames, so a failure or power
// cut never leaves a half-updated install: the old folder is kept until the new one is in place.
const copyRetry = async (s, d) => {
  for (let attempt = 1; ; attempt++) {
    try { await fs.promises.copyFile(s, d); return; } catch (e) { if (attempt >= 8) throw e; await sleep(400); }
  }
};
// Several files at a time (thousands of small files dominate the time, not the bytes).
const copyAll = async (files, mapDest, onFile) => {
  const made = new Set();
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++], dest = mapDest(f), folder = path.dirname(dest);
      if (!made.has(folder)) { fs.mkdirSync(folder, { recursive: true }); made.add(folder); }
      await copyRetry(f, dest);
      if (onFile) onFile();
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
};
const renameRetry = async (from, to) => {
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (e) { if (attempt >= 20) throw e; await sleep(500); } // files may be briefly held by antivirus or a closing process
  }
};
const removeDirRetry = async (directory, attempts = 24) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }); return; }
    catch (error) { lastError = error; if (attempt < attempts) await sleep(500); }
  }
  throw lastError || new Error(`Could not remove ${directory}.`);
};
// Ends every Drift process that still runs from the install folder (main process, GPU/renderer/utility children, the
// VPN helper). A browser that "closed" but left processes behind used to keep the update waiting and the folder locked.
async function forceCloseInstalledDrift(dir, log) {
  const ok = await killInstalled(dir);
  log(ok ? 'no Drift process is left running from the install folder' : 'some Drift processes could not be closed');
  return ok;
}
async function runSilentUpdate() {
  const logFile = argValue('log-file') || path.join(process.env.APPDATA || os.tmpdir(), 'Drift', 'Updates', 'updater.log');
  const log = (m) => { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toISOString()}] setup: ${m}\n`); } catch {} };
  const dir = argValue('update-dir');
  const healthcheckFile = healthcheckFileArg;
  const healthcheckToken = healthcheckTokenArg;
  const stage = `${dir}.update`, old = `${dir}.old`;
  const newVersion = app.getVersion();
  let launched = null;
  let swapped = false;     // the install folder now holds the new version
  let inPlace = false;     // fallback used: files were copied over the live folder, no .old backup exists
  let failureMessage = '';
  const launchEnv = () => {
    const env = { ...process.env };
    delete env.PORTABLE_EXECUTABLE_FILE; delete env.PORTABLE_EXECUTABLE_DIR; delete env.PORTABLE_EXECUTABLE_APP_FILENAME;
    return env;
  };
  // NOTE: no windowsHide here. STARTF_USESHOWWINDOW/SW_HIDE makes Windows ignore the first ShowWindow call of the child,
  // so the browser started but its window never appeared: Drift sat invisibly in Task Manager and "did not open".
  const launchDrift = (extraEnv = {}) => spawnDetachedConfirmed(spawn, path.join(dir, 'Drift.exe'), [], {
    detached: true, stdio: 'ignore', env: { ...launchEnv(), ...extraEnv }, cwd: dir
  }, 20000);
  try {
    if (!dir || path.resolve(dir).toLowerCase() === path.resolve(srcDir).toLowerCase() || !fs.existsSync(path.join(dir, 'Drift.exe'))) throw new Error(`"${dir}" is not an existing Drift install`);
    if (waitPidRaw !== null && (!Number.isSafeInteger(waitPidArg) || waitPidArg <= 0 || waitPidArg === process.pid)) throw new Error('The update helper received an invalid parent Drift PID.');
    if (forceRun && (!healthcheckFile || !/^[a-f0-9]{32,64}$/i.test(healthcheckToken || ''))) throw new Error('The update launch health-check parameters are missing or invalid.');
    log(`updating ${dir} to ${newVersion}`);

    // ---- 1. close Drift (politely first, then for real)
    updateUi({ step: 'close', pct: 6, title: `Updating Drift to v${newVersion}`, detail: 'Closing Drift…' });
    if (waitPidArg) {
      log(`waiting for the current Drift process ${waitPidArg} to exit`);
      try { await waitForProcessExit(waitPidArg, { timeoutMs: 10000 }); log(`Drift process ${waitPidArg} exited on its own`); }
      catch {
        log(`Drift process ${waitPidArg} is still alive after 10s; ending it`);
        await run('taskkill.exe', ['/PID', String(waitPidArg), '/T', '/F'], 10000);
        await waitForProcessExit(waitPidArg, { timeoutMs: 10000 }).catch(() => log('the old Drift process is still listed; continuing with a forced folder cleanup'));
      }
    }
    await forceCloseInstalledDrift(dir, log);
    await sleep(700);

    // ---- 2. stage the new files next to the install folder
    updateUi({ step: 'copy', pct: 12, detail: 'Preparing the new version…' });
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    const payloadFiles = walk(srcDir);
    if (!payloadFiles.some((f) => path.basename(f).toLowerCase() === 'drift.exe')
      || !payloadFiles.some((f) => path.basename(f).toLowerCase() === 'app.asar')) throw new Error('The downloaded Setup payload is incomplete (Drift.exe or resources/app.asar is missing).');
    let copied = 0;
    await copyAll(payloadFiles, (f) => path.join(stage, path.relative(srcDir, f)), () => {
      copied += 1;
      if (copied % 6 === 0 || copied === payloadFiles.length) updateUi({ step: 'copy', pct: 12 + Math.round((copied / payloadFiles.length) * 63), detail: `Installing files (${copied} of ${payloadFiles.length})…` });
    });
    if (!fs.existsSync(path.join(stage, 'Drift.exe')) || !fs.existsSync(path.join(stage, 'resources', 'app.asar'))) throw new Error('The staged application files are incomplete.');

    // ---- 3. swap the folders (fast, atomic, with backup); if Windows keeps a file locked, overwrite in place instead
    updateUi({ step: 'swap', pct: 78, detail: 'Switching to the new version…' });
    try {
      await renameRetry(dir, old);
      try { await renameRetry(stage, dir); }
      catch (e) { await renameRetry(old, dir); throw e; }
      swapped = true;
    } catch (swapError) {
      log(`folder swap failed (${swapError.message}); ending leftover Drift processes and copying over the install folder`);
      await forceCloseInstalledDrift(dir, log);
      await sleep(800);
      if (!fs.existsSync(dir) && fs.existsSync(old)) { try { fs.renameSync(old, dir); } catch {} }
      if (!fs.existsSync(path.join(dir, 'Drift.exe')) && !fs.existsSync(stage)) throw swapError;
      const stagedFiles = walk(stage);
      await copyAll(stagedFiles, (f) => path.join(dir, path.relative(stage, f)));
      swapped = true; inPlace = true;
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
    log(`the install folder now holds v${newVersion}${inPlace ? ' (copied in place)' : ''}`);

    // ---- 4. reopen Drift and wait until its window is really up
    if (forceRun) {
      updateUi({ step: 'launch', pct: 86, detail: 'Opening the updated Drift…' });
      try {
        launched = await launchDrift({
          DRIFT_UPDATE_HEALTHCHECK_FILE: healthcheckFile,
          DRIFT_UPDATE_HEALTHCHECK_TOKEN: healthcheckToken,
          DRIFT_UPDATE_EXPECTED_VERSION: newVersion
        });
        updateUi({ step: 'verify', pct: 92, detail: 'Waiting for the browser window…' });
        let confirmed = null;
        try {
          confirmed = await waitForUpdateHealthcheck(healthcheckFile, newVersion, healthcheckToken, {
            timeoutMs: 45000, pollMs: 250,
            isProcessAlive: () => launched && launched.exitCode === null && launched.signalCode === null
          });
          log(`new browser health-check passed for v${confirmed.version}, pid ${confirmed.pid}`);
        } catch (checkError) {
          // Only a browser that exited counts as a failed launch. One that is still running but slow to acknowledge is kept:
          // rolling back a healthy new version is what made updates "revert" to the old number.
          const exited = !(launched && launched.exitCode === null && launched.signalCode === null);
          if (exited) throw checkError;
          log(`new browser is running but has not acknowledged yet (${checkError.message}); keeping v${newVersion}`);
        }
      } catch (launchError) {
        if (launched && Number.isInteger(launched.pid)) {
          await run('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], 10000);
          await waitForProcessExit(launched.pid, { timeoutMs: 12000 }).catch(() => {});
        }
        await forceCloseInstalledDrift(dir, log);
        if (inPlace || !fs.existsSync(old)) throw new Error(`The updated Drift did not open (${launchError.message}).`);
        updateUi({ step: 'rollback', pct: 90, detail: 'The new version did not open. Restoring the previous version…' });
        log(`updated Drift did not become ready; restoring previous version: ${launchError.message}`);
        await sleep(700);
        await removeDirRetry(dir);
        await renameRetry(old, dir);
        swapped = false;
        throw new Error(`The update was rolled back because the new browser did not open successfully (${launchError.message}).`);
      }
    }

    if (waitPidArg) {
      try { await cacheVerifiedSetup(log, newVersion); }
      catch (cacheError) { log(`differential base cache was not refreshed: ${cacheError.message}`); }
    }
    try { fs.rmSync(old, { recursive: true, force: true }); }
    catch (cleanupError) { log(`old-version cleanup will be retried later: ${cleanupError.message}`); }
    if (await run('reg', ['query', KEY])) await reg('DisplayVersion', 'REG_SZ', newVersion);
    log('update installed' + (forceRun ? ' and new browser startup health-check passed' : ''));
    updateUi({ step: 'done', pct: 100, title: 'Drift is up to date', detail: `Now running v${newVersion}.` });
    await sleep(1400);
    closeUpdateWindow();
    setImmediate(() => app.exit(0));
  } catch (e) {
    failureMessage = String(e && e.message ? e.message : e).slice(0, 500);
    log(`update failed: ${failureMessage}`);
    updateUi({ step: 'error', pct: 100, title: 'The update could not be installed', detail: failureMessage, error: true });
    if (waitPidArg) {
      try {
        const pendingFile = argValue('pending-file');
        if (pendingFile && fs.existsSync(pendingFile)) {
          const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
          pending.nextAttemptAt = Date.now() + 15 * 60 * 1000;
          pending.lastError = failureMessage;
          const tempPending = `${pendingFile}.tmp-${process.pid}`;
          fs.writeFileSync(tempPending, JSON.stringify(pending, null, 2));
          fs.renameSync(tempPending, pendingFile);
          log('saved a 15-minute retry delay; manual retry remains available');
        }
      } catch (stateError) { log(`could not save update retry state: ${stateError.message}`); }
    }
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    let canRelaunchPrevious = false;
    try {
      if (Number.isInteger(launched?.pid)) {
        await run('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], 10000);
        await waitForProcessExit(launched.pid, { timeoutMs: 12000 }).catch(() => {});
      }
      if (!swapped && fs.existsSync(old)) {
        if (fs.existsSync(dir)) await removeDirRetry(dir);
        await renameRetry(old, dir);
        log('previous Drift installation restored');
      }
      canRelaunchPrevious = fs.existsSync(path.join(dir, 'Drift.exe'));
    } catch (rollbackError) { log(`automatic rollback failed: ${rollbackError.message}`); }
    // Always bring a Drift back (the previous one, or the new one when only its acknowledgement failed): never leave the user with nothing open.
    if (canRelaunchPrevious && (forceRun || waitPidArg)) {
      try {
        const previous = await launchDrift();
        log(`reopened Drift after the failed update (pid ${previous.pid || 'unknown'})`);
      } catch (relaunchError) { log(`could not reopen Drift: ${relaunchError.message}`); }
    }
    // Release the lock now: the reopened Drift must not wait behind this window while the error is on screen.
    if (lockFileArg) { try { fs.rmSync(lockFileArg, { force: true }); } catch {} }
    if (helperReadyFileArg) { try { fs.rmSync(helperReadyFileArg, { force: true }); } catch {} }
    // Leave the error on screen so it can be read; the user closes it (or it closes itself after a while).
    updateClosable = true;
    await Promise.race([new Promise((resolve) => { if (updateWin && !updateWin.isDestroyed()) updateWin.once('closed', resolve); else resolve(); }), sleep(60000)]);
    closeUpdateWindow();
    setImmediate(() => app.exit(1));
  } finally {
    // New direct-helper updates own the lock themselves. Legacy PowerShell
    // callers retain ownership and remove it after this Setup process exits.
    if (lockFileArg) { try { fs.rmSync(lockFileArg, { force: true }); } catch {} }
    if (helperReadyFileArg) { try { fs.rmSync(helperReadyFileArg, { force: true }); } catch {} }
  }
}
