// src/convert/common.js: shared converter helpers (escapeTag, safeTitle, badFolder, stamp, span).
import { test } from "node:test";
import assert from "node:assert/strict";

import { badFolder, escapeTag, safeTitle } from "../src/convert/common.js";

const [S1, S2, S3] = [0xb9, 0xb2, 0xb3].map((c) => String.fromCharCode(c));
const NBSP = String.fromCharCode(0xa0);
const EMSP = String.fromCharCode(0x2003);

test("escapeTag: escapes < starting a tag/autolink and & starting a reference unless an odd backslash run already escapes it", () => {
  assert.equal(escapeTag("\\&lt;"), "\\&lt;");
  assert.equal(escapeTag("\\\\&lt;"), "\\\\\\&lt;");
  assert.equal(escapeTag("&#x1F600;"), "\\&#x1F600;");
  assert.equal(escapeTag("a & b"), "a & b");
  assert.equal(escapeTag("<<b"), "<\\<b");
  assert.equal(escapeTag("&&amp;"), "&\\&amp;");
});

test("safeTitle: appends - to Windows-reserved device stems (including extensions and >200-byte cuts) and leaves non-reserved names unchanged", () => {
  for (const name of [
    "con", "CON", "Prn", "aux", "nul", "NUL",
    "com0", "COM1", "com9", "lpt0", "LPT1", "lpt9",
    `com${S1}`, `COM${S2}`, `lpt${S3}`, `LPT${S1}`,
  ]) {
    assert.equal(safeTitle(name), `${name}-`, name);
  }
  assert.equal(safeTitle("NUL.backup"), "NUL-.backup");
  assert.equal(safeTitle("con.txt..."), "con-.txt");
  assert.equal(safeTitle("lpt1.a.b"), "lpt1-.a.b");
  assert.equal(safeTitle(`com${S2}.log`), `com${S2}-.log`);
  assert.equal(safeTitle("aux..."), "aux-");
  // >200-byte cut cannot re-create a reserved stem and stays within 200 UTF-8 bytes
  const longExt = safeTitle(`NUL.${"a".repeat(250)}`);
  assert.equal(longExt, `NUL-.${"a".repeat(195)}`);
  assert.equal(new TextEncoder().encode(longExt).length, 200);
  assert.equal(safeTitle(`NUL${".".repeat(250)}a`), "NUL-");
  const longPlain = safeTitle(`CON${"a".repeat(250)}`);
  assert.equal(longPlain, `CON${"a".repeat(197)}`);
  // non-reserved stems stay unchanged
  for (const ok of ["con file", "nul-", "com10", "lpt10.txt", "console.log", "NUL:file"]) {
    assert.equal(safeTitle(ok), ok.replace(":", "-"), ok);
  }
});

test("badFolder: refuses parts ending in a dot or ASCII space or matching a Windows-reserved stem", () => {
  for (const bad of [
    "a.", "a./b", "a/b.", "a..",
    "a ", "a /b", "a/b ", " ",
    "nul", "CON", "a/prn/b", "a/aux.dir/b", "NUL.backup",
    "com0", "COM9", "lpt0", "LPT9",
    `com${S1}`, `lpt${S2}.x`, `a/COM${S3}/b`,
  ]) {
    assert.equal(badFolder(bad), true, JSON.stringify(bad));
  }
  for (const ok of [
    "topic", "a/b", "occult stuff", "con file", "nul-", "com10", "a.b/c.d",
    `topic${NBSP}`, `a${EMSP}/b`,
  ]) {
    assert.equal(badFolder(ok), false, JSON.stringify(ok));
  }
});
