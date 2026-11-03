const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const { spawn, execFile } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Drift';
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const isUninstall = process.argv.includes('--uninstall');
const srcDir = path.dirname(process.execPath); // the extracted app: it IS the payload (no second copy shipped)
const defaultDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'Drift');
const startMenu = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
app.setPath('userData', path.join(os.tmpdir(), 'drift-setup-ui')); // never touch the real Drift profile
if (isUninstall) process.chdir(os.tmpdir());
let win;

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true }, (e) => res(!e)));
const reg = (n, t, v) => run('reg', ['add', KEY, '/v', n, '/t', t, '/d', String(v), '/f']);
// Close a running *installed* Drift (never this setup process, which is also named Drift.exe)
const killInstalled = (dir) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Get-CimInstance Win32_Process -Filter "Name='Drift.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir.replace(/'/g, "''")}\\', 'OrdinalIgnoreCase') -and $_.CommandLine -notmatch '--type=|--uninstall' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`]);
const copy = (s, d, onBytes) => new Promise((res, rej) => {
  const r = fs.createReadStream(s), w = fs.createWriteStream(d);
  r.on('data', (c) => onBytes(c.length)); r.on('error', rej); w.on('error', rej); w.on('close', res); r.pipe(w);
});
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p); } return out; };

app.whenReady().then(() => {
  win = new BrowserWindow({ width: 900, height: 580, frame: false, resizable: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
});
app.on('window-all-closed', () => app.quit());

ipcMain.on('win', (_e, a) => { if (a === 'min') win.minimize(); if (a === 'close') win.close(); });
ipcMain.handle('browse', async (_e, cur) => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cur }); return r.canceled ? null : path.join(r.filePaths[0], 'Drift'); });
ipcMain.handle('info', () => ({ uninstall: isUninstall, dir: defaultDir, version: app.getVersion() }));

ipcMain.handle('install', async (_e, o) => {
  const send = (pct, phase) => win.webContents.send('progress', { pct, phase });
  try {
    send(2, 'Checking the horizon');
    await killInstalled(o.dir);
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
    const link = (dir) => shell.writeShortcutLink(path.join(dir, 'Drift.lnk'), 'create', { target: exe, cwd: o.dir, icon: exe, description: 'Drift Browser' });
    if (o.desktop) link(app.getPath('desktop'));
    if (o.startMenu) link(startMenu());
    await reg('DisplayName', 'REG_SZ', 'Drift Browser'); await reg('DisplayVersion', 'REG_SZ', app.getVersion());
    await reg('Publisher', 'REG_SZ', 'Drift contributors'); await reg('InstallLocation', 'REG_SZ', o.dir);
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
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() }).unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('launch', (_e, p) => {
  const env = { ...process.env }; delete env.PORTABLE_EXECUTABLE_FILE; delete env.PORTABLE_EXECUTABLE_DIR; delete env.PORTABLE_EXECUTABLE_APP_FILENAME; // so Drift starts as the browser, not as setup
  spawn(p, [], { detached: true, stdio: 'ignore', env, cwd: path.dirname(p) }).unref(); setTimeout(() => app.quit(), 400);
});
