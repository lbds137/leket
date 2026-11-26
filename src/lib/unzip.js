// Reads one entry out of a zip on disk without loading the zip: the end record and the
// central directory first, then only that entry's bytes. A Leket zip part can be 2 GiB of
// attachments, and the save's JSON is one small entry in it. Plain zip only (Leket's
// writer never makes zip64); stored and deflated entries, checked against their crc32.
import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

import { shown } from "./shown.js";
import { crc32 } from "./zip.js";

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

// every entry's name, method, sizes, crc and local-header offset, from the central directory
export async function zipEntries(path) {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    // the end record is 22 bytes plus a comment of up to 65535
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let at = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
    if (at < 0) throw new Error(`${path} is not a zip (no end record)`);
    const count = tail.readUInt16LE(at + 10), cdSize = tail.readUInt32LE(at + 12), cdOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error(`${path} is a zip64 archive, which this reader doesn't handle`);
    const damaged = () => new Error(`${path}: its central directory is damaged`);
    // checked before the allocation: a stray end-record signature in a non-zip can claim 4 GiB
    if (cdOffset + cdSize > size - tailLen + at) throw damaged();
    const cd = Buffer.alloc(cdSize);
    if ((await fh.read(cd, 0, cdSize, cdOffset)).bytesRead !== cdSize) throw damaged();
    const entries = [];
    for (let p = 0, n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw damaged();
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw damaged();
      entries.push({
        name: cd.toString("utf8", p + 46, p + 46 + nameLen),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

// one entry's content as a Buffer; entry is one of zipEntries' results
export async function readZipEntry(path, entry) {
  const name = shown(entry.name);
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(30);
    const { bytesRead: headRead } = await fh.read(head, 0, 30, entry.offset);
    if (headRead !== 30 || head.readUInt32LE(0) !== LOCAL) throw new Error(`${path}: ${name}'s local header is missing`);
    // the local header's own name and extra lengths, which can differ from the central copy's
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    // the sizes come from the central directory: checked against the file before the
    // allocation, so a damaged or hostile entry can't ask for 4 GiB
    const cut = () => new Error(`${path}: ${name} is cut short (the zip is incomplete)`);
    if (start + entry.compressedSize > (await fh.stat()).size) throw cut();
    const raw = Buffer.alloc(entry.compressedSize);
    const { bytesRead } = await fh.read(raw, 0, entry.compressedSize, start);
    if (bytesRead !== entry.compressedSize) throw cut();
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      // inflate stops one byte past the declared size (zlib takes no cap of 0), so a small
      // entry can't unpack into gigabytes; the length check below then refuses it
      try {
        data = inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
      } catch (e) {
        if (e.code === "ERR_BUFFER_TOO_LARGE") throw new Error(`${path}: ${name} holds more than its declared ${entry.size} bytes (the zip is damaged)`);
        throw new Error(`${path}: ${name} can't be unpacked (the zip is damaged: ${e.message})`);
      }
      if (data.length > entry.size) throw new Error(`${path}: ${name} holds more than its declared ${entry.size} bytes (the zip is damaged)`);
    } else throw new Error(`${path}: ${name} uses compression method ${entry.method}, which this reader doesn't handle`);
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`${path}: ${name} fails its checksum (the zip is damaged)`);
    return data;
  } finally {
    await fh.close();
  }
}
