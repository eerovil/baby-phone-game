/**
 * Draw the launcher icons.
 *
 * Deliberately dependency-free: the icon is three concentric rings, which is
 * easy enough to rasterise by hand that pulling in an image library for it
 * would be the larger cost. PNG encoding uses node's own zlib.
 *
 *   node scripts/generate-icons.mjs
 *   node scripts/generate-icons.mjs --check   # fail if the committed files differ
 */

import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'public', 'icons');

const RINGS = [
  [0.92, [255, 46, 99]],
  [0.62, [255, 215, 0]],
  [0.32, [8, 217, 214]],
];

/**
 * @param {number} size
 * @param {number} safe fraction of the canvas the art may use; a maskable icon
 *   must survive the launcher cropping a circle out of it.
 */
function drawIcon(size, safe) {
  const pixels = Buffer.alloc(size * size * 3);
  const center = (size - 1) / 2;
  const maxRadius = (size / 2) * safe;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      let color = [0, 0, 0];
      for (const [fraction, ringColor] of RINGS) {
        if (distance <= maxRadius * fraction) color = ringColor;
      }
      const offset = (y * size + x) * 3;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  return encodePng(size, size, pixels);
}

/** Minimal 8-bit truecolour PNG. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const outputs = [
  ['icon-192.png', drawIcon(192, 0.94)],
  ['icon-512.png', drawIcon(512, 0.94)],
  // Maskable art has to sit inside the launcher's safe circle.
  ['icon-maskable-512.png', drawIcon(512, 0.7)],
];

const check = process.argv.includes('--check');
let stale = false;

for (const [name, data] of outputs) {
  const path = join(iconsDir, name);
  if (check) {
    let existing = null;
    try {
      existing = readFileSync(path);
    } catch {
      // Missing file: treated the same as a stale one.
    }
    if (!existing || !existing.equals(data)) {
      stale = true;
      console.error(`stale: public/icons/${name}`);
    }
    continue;
  }
  writeFileSync(path, data);
  console.log(`wrote public/icons/${name} (${data.length} bytes, ${sha(data)})`);
}

if (check && stale) {
  console.error('Run: npm run generate:icons');
  process.exit(1);
}

function sha(data) {
  return createHash('sha256').update(data).digest('hex').slice(0, 12);
}
