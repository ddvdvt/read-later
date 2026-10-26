// Minimal store-only (no compression) ZIP writer with CRC-32. Zero dependencies.
// Pure module: works in browsers and node (uses TextEncoder + Uint8Array only).

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

/**
 * CRC-32 (IEEE 802.3) of bytes.
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit
 */
export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time for a JS Date. */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a ZIP archive with stored (uncompressed) entries.
 * @param {Array<{name: string, data: string|Uint8Array}>} files
 * @param {{date?: Date}} [opts]
 * @returns {Uint8Array}
 */
export function createZip(files, opts = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(opts.date || new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    lh.set(name, 30);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    ch.set(name, 46);

    locals.push(lh, data);
    centrals.push(ch);
    offset += lh.length + data.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + cdSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/**
 * Read a store-only ZIP (as produced by createZip) — used by tests and for self-checks.
 * @param {Uint8Array} buf
 * @returns {Array<{name: string, data: Uint8Array, crc: number}>}
 */
export function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Bad central header');
    const method = dv.getUint16(p + 10, true);
    if (method !== 0) throw new Error('Only stored entries are supported');
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('Bad local header');
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtra = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtra;
    out.push({ name, data: buf.subarray(start, start + size), crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Inflate raw DEFLATE data with the platform's DecompressionStream (Chrome 103+, Node 21+).
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read any ordinary ZIP archive (stored or deflated entries), e.g. an export from another
 * service. Directories are skipped. ZIP64 and encrypted archives are rejected.
 * @param {Uint8Array} buf
 * @param {{ maxEntries?: number, maxTotal?: number }} [limits]
 * @returns {Promise<Array<{ name: string, data: Uint8Array }>>}
 */
export async function unzip(buf, limits = {}) {
  const maxEntries = limits.maxEntries || 20000;
  const maxTotal = limits.maxTotal || 1024 * 1024 * 1024;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = dv.getUint16(eocd + 10, true);
  if (count === 0xffff || dv.getUint32(eocd + 16, true) === 0xffffffff) throw new Error('zip64 is not supported');
  if (count > maxEntries) throw new Error('too many entries');
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('encrypted zip is not supported');
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    total += usize;
    if (total > maxTotal) throw new Error('archive is too large');
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`unsupported compression method ${method}`);
    out.push({ name, data });
  }
  return out;
}
