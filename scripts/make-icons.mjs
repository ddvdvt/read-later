// Generates extension/icons/icon{16,32,48,128}.png — a red rounded tile with a white page,
// text lines and a yellow bookmark ribbon. No dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../extension/lib/zip.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const RED = [194, 52, 26];
const WHITE = [255, 253, 248];
const INK = [26, 23, 18];
const GOLD = [255, 216, 77];

/** Shape test in unit coordinates (0..1). Returns RGB or null (transparent). */
function shade(x, y) {
  // rounded tile
  const r = 0.2;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  // page
  const px0 = 0.22, px1 = 0.78, py0 = 0.17, py1 = 0.83;
  if (!(x >= px0 && x <= px1 && y >= py0 && y <= py1)) return RED;
  // bookmark ribbon hanging from the top edge (with a notch at the bottom)
  const bx0 = 0.56, bx1 = 0.7, by1 = 0.5;
  if (x >= bx0 && x <= bx1 && y <= by1) {
    const mid = (bx0 + bx1) / 2;
    const notch = by1 - 0.08 + Math.abs(x - mid) * 1.1;
    if (y <= notch) return GOLD;
  }
  // text lines
  const lines = [[0.31, 0.3, 0.5], [0.42, 0.3, 0.5], [0.56, 0.3, 0.7], [0.67, 0.3, 0.62]];
  for (const [ly, x0, x1] of lines) if (Math.abs(y - ly) < 0.035 && x >= x0 && x <= x1) return INK;
  return WHITE;
}

function png(size) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a++;
          }
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(join(OUT, `icon${s}.png`), png(s));
console.log('icons written to', OUT);
