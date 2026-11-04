'use strict';

// Client implementation of the Universal App Monitor psd-chunks-v1 format.
// Keep the buzhash constants and rolling-window behavior synchronized with src/delta.php.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const FORMAT = 'psd-chunks-v1';
const DEFAULT_CHUNKER = Object.freeze({ window: 64, minimum: 65536, average_mask: 0x1ffff, maximum: 1048576 });
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_CHUNKS = 10000;

let gearTable;
function gear() {
  if (gearTable) return gearTable;
  gearTable = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i += 1) {
    x = (x ^ ((x << 13) >>> 0)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ ((x << 5) >>> 0)) >>> 0;
    gearTable[i] = x;
  }
  return gearTable;
}
function rol32(value) { return ((value << 1) | (value >>> 31)) >>> 0; }
function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

function normalizeChunker(value) {
  const c = value || DEFAULT_CHUNKER;
  const result = {
    window: Number(c.window), minimum: Number(c.minimum),
    average_mask: Number(c.average_mask), maximum: Number(c.maximum)
  };
  if (result.window !== DEFAULT_CHUNKER.window || result.minimum !== DEFAULT_CHUNKER.minimum
    || result.average_mask !== DEFAULT_CHUNKER.average_mask || result.maximum !== DEFAULT_CHUNKER.maximum) {
    throw new Error('The Monitor uses an unsupported differential chunking format.');
  }
  return result;
}

/** Build a content-defined chunk index for a base installer without loading the whole installer into memory. */
async function indexFileChunks(file, options = {}) {
  const chunker = normalizeChunker(options.chunker);
  const maxChunks = Number.isInteger(options.maxChunks) ? options.maxChunks : MAX_CHUNKS;
  const table = gear();
  const window = new Uint8Array(chunker.window);
  let windowCount = 0, windowPos = 0, rolling = 0;
  let chunkOffset = 0, chunkLength = 0, chunkHash = crypto.createHash('sha256');
  const wholeHash = crypto.createHash('sha256');
  const fileStat = await fs.promises.stat(file);
  let processedBytes = 0;
  const chunks = new Map();
  const ordered = [];
  const addChunk = () => {
    if (chunkLength < 1) return;
    const hash = chunkHash.digest('hex');
    if (chunks.has(hash) && chunks.get(hash).size !== chunkLength) throw new Error('The base installer contains an inconsistent duplicate chunk.');
    const descriptor = { offset: chunkOffset, size: chunkLength, sha256: hash };
    chunks.set(hash, { offset: chunkOffset, size: chunkLength });
    ordered.push(descriptor);
    chunkOffset += chunkLength;
    if (ordered.length > maxChunks) throw new Error('The base installer contains too many differential chunks.');
    chunkLength = 0;
    chunkHash = crypto.createHash('sha256');
  };

  for await (const buf of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    wholeHash.update(buf);
    processedBytes += buf.length;
    let segmentStart = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const byte = buf[i];
      if (windowCount < chunker.window) {
        rolling = (rol32(rolling) ^ table[byte]) >>> 0;
        window[windowCount++] = byte;
      } else {
        const outgoing = window[windowPos];
        rolling = (rol32(rolling) ^ table[byte] ^ table[outgoing]) >>> 0;
        window[windowPos] = byte;
        windowPos = (windowPos + 1) % chunker.window;
      }
      const candidateSize = chunkLength + (i - segmentStart + 1);
      if (candidateSize >= chunker.minimum && ((rolling & chunker.average_mask) === 0 || candidateSize >= chunker.maximum)) {
        const part = buf.subarray(segmentStart, i + 1);
        chunkHash.update(part);
        chunkLength += part.length;
        addChunk();
        segmentStart = i + 1;
      }
    }
    if (segmentStart < buf.length) {
      const remaining = buf.subarray(segmentStart);
      chunkHash.update(remaining);
      chunkLength += remaining.length;
    }
    if (typeof options.onProgress === 'function') {
      try { options.onProgress(fileStat.size > 0 ? Math.min(1, processedBytes / fileStat.size) : 1, processedBytes, fileStat.size); } catch { /* progress is cosmetic */ }
    }
  }
  addChunk();
  const finalStat = await fs.promises.stat(file);
  if (chunkOffset !== fileStat.size || chunks.size < 1 || processedBytes !== fileStat.size
    || finalStat.size !== fileStat.size || finalStat.mtimeMs !== fileStat.mtimeMs) {
    throw new Error('The base installer changed while it was being indexed.');
  }
  return { size: fileStat.size, sha256: wholeHash.digest('hex'), chunks, ordered };
}

