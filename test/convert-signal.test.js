// `leket convert signal`: src/convert/signal.js parses and renders, bin/leket.js reads the
// files and writes. The fixture is synthetic (invented names), one line of each shape
// signalbackup-tools' --exporttxt writes: a message, its later lines (a blank one among
// them), a named file and a typed file (one with reactions), a poll with its options, two
// of Signal's own events, a pasted line shaped like a header, and a day change. With its
// owner's fixed name given as --name, the original private converter's render of it
// matched sam.md line for line apart from the source and summary lines, the two events
// (the original put the first inside the message before, as raw text, and the second
// inside the pasted line's message) and the final line break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conversationName, parse, plan } from "../src/convert/signal.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const DIR = join(here, "fixtures", "convert-signal");
const FIXTURE = join(DIR, "Sam Rivera (_id3).txt");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-signal-"));
const one = (text, opts = {}) => plan([{ file: "Pat (_id1).txt", text }], opts).files[0].text;
const body = (md) => md.split("\n").slice(5).join("\n"); // past the heading, source and summary

test("the fixture renders as sam.md", () => {
  const { files, stats } = plan([{ file: "Sam Rivera (_id3).txt", text: readFileSync(FIXTURE, "utf8") }],
    { names: { "Alex Morgan": "Alex" }, title: "Signal with Sam Rivera" });
  assert.equal(files[0].name, "signal-Sam Rivera.md");
  assert.equal(files[0].text, readFileSync(join(DIR, "sam.md"), "utf8"));
  assert.deepEqual(stats, { conversations: 1, messages: 9, events: 2 });
});

test("a Signal event is its own entry, also when it comes first; lines before any header are passed over", () => {
  const md = one("stray line\n[Jan 02, 2025 10:00:00] *** Missed voice call\n[Jan 02, 2025 10:01:00] <Pat Lee> hi\n");
  assert.equal(body(md), "## 2025-01-02 (Thu)\n\n> -# Signal — Jan 2 2025 10:00 AM\n> [Missed voice call]\n>\n> -# Pat — Jan 2 2025 10:01 AM\n> hi\n>\n");
  assert.match(md, /^1 messages, 2025-01-02 to 2025-01-02\. .* 1 of Signal's own events/m);
});

test("lines end at \\r\\n, \\r or \\n only: a line separator stays inside the text", () => {
  const ls = String.fromCharCode(0x2028);
  const { entries } = parse(`[Jan 02, 2025 10:00:00] <Pat> a${ls}b\r\nmore\rlast\n`);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].lines, [`a${ls}b`, "more", "last"]);
  assert.equal(parse("[Jan 02, 2025 10:00:00] <Pat> x\n\n").entries[0].lines.length, 2, "only the one empty line after the last break goes");
});

