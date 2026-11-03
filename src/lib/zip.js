// A zip writer for files stored as they are (no compression: attachments are mostly
// images and videos, already compressed). Entries are kept as Blobs, so a large archive
// lives in the browser's blob storage rather than in one array in memory. Plain zip, not
// zip64: every offset in a part stays under 4 GiB (a part holding one file of nearly 4 GiB
// can end a few hundred bytes past it, which a plain zip allows), and a new part starts
// past `partLimit` bytes.
// With an `onPart` callback, each sealed part is handed over the moment it closes and
// held nowhere, so the caller can download it before the next part fills.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// crc32(bytes), or piece by piece: crc32(second, crc32(first))
export function crc32(bytes, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
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

// the part size both split points agree on (zip.js's default and the "will it stream?"
// decision in files.js)
export const PART_LIMIT = 2 * 1024 ** 3;

export class ZipWriter {
  constructor({ partLimit = PART_LIMIT, now = new Date(), onPart } = {}) {
    if (partLimit >= MAX) throw new Error("a part must stay under 4 GiB (no zip64)");
    this.partLimit = partLimit;
    this.stamp = dosTime(now);
    this.done = [];
    // given: sealed parts go to onPart(blob, number) instead of this.done — the writer
    // keeps nothing, so only one part ever exists at a time
    this.onPart = onPart;
    this.sealed = 0;
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
  // limit (a part never ends up empty, so one file larger than the limit gets a part alone),
  // or would hold 0xffff entries — that count is zip64's marker, not a plain zip's
  room(size) {
    if (this.central.length && (this.offset + size > this.partLimit || this.central.length === 0xfffe)) this.close();
  }

  // data: the file's content, a Uint8Array, or a Blob with its crc32 given (so a large file
  // is never copied); returns the number of the part it went in (1-based)
  add(name, data, crc) {
    const isBlob = typeof Blob !== "undefined" && data instanceof Blob;
    const size = isBlob ? data.size : data.length;
    if (isBlob && typeof crc !== "number") throw new Error(`${name}: a Blob needs its crc32`);
    if (size >= MAX) throw new Error(`${name} is 4 GiB or larger: too big for a zip without zip64`);
    const nameBytes = new TextEncoder().encode(name);
    // every refusal comes before any change: a refused entry seals no part early and
    // leaves its name free
    if (this.names.has(name)) throw new Error(`two entries named ${name}`);
    // a file within bytes of 4 GiB: even alone in a part, its header pushes the part past
    // what a plain zip can address (a smaller file that doesn't fit gets a new part instead)
    if (30 + nameBytes.length + size >= MAX) throw new Error(`${name}: its part would grow past 4 GiB`);
    this.room(30 + nameBytes.length + size + 46 + nameBytes.length);
    this.names.add(name);
    if (!isBlob) crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, this.stamp.time, true);
    local.setUint16(12, this.stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
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
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, this.offset, true);
    this.blobs.push(new Blob([local, nameBytes, data]));
    this.central.push(new Blob([cen, nameBytes]));
    this.offset += 30 + nameBytes.length + size;
    return (this.onPart ? this.sealed : this.done.length) + 1;
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
    const part = new Blob([...this.blobs, ...this.central, end], { type: "application/zip" });
    this.open();
    if (this.onPart) this.onPart(part, ++this.sealed);
    else this.done.push(part);
  }

  // every part as a Blob; the writer is spent afterwards. With onPart the parts are already
  // handed over: this only seals the one still open and returns [].
  parts() {
    if (this.onPart) {
      if (this.central.length) this.close();
      return this.done;
    }
    if (this.central.length || !this.done.length) this.close();
    return this.done;
  }

  // drop the part still being filled without sealing or handing it off: a stopped save
  // keeps nothing in mid-flight. What was sealed already stays handed over.
  discard() {
    this.open();
  }
}