function validateManifest(manifest, expected = {}) {
  if (!manifest || manifest.format !== FORMAT || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(String(manifest.version || ''))) {
    throw new Error('The Monitor sent an unsupported differential manifest.');
  }
  const size = Number(manifest.size);
  const sha256 = String(manifest.sha256 || '').toLowerCase();
  if (!Number.isSafeInteger(size) || size < 1 || size > (expected.maxSize || 1024 * 1024 * 1024) || !SHA256_RE.test(sha256)) {
    throw new Error('The differential manifest has invalid release integrity metadata.');
  }
  if (expected.version && manifest.version !== expected.version) throw new Error('The differential manifest version does not match the announced release.');
  if (expected.size !== undefined && size !== expected.size) throw new Error('The differential manifest size does not match the announced release.');
  if (expected.sha256 && sha256 !== expected.sha256) throw new Error('The differential manifest checksum does not match the announced release.');
  const chunker = normalizeChunker(manifest.chunker);
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length < 1 || manifest.chunks.length > MAX_CHUNKS) {
    throw new Error('The differential manifest contains an invalid chunk list.');
  }
  let offset = 0;
  const chunks = [];
  const byHash = new Map();
  for (const item of manifest.chunks) {
    const at = Number(item && item.offset), chunkSize = Number(item && item.size), hash = String(item && item.sha256 || '').toLowerCase();
    if (!Number.isSafeInteger(at) || at !== offset || !Number.isSafeInteger(chunkSize)
      || chunkSize < 1 || chunkSize > chunker.maximum || !SHA256_RE.test(hash)) {
      throw new Error('The differential manifest contains an invalid chunk descriptor.');
    }
    if (byHash.has(hash) && byHash.get(hash).size !== chunkSize) throw new Error('The differential manifest contains an inconsistent duplicate chunk.');
    const chunk = { offset: at, size: chunkSize, sha256: hash };
    chunks.push(chunk);
    if (!byHash.has(hash)) byHash.set(hash, chunk);
    offset += chunkSize;
  }
  if (offset !== size) throw new Error('The differential manifest does not cover the complete installer.');
  return { format: FORMAT, version: manifest.version, size, sha256, chunker, chunks, byHash };
}

async function readExact(handle, length, position) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid differential archive field length.');
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead < 1) throw new Error('The differential update archive is truncated.');
    read += result.bytesRead;
  }
  return buffer;
}

/** Parse Monitor PSDDELTA stream from disk and persist each verified changed chunk separately. */
async function parseDeltaArchive(deltaFile, requestedHashes, manifest, chunkDir) {
  const requested = new Set(requestedHashes);
  if (requested.size !== requestedHashes.length) throw new Error('The differential update request contains duplicate chunks.');
  const handle = await fs.promises.open(deltaFile, 'r');
  const result = new Map();
  try {
    const stat = await handle.stat();
    if (stat.size < 12 || stat.size > 1024 * 1024 * 1024) throw new Error('The differential update archive has an invalid size.');
    const header = await readExact(handle, 12, 0);
    if (header.subarray(0, 8).toString('ascii') !== 'PSDDELTA') throw new Error('The Monitor sent an invalid differential archive.');
    const count = header.readUInt32LE(8);
    if (count !== requested.size) throw new Error('The differential archive is missing requested chunks.');
    await fs.promises.mkdir(chunkDir, { recursive: true });
    let position = 12;
    for (let i = 0; i < count; i += 1) {
      const descriptor = await readExact(handle, 40, position); position += 40;
      const hash = descriptor.subarray(0, 32).toString('hex');
      const rawSize = descriptor.readUInt32LE(32);
      const compressedSize = descriptor.readUInt32LE(36);
      const expected = manifest.byHash.get(hash);
      if (!requested.has(hash) || result.has(hash) || !expected || rawSize !== expected.size
        || rawSize < 1 || rawSize > DEFAULT_CHUNKER.maximum || compressedSize < 1 || compressedSize > DEFAULT_CHUNKER.maximum + 65536) {
        throw new Error('The differential archive contains an unexpected or invalid chunk.');
      }
      const compressed = await readExact(handle, compressedSize, position); position += compressedSize;
      let raw;
      try { raw = zlib.inflateRawSync(compressed, { maxOutputLength: rawSize }); }
      catch { throw new Error('A differential update chunk could not be decompressed.'); }
      if (raw.length !== rawSize || sha256Buffer(raw) !== hash) throw new Error('A differential update chunk failed its SHA-256 check.');
      const destination = path.join(chunkDir, `${hash}.chunk`);
      await fs.promises.writeFile(`${destination}.part`, raw);
      await fs.promises.rename(`${destination}.part`, destination);
      result.set(hash, destination);
    }
    if (position !== stat.size || result.size !== requested.size) throw new Error('The differential archive contains unexpected trailing data or missing chunks.');
  } finally { await handle.close(); }
  return result;
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (result.bytesWritten < 1) throw new Error('Could not write the reconstructed installer.');
    written += result.bytesWritten;
  }
}