test("times are shown as written, whatever --tz names", () => {
  const md = one("[Jan 02, 2025 23:30:00] <Pat> late\n", { timeZone: "Asia/Tokyo" });
  assert.match(md, /Times are as exported, in Asia\/Tokyo\./);
  assert.match(md, /## 2025-01-02 \(Thu\)\n\n> -# Pat — Jan 2 2025 11:30 PM\n/);
  assert.match(one("[Jan 02, 2025 23:30:00] <Pat> late\n"), /Times are as exported \(the exporting computer's local time\)\./);
});

test("a header whose date can't be read stops with its line number", () => {
  assert.throws(() => parse("[Jan 02, 2025 10:00:00] <Pat> hi\n[Mär 03, 2025 10:00:00] <Pat> hallo\n"), /^Error: line 2: can't read the date "Mär 03, 2025 10:00:00"/);
  assert.throws(() => parse("[Feb 30, 2025 10:00:00] <Pat> hi\n"), /line 1: can't read the date/);
  assert.throws(() => parse("[Feb 03, 2025 24:00:00] <Pat> hi\n"), /line 1/);
  assert.throws(() => plan([{ file: "x.txt", text: "[Feb 30, 2025 10:00:00] <Pat> hi\n" }]), /^Error: x\.txt: line 1/);
  // any month word is a header (and refused), not more text of the message before
  for (const mon of ["März", "janv.", "3月", `Ma${String.fromCharCode(0x308)}r`]) {
    assert.throws(() => parse(`[Jan 02, 2025 10:00:00] <Pat> hi\n[${mon} 03, 2025 10:00:00] <Pat> x\n`), /line 2: can't read/, mon);
  }
  assert.throws(() => parse("[Jan 02, 0025 10:00:00] <Pat> hi\n"), /line 1/, "a year below 100 isn't read as 19xx");
  assert.throws(() => parse("[Jan 00, 2025 10:00:00] <Pat> hi\n"), /line 1/);
  assert.throws(() => parse("[Jan 02, 2025 10:60:00] <Pat> hi\n"), /line 1/);
});

test("a name holding > stays whole; a *** line is a file only with sent file, else an event", () => {
  const { entries, messages, events } = parse([
    "[Jan 02, 2025 10:00:00] <A->B> hello",
    "[Jan 02, 2025 10:00:01] *** <A->B> sent file \"x.jpg\"",
    "[Jan 02, 2025 10:00:02] *** <Sam> changed their profile name.",
    "[Jan 02, 2025 10:00:03] <Pat>",
  ].join("\n"));
  assert.deepEqual(entries.map(({ who, event, lines }) => [who, event, lines]), [
    ["A->B", false, ["hello"]],
    ["A->B", false, ["[sent file \"x.jpg\"]"]],
    [null, true, ["[<Sam> changed their profile name.]"]],
    ["Pat", false, [""]],
  ]);
  assert.deepEqual([messages, events], [3, 1]);
  const ps = String.fromCharCode(0x2029);
  assert.deepEqual(parse(`[Jan 02, 2025 10:00:00] <Pat> a${ps}b\n`).entries[0].lines, [`a${ps}b`]);
});

test("names: --name's label, else the first word; an empty name is shown as such", () => {
  const text = "[Jan 02, 2025 10:00:00] <Pat Lee> a\n[Jan 02, 2025 10:01:00] <> b\n[Jan 02, 2025 10:02:00] <constructor> c\n[Jan 02, 2025 10:03:00] *** <Pat Lee> sent file of type image/png\n";
  const md = one(text, { names: Object.assign(Object.create(null), { "Pat Lee": "P." }) });
  assert.deepEqual(md.match(/^> -# [^—]+/gm), ["> -# P. ", "> -# (no name) ", "> -# constructor ", "> -# P. "]);
  assert.match(md, /> \[sent file of type image\/png\]\n/);
});

test("a file with no message, or an empty one, stops the plan, naming it", () => {
  assert.throws(() => plan([{ file: "e.txt", text: "" }]), /e\.txt holds no message/);
  assert.throws(() => plan([{ file: "e.txt", text: "just text\n" }]), /e\.txt holds no message/);
});

test("file names: signal-Name.md from the export's name; a clash gets a count; base and title for one", () => {
  assert.equal(conversationName("Sam Rivera (_id3).txt"), "Sam Rivera");
  assert.equal(conversationName("A/B: group (_id12).txt"), "A/B: group");
  const t = "[Jan 02, 2025 10:00:00] <Pat> hi\n";
  const { files } = plan([{ file: "Pat (_id1).txt", text: t }, { file: "pat (_id2).txt", text: t }, { file: "A/B (_id3).txt", text: t }]);
  assert.deepEqual(files.map((f) => f.name), ["signal-Pat.md", "signal-pat (2).md", "signal-A-B.md"]);
  const [f] = plan([{ file: "Pat (_id1).txt", text: t }], { base: "pat-signal", title: "Texts" }).files;
  assert.equal(f.name, "pat-signal.md");
  assert.match(f.text, /^# Texts\n/);
});

test("cli: a folder and a file in it (by a link too) are read once; writes signal-Name.md", () => {
  const src = tmp(), out = tmp();
  copyFileSync(FIXTURE, join(src, "Sam Rivera (_id3).txt"));
  writeFileSync(join(src, "notes.md"), "not an export");
  symlinkSync(join(src, "Sam Rivera (_id3).txt"), join(src, "link.txt"));
  const r = leket(["convert", "signal", src, join(src, "Sam Rivera (_id3).txt"), join(src, "link.txt"), "--out", out, "--name", "Alex Morgan=Alex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out), ["signal-Sam Rivera.md"]);
  assert.match(r.stderr, /1 conversations, 9 messages, 2 Signal events; times as exported\./);
  assert.match(readFileSync(join(out, "signal-Sam Rivera.md"), "utf8"), /^> -# Alex — Mar 4 2024 9:15 AM$/m);
});

test("cli: --title and --base with one export", () => {
  const out = tmp();
  const r = leket(["convert", "signal", FIXTURE, "--out", out, "--title", "Sam", "--base", "sam", "--tz", "Europe/Paris"]);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(join(out, "sam.md"), "utf8");
  assert.match(md, /^# Sam\n[^]*Times are as exported, in Europe\/Paris\./);
  assert.match(r.stderr, /times as exported \(Europe\/Paris\)\./);
});

test("cli: usage errors exit 2, an unreadable export exits 1 with nothing written", () => {
  const out = tmp();
  const two = tmp();
  writeFileSync(join(two, "A (_id1).txt"), "[Jan 02, 2025 10:00:00] <A> hi\n");
  writeFileSync(join(two, "B (_id2).txt"), "[Jan 02, 2025 10:00:00] <B> hey\n");
  for (const [args, msg] of [
    [[two, "--title", "x"], /--title goes with one export .*; 2 were given/],
    [[two, "--base", "x"], /--base goes with one export/],
    [[FIXTURE, "--base", "a/b"], /--base takes a file name/],
    [[FIXTURE, "--name", "Sam"], /--name takes NAME=LABEL/],
    [[FIXTURE, "--name", "Sam= "], /takes a one-line label/],
    [[FIXTURE, "--tz", "Mars/Base"], /unknown time zone/],
  ]) {
    const r = leket(["convert", "signal", ...args, "--out", out]);
    assert.equal(r.status, 2, `${args}: ${r.stderr}`);
    assert.match(r.stderr, msg);
  }
  const src = tmp();
  writeFileSync(join(src, "good.txt"), "[Jan 02, 2025 10:00:00] <Pat> hi\n");
  writeFileSync(join(src, "bad.txt"), "[Okt 02, 2025 10:00:00] <Pat> hi\n");
  const r = leket(["convert", "signal", src, "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.txt: line 1: can't read the date[^]*; nothing written\./);
  assert.deepEqual(readdirSync(out), []);
  mkdirSync(join(src, "empty"));
  assert.match(leket(["convert", "signal", join(src, "empty"), "--out", out]).stderr, /holds no \.txt export/);
  assert.equal(existsSync(join(out, "signal-Pat.md")), false);
});
