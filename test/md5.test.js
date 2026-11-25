// src/lib/md5.js: pinned to RFC 1321's appendix A.5 test suite (all seven vectors) and
// one non-ASCII string. The expected values are literals — the extension itself cannot
// reach node:crypto, so a test-side recomputation would prove nothing about the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { md5 } from "../src/lib/md5.js";

test("md5 matches RFC 1321 appendix A.5, all seven vectors", () => {
  const cases = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
  ];
  for (const [input, want] of cases) {
    assert.equal(md5(input), want, JSON.stringify(input));
  }
});

test("md5 hashes UTF-8 input, not bytes of the JS string", () => {
  // expected computed once with: node -e "console.log(require('crypto').createHash('md5').update('süß Öl ☕','utf8').digest('hex'))"
  assert.equal(md5("süß Öl ☕"), "e328877d18a8fc60e412b7bab27b8273");
});