/** Rebuild the new Setup.exe using existing base chunks plus downloaded chunks, then verify full-file identity. */
async function reconstructInstaller({ baseFile, baseIndex, manifest, downloadedChunks, outputFile, onProgress }) {
  const base = await fs.promises.open(baseFile, 'r');
  const output = await fs.promises.open(outputFile, 'w');
  let written = 0;
  try {
    for (let i = 0; i < manifest.chunks.length; i += 1) {
      const chunk = manifest.chunks[i];
      const existing = baseIndex.chunks.get(chunk.sha256);
      let data;
      if (existing && existing.size === chunk.size) {
        data = await readExact(base, chunk.size, existing.offset);
      } else {
        const source = downloadedChunks.get(chunk.sha256);
        if (!source) throw new Error('A required installer chunk is missing from the differential update.');
        data = await fs.promises.readFile(source);
      }
      if (data.length !== chunk.size || sha256Buffer(data) !== chunk.sha256) throw new Error('A reconstructed installer chunk failed its SHA-256 check.');
      await writeAll(output, data, written);
      written += data.length;
      if (typeof onProgress === 'function') onProgress((i + 1) / manifest.chunks.length);
    }
    await output.sync();
  } finally {
    await base.close();
    await output.close();
  }
  if (written !== manifest.size || await sha256File(outputFile) !== manifest.sha256) {
    await fs.promises.rm(outputFile, { force: true });
    throw new Error('The reconstructed installer failed its full-file size/SHA-256 check.');
  }
  const fd = await fs.promises.open(outputFile, 'r');
  try {
    const magic = await readExact(fd, 2, 0);
    if (magic.toString('latin1') !== 'MZ') throw new Error('The reconstructed update is not a Windows executable.');
  } finally { await fd.close(); }
  return { size: written, sha256: manifest.sha256 };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32Update(crc, buffer) {
  let c = crc >>> 0;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** Extract the Monitor's one-entry ZIP package with strict path, size, CRC and SHA-256 validation. */
async function extractSingleFileZip(zipFile, outputFile, options = {}) {
  const expectedEntry = String(options.entry || 'Drift-Setup.exe');
  if (path.basename(expectedEntry) !== expectedEntry || /[\\/]/.test(expectedEntry)) throw new Error('The update package announced an unsafe entry name.');
  const maxBytes = Number(options.maxBytes || 1024 * 1024 * 1024);
  const handle = await fs.promises.open(zipFile, 'r');
  let partFile = `${outputFile}.part`;
  try {
    const stat = await handle.stat();
    const tailLength = Math.min(stat.size, 65557);
    const tail = await readExact(handle, tailLength, stat.size - tailLength);
    let eocdOffset = -1;
    for (let i = tail.length - 22; i >= Math.max(0, tail.length - 65557); i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0 || eocdOffset + 22 > tail.length) throw new Error('The compressed update package is not a valid ZIP archive.');
    const eocd = tail.subarray(eocdOffset);
    const disk = eocd.readUInt16LE(4), cdDisk = eocd.readUInt16LE(6);
    const diskCount = eocd.readUInt16LE(8), totalCount = eocd.readUInt16LE(10);
    const cdSize = eocd.readUInt32LE(12), cdOffset = eocd.readUInt32LE(16);
    const commentLength = eocd.readUInt16LE(20);
    if (disk !== 0 || cdDisk !== 0 || diskCount !== 1 || totalCount !== 1 || eocdOffset + 22 + commentLength !== tail.length
      || cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize !== (stat.size - tailLength + eocdOffset)) {
      throw new Error('The update ZIP must contain exactly one supported, non-ZIP64 file.');
    }
    const cd = await readExact(handle, cdSize, cdOffset);
    if (cd.length < 46 || cd.readUInt32LE(0) !== 0x02014b50) throw new Error('The update ZIP directory is damaged.');
    const flags = cd.readUInt16LE(8), method = cd.readUInt16LE(10);
    const crc = cd.readUInt32LE(16), compressedSize = cd.readUInt32LE(20), uncompressedSize = cd.readUInt32LE(24);
    const nameLength = cd.readUInt16LE(28), extraLength = cd.readUInt16LE(30), commentLen = cd.readUInt16LE(32);
    const localOffset = cd.readUInt32LE(42);
    const entryDisk = cd.readUInt16LE(34);
    if (46 + nameLength + extraLength + commentLen !== cd.length) throw new Error('The update ZIP directory has invalid lengths.');
    const name = cd.subarray(46, 46 + nameLength).toString('utf8');
    const allowedFlags = 0x0800 | (method === 8 ? 0x0006 : 0); // UTF-8 plus standard DEFLATE compression hints
    if (entryDisk !== 0 || name !== expectedEntry || name.includes('/') || name.includes('\\') || (flags & ~allowedFlags) !== 0
      || ![0, 8].includes(method) || uncompressedSize < 1 || uncompressedSize > maxBytes
      || compressedSize < 1 || localOffset + 30 > stat.size) throw new Error('The update ZIP contains an unsupported or unsafe file.');
    if (options.expectedSize !== undefined && uncompressedSize !== Number(options.expectedSize)) throw new Error("The update ZIP's executable size does not match the release manifest.");
    const local = await readExact(handle, 30, localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method
      || local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressedSize || local.readUInt32LE(22) !== uncompressedSize) {
      throw new Error('The update ZIP local header is inconsistent.');
    }
    const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > stat.size) throw new Error('The update ZIP payload is truncated.');
    const localName = (await readExact(handle, localNameLength, localOffset + 30)).toString('utf8');
    if (localName !== expectedEntry) throw new Error('The update ZIP local filename does not match its directory.');
    await handle.close();

    const hash = crypto.createHash('sha256');
    let outBytes = 0, crcState = 0xffffffff;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        outBytes += chunk.length;
        if (outBytes > uncompressedSize || outBytes > maxBytes) return callback(new Error('The update ZIP expanded beyond its declared size.'));
        hash.update(chunk); crcState = crc32Update(crcState, chunk); callback(null, chunk);
      }
    });
    const input = fs.createReadStream(zipFile, { start: dataOffset, end: dataOffset + compressedSize - 1 });
    const stages = method === 8 ? [input, zlib.createInflateRaw(), meter, fs.createWriteStream(partFile)] : [input, meter, fs.createWriteStream(partFile)];
    await pipeline(...stages);
    const digest = hash.digest('hex');
    if (outBytes !== uncompressedSize || ((crcState ^ 0xffffffff) >>> 0) !== crc || (options.expectedSha256 && digest !== String(options.expectedSha256).toLowerCase())) {
      throw new Error('The compressed update package failed its executable CRC/SHA-256 verification.');
    }
    const exeFd = await fs.promises.open(partFile, 'r');
    try { if ((await readExact(exeFd, 2, 0)).toString('latin1') !== 'MZ') throw new Error('The extracted update is not a Windows executable.'); }
    finally { await exeFd.close(); }
    // Windows does not reliably replace an existing destination with rename(). Remove only after
    // the temporary executable has passed every integrity check, then publish the verified file.
    await fs.promises.rm(outputFile, { force: true });
    await fs.promises.rename(partFile, outputFile);
    return { size: outBytes, sha256: digest };
  } catch (error) {
    try { await handle.close(); } catch { /* already closed */ }
    await fs.promises.rm(partFile, { force: true });
    throw error;
  }
}

module.exports = {
  FORMAT, DEFAULT_CHUNKER, indexFileChunks, validateManifest, parseDeltaArchive,
  reconstructInstaller, extractSingleFileZip, sha256File, sha256Buffer
};
