'use strict';
// Per-profile taskbar icon helpers (pure Node, unit-tested without Electron: npm run test:profiles).
//
// The browser chrome draws the Drift icon with the profile's coloured initial badge at several sizes and sends the PNGs
// here. Windows wants a real .ico for a pinned taskbar button (`appIconPath`), so the PNGs are packed into one. Modern
// Windows reads PNG-compressed entries natively, so no bitmap conversion is needed.
const fs = require('fs');
const path = require('path');

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_IMAGES = 8;
const MAX_PNG_BYTES = 400 * 1024;
const MIN_SIZE = 16;
const MAX_SIZE = 256; // the ICO format stores width/height in one byte (0 = 256)

// Accepts [{ size, dataUrl }, ...] from the renderer and returns [{ size, png }] sorted small to large.
// Anything that is not a square PNG of the stated size is rejected, so a compromised page cannot write arbitrary bytes.
function parseIconImages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_IMAGES) return null;
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const size = item && item.size;
    const text = item && item.dataUrl;
    if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE || seen.has(size)) return null;
    if (typeof text !== 'string' || text.length > MAX_PNG_BYTES * 2) return null;
    const match = PNG_DATA_URL.exec(text);
    if (!match) return null;
    const png = Buffer.from(match[1], 'base64');
    if (png.length < 33 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) return null; // IHDR width / height
    seen.add(size);
    out.push({ size, png });
  }
  return out.sort((a, b) => a.size - b.size);
}

// Packs PNG images into an .ico file.
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6 + 16 * count);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const at = 6 + 16 * i;
    const dim = image.size >= 256 ? 0 : image.size;
    header.writeUInt8(dim, at);        // width
    header.writeUInt8(dim, at + 1);    // height
    header.writeUInt8(0, at + 2);      // palette colours
    header.writeUInt8(0, at + 3);      // reserved
    header.writeUInt16LE(1, at + 4);   // colour planes
    header.writeUInt16LE(32, at + 6);  // bits per pixel
    header.writeUInt32LE(image.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

// Writes the file atomically (temp file + rename) so Explorer never reads half an icon.
function writeIcoFile(target, images) {
  const data = buildIco(images);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  try { fs.renameSync(temp, target); }
  catch (error) { try { fs.writeFileSync(target, data); } finally { try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ } } }
  return data.length;
}

module.exports = { parseIconImages, buildIco, writeIcoFile, MAX_IMAGES };
