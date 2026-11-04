'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { finish } = require('./test-exit.cjs');
const { createUpdater } = require('../src/main/updater.js');
const {
  FORMAT, indexFileChunks, validateManifest, parseDeltaArchive, reconstructInstaller,
  extractSingleFileZip, sha256File
} = require('../src/main/differential-update.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (error) { results.push([false, name, error]); }
}
function checksum(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function createZip(entryName, data) {
  const name = Buffer.from(entryName);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const localBlock = Buffer.concat([local, name, packed]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralBlock = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12); eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}
function makeExe(size, seed = 123456789) {
  const data = Buffer.alloc(size);
  let value = seed >>> 0;
  for (let i = 0; i < size; i += 1) { value = (1664525 * value + 1013904223) >>> 0; data[i] = value >>> 24; }
  data.write('MZ', 0, 'ascii');
  return data;
}
function buildManifest(version, exe, ordered) {
  return {
    format: FORMAT, version, size: exe.length, sha256: checksum(exe),
    chunker: { window: 64, minimum: 65536, average_mask: 0x1ffff, maximum: 1048576 },
    chunks: ordered
  };
}
function buildDeltaBuffer(exe, manifest, hashes, corrupt = false) {
  const unique = [...new Set(hashes)];
  const pieces = [Buffer.from('PSDDELTA'), Buffer.alloc(4)];
  pieces[1].writeUInt32LE(unique.length, 0);
  for (const hash of unique) {
    const chunk = manifest.chunks.find((item) => item.sha256 === hash);
    const raw = Buffer.from(exe.subarray(chunk.offset, chunk.offset + chunk.size));
    const packed = zlib.deflateRawSync(raw, { level: 1 });
    const desc = Buffer.alloc(40);
    Buffer.from(hash, 'hex').copy(desc, 0);
    desc.writeUInt32LE(raw.length, 32); desc.writeUInt32LE(packed.length, 36);
    pieces.push(desc, packed);
  }
  const result = Buffer.concat(pieces);
  return corrupt ? Buffer.concat([result, Buffer.from('unexpected')]) : result;
}
function configFor(port) {
  return {
    appId: 'drift', gatewayUrl: `http://127.0.0.1:${port}/m/api/client-gateway.php`, fallbackGatewayUrls: [], allowInsecure: true,
    requestTimeoutMs: 5000, stallTimeoutMs: 5000, minInstallerBytes: 1024, maxInstallerBytes: 1024 * 1024 * 1024,
    maxPackageBytes: 1024 * 1024 * 1024, maxManifestBytes: 16 * 1024 * 1024, maxDeltaBytes: 1024 * 1024 * 1024,
    maxInstallAttempts: 3, firstCheckDelayMs: 1e9, checkIntervalMs: 1e9
  };
}
function updaterFixture(port, root, version = '1.3.12') {
  const installDir = path.join(root, 'install'); fs.mkdirSync(installDir, { recursive: true });
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile, { recursive: true });
  const app = { isPackaged: true, getVersion: () => version, getPath: () => profile, on() {} };
  return createUpdater({
    app, force: true, platform: 'win32', arch: 'x64', execPath: path.join(installDir, 'Drift.exe'),
    fetch: (url, init) => fetch(url, init), config: configFor(port), dir: path.join(profile, 'Updates'),
    os: { hostname: () => 'TEST-PC', networkInterfaces: () => ({}) }
  });
}
function makeServer(targetExe, targetManifest, packageZip, options = {}) {
  const manifestBytes = Buffer.from(JSON.stringify(targetManifest));
  const deltaBuffer = buildDeltaBuffer(targetExe, targetManifest, targetManifest.chunks.map((c) => c.sha256), options.corruptDelta);
  const state = { calls: [], deltaRequests: 0, zipDownloads: 0, rawDownloads: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const action = url.searchParams.get('action');
    state.calls.push({ action, method: req.method, query: Object.fromEntries(url.searchParams) });
    if (url.pathname !== '/m/api/client-gateway.php' || url.searchParams.get('resource') !== 'update') { res.writeHead(404); return res.end('{}'); }
    if (action === 'latest') {
      const sha = checksum(targetExe), packageSha = checksum(packageZip);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true, app_id: 'drift', update_available: true,
        latest: {
          version: '1.3.13', size: targetExe.length, sha256: sha, notes: 'Incremental test release',
          package: { format: 'zip', size: packageZip.length, sha256: packageSha, entry: 'Drift-Setup.exe' },
          delta: { format: FORMAT, manifest_size: manifestBytes.length, manifest_sha256: checksum(manifestBytes) }
        }
      }));
    }
    if (action === 'manifest') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': manifestBytes.length });
      return res.end(manifestBytes);
    }
    if (action === 'delta') {
      state.deltaRequests += 1;
      let body = ''; for await (const part of req) body += part.toString();
      const request = JSON.parse(body);
      const data = buildDeltaBuffer(targetExe, targetManifest, request.chunks, options.corruptDelta);
      res.writeHead(200, { 'content-type': 'application/vnd.pdfstudio.delta', 'content-length': data.length });
      return res.end(data);
    }
    if (action === 'download' && url.searchParams.get('format') === 'zip') {
      state.zipDownloads += 1;
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': packageZip.length });
      return res.end(packageZip);
    }
    if (action === 'download') {
      state.rawDownloads += 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': targetExe.length });
      return res.end(targetExe);
    }
    res.writeHead(400); res.end('{}');
  });
  return { server, state };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-delta-tests-'));
  try {
    const baseExe = makeExe(8 * 1024 * 1024);
    const targetExe = Buffer.from(baseExe);
    // Change a small region so most content-defined chunks can be reused.
    for (let i = 0; i < 4096; i += 1) targetExe[3 * 1024 * 1024 + i] ^= 0x5a;
    const basePath = path.join(root, 'base.exe'); fs.writeFileSync(basePath, baseExe);
    const targetPath = path.join(root, 'target.exe'); fs.writeFileSync(targetPath, targetExe);
    const baseIndex = await indexFileChunks(basePath);
    const targetIndex = await indexFileChunks(targetPath);
    const manifest = buildManifest('1.3.13', targetExe, targetIndex.ordered);

    await test('content-defined chunk index covers the exact file and produces valid SHA-256 descriptors', async () => {
      assert.equal(targetIndex.size, targetExe.length);
      assert.equal(targetIndex.sha256, checksum(targetExe));
      assert.equal(targetIndex.ordered[0].offset, 0);
      assert.equal(targetIndex.ordered.at(-1).offset + targetIndex.ordered.at(-1).size, targetExe.length);
      for (const chunk of targetIndex.ordered) assert.equal(checksum(targetExe.subarray(chunk.offset, chunk.offset + chunk.size)), chunk.sha256);
      let progress = 0;
      const indexedAgain = await indexFileChunks(targetPath, { onProgress: (value) => { progress = value; } });
      assert.equal(indexedAgain.sha256, checksum(targetExe));
      assert.equal(progress, 1, 'file indexing reports completion');
    });

    await test('manifest validator rejects gaps, unsupported chunkers, and mismatched release checksums', async () => {
      assert.equal(validateManifest(manifest, { version: '1.3.13', size: targetExe.length, sha256: checksum(targetExe) }).chunks.length, targetIndex.ordered.length);
      const gap = structuredClone(manifest); gap.chunks[0].offset += 1;
      assert.throws(() => validateManifest(gap), /invalid chunk descriptor/i);
      const badChunker = structuredClone(manifest); badChunker.chunker.maximum = 512 * 1024;
      assert.throws(() => validateManifest(badChunker), /unsupported differential chunking/i);
      assert.throws(() => validateManifest(manifest, { sha256: '0'.repeat(64) }), /does not match/i);
    });

    await test('Monitor PSDDELTA archive parses and reconstructs exact installer bytes from changed plus cached chunks', async () => {
      const checkedManifest = validateManifest(manifest, { version: '1.3.13', size: targetExe.length, sha256: checksum(targetExe) });
      const missing = [...new Set(manifest.chunks.filter((c) => !baseIndex.chunks.has(c.sha256) || baseIndex.chunks.get(c.sha256).size !== c.size).map((c) => c.sha256))];
      assert.ok(missing.length > 0, 'fixture must contain at least one changed chunk');
      const deltaPath = path.join(root, 'test.delta'); fs.writeFileSync(deltaPath, buildDeltaBuffer(targetExe, manifest, missing));
      const chunkDir = path.join(root, 'chunks');
      const downloaded = await parseDeltaArchive(deltaPath, missing, checkedManifest, chunkDir);
      const rebuilt = path.join(root, 'rebuilt.exe');
      await reconstructInstaller({ baseFile: basePath, baseIndex, manifest: checkedManifest, downloadedChunks: downloaded, outputFile: rebuilt });
      assert.deepEqual(fs.readFileSync(rebuilt), targetExe);
      assert.equal(await sha256File(rebuilt), checksum(targetExe));
    });

    await test('delta parser rejects trailing data and corrupt compressed chunk payloads', async () => {
      const checkedManifest = validateManifest(manifest);
      const missing = [...new Set(manifest.chunks.map((c) => c.sha256))];
      const bad = path.join(root, 'bad.delta'); fs.writeFileSync(bad, buildDeltaBuffer(targetExe, manifest, missing, true));
      await assert.rejects(() => parseDeltaArchive(bad, missing, checkedManifest, path.join(root, 'bad-chunks')), /trailing data/i);
      const broken = fs.readFileSync(bad); broken[12 + 40 + 3] ^= 0xff; fs.writeFileSync(bad, broken.subarray(0, -9));
      await assert.rejects(() => parseDeltaArchive(bad, missing, checkedManifest, path.join(root, 'broken-chunks')));
    });

    await test('compressed Monitor ZIP extracts only the declared Setup.exe and verifies size, CRC and SHA-256', async () => {
      const zip = createZip('Drift-Setup.exe', targetExe);
      const zipPath = path.join(root, 'setup.zip'); fs.writeFileSync(zipPath, zip);
      const output = path.join(root, 'zip-output.exe');
      const extracted = await extractSingleFileZip(zipPath, output, { entry: 'Drift-Setup.exe', expectedSize: targetExe.length, expectedSha256: checksum(targetExe) });
      assert.equal(extracted.size, targetExe.length);
      assert.deepEqual(fs.readFileSync(output), targetExe);
      const replacement = Buffer.from('old staged file');
      fs.writeFileSync(output, replacement);
      await extractSingleFileZip(zipPath, output, { entry: 'Drift-Setup.exe', expectedSize: targetExe.length, expectedSha256: checksum(targetExe) });
      assert.deepEqual(fs.readFileSync(output), targetExe, 'verified ZIP replaces an existing staged installer on Windows');
    });

    await test('ZIP extraction rejects path traversal and checksum mismatch', async () => {
      const zip = createZip('../Drift-Setup.exe', targetExe);
      const zipPath = path.join(root, 'unsafe.zip'); fs.writeFileSync(zipPath, zip);
      await assert.rejects(() => extractSingleFileZip(zipPath, path.join(root, 'unsafe.exe'), { entry: '../Drift-Setup.exe' }), /unsafe entry/i);
      const validZipPath = path.join(root, 'valid.zip'); fs.writeFileSync(validZipPath, createZip('Drift-Setup.exe', targetExe));
      await assert.rejects(() => extractSingleFileZip(validZipPath, path.join(root, 'wrong.exe'), { entry: 'Drift-Setup.exe', expectedSha256: '0'.repeat(64) }), /CRC\/SHA-256/i);
    });

    const packageZip = createZip('Drift-Setup.exe', targetExe);
    const monitor = makeServer(targetExe, manifest, packageZip);
    await new Promise((resolve) => monitor.server.listen(0, '127.0.0.1', resolve));
    try {
      await test('updater downloads only changed chunks when a verified previous installer cache exists', async () => {
        const testRoot = path.join(root, 'delta-app'); fs.mkdirSync(testRoot);
        const updater = updaterFixture(monitor.server.address().port, testRoot);
        const baseDir = path.join(testRoot, 'profile', 'Updates', 'Base'); fs.mkdirSync(baseDir, { recursive: true });
        const cacheName = 'Drift-Setup-1.3.12.exe'; fs.copyFileSync(basePath, path.join(baseDir, cacheName));
        fs.writeFileSync(path.join(baseDir, 'base.json'), JSON.stringify({ version: '1.3.12', sha256: checksum(baseExe), size: baseExe.length, file: cacheName }));
        assert.equal(await updater.checkAndStage(), 'staged');
        const pending = JSON.parse(fs.readFileSync(updater.paths.pending, 'utf8'));
        assert.equal(pending.downloadKind, 'differential');
        assert.equal(pending.size, targetExe.length);
        assert.deepEqual(fs.readFileSync(path.join(path.dirname(updater.paths.pending), pending.file)), targetExe);
        assert.equal(monitor.state.deltaRequests, 1);
        assert.equal(monitor.state.zipDownloads, 0);
        assert.equal(monitor.state.rawDownloads, 0);
        assert.ok(pending.downloadedBytes < targetExe.length / 2);
      });

      await test('updater safely uses compressed full-package fallback when no compatible base is cached', async () => {
        const testRoot = path.join(root, 'full-fallback-app'); fs.mkdirSync(testRoot);
        const updater = updaterFixture(monitor.server.address().port, testRoot);
        const beforeZip = monitor.state.zipDownloads;
        assert.equal(await updater.checkAndStage(), 'staged');
        const pending = JSON.parse(fs.readFileSync(updater.paths.pending, 'utf8'));
        assert.equal(pending.downloadKind, 'full-zip');
        assert.deepEqual(fs.readFileSync(path.join(path.dirname(updater.paths.pending), pending.file)), targetExe);
        assert.equal(monitor.state.zipDownloads, beforeZip + 1);
        assert.equal(monitor.state.rawDownloads, 0);
      });

      await test('updater rejects a same-size but corrupted local base cache and safely uses the full package', async () => {
        const testRoot = path.join(root, 'bad-base-app'); fs.mkdirSync(testRoot);
        const updater = updaterFixture(monitor.server.address().port, testRoot);
        const baseDir = path.join(testRoot, 'profile', 'Updates', 'Base'); fs.mkdirSync(baseDir, { recursive: true });
        const cacheName = 'Drift-Setup-1.3.12.exe';
        const corruptedBase = Buffer.from(baseExe); corruptedBase[150000] ^= 0xff;
        fs.writeFileSync(path.join(baseDir, cacheName), corruptedBase);
        fs.writeFileSync(path.join(baseDir, 'base.json'), JSON.stringify({ version: '1.3.12', sha256: checksum(baseExe), size: baseExe.length, file: cacheName }));
        assert.equal(await updater.checkAndStage(), 'staged');
        const pending = JSON.parse(fs.readFileSync(updater.paths.pending, 'utf8'));
        assert.equal(pending.downloadKind, 'full-zip');
        assert.deepEqual(fs.readFileSync(path.join(path.dirname(updater.paths.pending), pending.file)), targetExe);
      });

      await test('updater falls back to the verified compressed package when the differential response is corrupt', async () => {
        const corruptMonitor = makeServer(targetExe, manifest, packageZip, { corruptDelta: true });
        await new Promise((resolve) => corruptMonitor.server.listen(0, '127.0.0.1', resolve));
        try {
          const testRoot = path.join(root, 'corrupt-delta-app'); fs.mkdirSync(testRoot);
          const updater = updaterFixture(corruptMonitor.server.address().port, testRoot);
          const baseDir = path.join(testRoot, 'profile', 'Updates', 'Base'); fs.mkdirSync(baseDir, { recursive: true });
          const cacheName = 'Drift-Setup-1.3.12.exe'; fs.copyFileSync(basePath, path.join(baseDir, cacheName));
          fs.writeFileSync(path.join(baseDir, 'base.json'), JSON.stringify({ version: '1.3.12', sha256: checksum(baseExe), size: baseExe.length, file: cacheName }));
          assert.equal(await updater.checkAndStage(), 'staged');
          const pending = JSON.parse(fs.readFileSync(updater.paths.pending, 'utf8'));
          assert.equal(pending.downloadKind, 'full-zip');
          assert.deepEqual(fs.readFileSync(path.join(path.dirname(updater.paths.pending), pending.file)), targetExe);
          assert.equal(corruptMonitor.state.zipDownloads, 1);
        } finally { await new Promise((resolve) => corruptMonitor.server.close(resolve)); }
      });
    } finally { await new Promise((resolve) => monitor.server.close(resolve)); }

    await test('update helper retains the just-installed verified Setup.exe as the next release base', async () => {
      const { buildApplyScript } = require('../src/main/updater.js');
      const script = buildApplyScript({
        pid: 7, installer: 'C:\\Profile\\Updates\\Drift-Setup-1.3.13.exe', installDir: 'C:\\Apps\\Drift',
        exe: 'C:\\Apps\\Drift\\Drift.exe', lock: 'L', pending: 'P', log: 'G', readyFile: 'R', readyToken: 'd'.repeat(48), relaunch: true,
        baseCacheDir: 'C:\\Profile\\Updates\\Base', baseFile: 'C:\\Profile\\Updates\\Base\\Drift-Setup-1.3.13.exe',
        baseMeta: 'C:\\Profile\\Updates\\Base\\base.json', baseVersion: '1.3.13', baseSha256: checksum(targetExe), baseSize: targetExe.length
      });
      assert.match(script, /Copy-Item -LiteralPath \$Installer -Destination \$BaseFile -Force/);
      assert.match(script, /version = \$BaseVersion/);
      assert.match(script, /sha256 = \$BaseSha256/);
      assert.match(script, /size = \$BaseSize/);
      assert.match(script, /cached verified v\$BaseVersion Setup/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  for (const [ok, name, error] of results) {
    if (ok) console.log(`PASS ${name}`);
    else console.error(`FAIL ${name}\n${error && error.stack || error}`);
  }
  const failed = results.filter((item) => !item[0]).length;
  console.log(`\n${results.length - failed}/${results.length} differential update tests passed.`);
  await finish(failed, []);
})();
