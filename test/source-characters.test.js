// No invisible or control character sits in the source as itself: a C0 or C1 control
// (tab and newline aside), a zero-width or bidi mark, a line or paragraph separator, a BOM
// or U+FFFD. Each reads as nothing or as something else in an editor and a diff; write it
// as an escape or String.fromCodePoint(...) instead. (Tooling that writes code can turn an
// escape into the character itself without anyone seeing it; this catches that.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// built from numbers, so this file can't hold the characters it looks for
const span = (a, b) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`;
const HIDDEN = new RegExp(`[${span(0x00, 0x08)}${span(0x0b, 0x1f)}${span(0x7f, 0x9f)}${span(0x200b, 0x200f)}` +
  `${span(0x2028, 0x202e)}${span(0x2060, 0x2064)}${span(0x2066, 0x2069)}${String.fromCodePoint(0xfeff, 0xfffd)}]`, "g");
const TEXT = /\.(m?js|json|md|html|css|tsv|txt)$/;

function hiddenCharacters(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(HIDDEN)) out.push(`${i + 1}: U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
  });
  return out;
}

test("the pattern finds what it looks for (a positive control)", () => {
  const cps = [0x00, 0x0b, 0x1b, 0x85, 0x200b, 0x200e, 0x2028, 0x202e, 0x2066, 0xfeff, 0xfffd];
  assert.deepEqual(hiddenCharacters(`a${String.fromCodePoint(...cps)}\tb`).length, cps.length);
  assert.deepEqual(hiddenCharacters("tabs\tand\nnewlines, é, שלום, 😀"), []);
});

test("src/, bin/ and test/ hold no invisible or control characters as themselves", () => {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "src", "bin", "test"], { cwd: root, encoding: "utf8" })
    .split("\n").filter((f) => TEXT.test(f));
  assert.ok(files.length > 50, `only ${files.length} files listed`);
  const found = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(root, f), "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    for (const at of hiddenCharacters(text)) found.push(`${f}:${at}`);
  }
  assert.deepEqual(found, []);
});
