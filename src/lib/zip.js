// A zip writer for files stored as they are (no compression: attachments are mostly
// images and videos, already compressed). Entries are kept as Blobs, so a large archive
// lives in the browser's blob storage rather than in one array in memory. Plain zip, not
// zip64: a part stays under 4 GiB, and parts() starts a new one past `partLimit` bytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// the DOS date and time a zip entry carries, in local time as zip tools read it
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const MAX = 0xffffffff;
const UTF8_NAMES = 0x0800;

export class ZipWriter {
  constructor({ partLimit = 2 * 1024 ** 3, now = new Date() } = {}) {
    if (partLimit >= MAX) throw new Error("a part must stay under 4 GiB (no zip64)");
    this.partLimit = partLimit;
    this.stamp = dosTime(now);
    this.done = [];
    // across every part: the parts are meant to be unpacked into one folder
    this.names = new Set();
    this.open();
  }

  open() {
    this.blobs = [];
    this.central = [];
    this.offset = 0;
  }

  // the part that would hold `size` more bytes: a new one once the current would pass the
  // limit (a part never ends up empty, so one file larger than the limit gets a part alone)
  room(size) {
    if (this.central.length && (this.offset + size > this.partLimit || this.central.length === 0xffff)) this.close();
  }

  // bytes: Uint8Array of the file's content; returns the number of the part it went in (1-based)
  add(name, bytes) {
    if (bytes.length >= MAX) throw new Error(`${name} is 4 GiB or larger: too big for a zip without zip64`);
    const nameBytes = new TextEncoder().encode(name);
    this.room(30 + nameBytes.length + bytes.length + 46 + nameBytes.length);
    if (this.names.has(name)) throw new Error(`two entries named ${name}`);
    this.names.add(name);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, this.stamp.time, true);
    local.setUint16(12, this.stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, UTF8_NAMES, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, this.stamp.time, true);
    cen.setUint16(14, this.stamp.date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, bytes.length, true);
    cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, this.offset, true);
    this.blobs.push(new Blob([local, nameBytes, bytes]));
    this.central.push(new Blob([cen, nameBytes]));
    this.offset += 30 + nameBytes.length + bytes.length;
    if (this.offset >= MAX) throw new Error("part grew past 4 GiB");
    return this.done.length + 1;
  }

  close() {
    let size = 0;
    for (const c of this.central) size += c.size;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.central.length, true);
    end.setUint16(10, this.central.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    this.done.push(new Blob([...this.blobs, ...this.central, end], { type: "application/zip" }));
    this.open();
  }

  // every part as a Blob; the writer is spent afterwards
  parts() {
    if (this.central.length || !this.done.length) this.close();
    return this.done;
  }
}
