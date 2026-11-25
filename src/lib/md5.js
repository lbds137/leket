// MD5, written fresh from RFC 1321 (The MD5 Message-Digest Algorithm): the padding,
// the four round functions with their shift tables, the 64 sine-derived constants, and
// the little-endian word order the RFC pins. Leket uses it for exactly one thing —
// Replika's REST endpoints want an x-timestamp-hash header that is the lowercase hex
// MD5 of a short string (a device id joined onto a fixed prefix), and the extension
// cannot reach node:crypto. Input is a UTF-8 string; the answer is lowercase hex.
//
// Only short strings (a few dozen bytes) are hashed here, but the padding carries the
// full 64-bit bit length, so long inputs round correctly too.

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(2^32 * |sin(i + 1)|), the RFC's appendix-only constants
const SINE = new Uint32Array(64);
for (let i = 0; i < 64; i++) SINE[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);

const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

export function md5(input) {
  const bytes = new TextEncoder().encode(String(input));
  // the message plus 0x80, zeros up to 56 mod 64, then the 8 length bytes
  const total = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      const g = j < 16 ? j : j < 32 ? (5 * j + 1) % 16 : j < 48 ? (3 * j + 5) % 16 : (7 * j) % 16;
      const w = view.getUint32(off + g * 4, true);
      let F;
      if (j < 16) F = (B & C) | (~B & D);
      else if (j < 32) F = (D & B) | (~D & C);
      else if (j < 48) F = B ^ C ^ D;
      else F = C ^ (B | ~D);
      F = (F + A + SINE[j] + w) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, SHIFTS[j])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  // the digest is the four words, each little-endian
  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, "0");
  return hex;
}
