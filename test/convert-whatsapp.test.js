// `leket convert whatsapp`: src/convert/whatsapp.js parses and renders, bin/leket.js reads
// the files and writes. The fixture is synthetic (invented names, a 555-01xx number), one
// line of each shape WhatsApp's Export chat writes in the day-first "d.m.yyyy, H:MM - "
// form: notices (encryption, an icon changed with a second line, a member joining), a
// message with later lines (a blank one among them), an omitted and an attached file, a
// pasted line shaped like a header, a sender who is a phone number, a one-digit hour and
// a day change. With every sender given in its names, the original private converter's
// render of it matched sam.md line for line apart from the source and summary lines, the
// blank line it drops, the "<" escaped and the final line break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conversationName, parse, plan, render } from "../src/convert/whatsapp.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const DIR = join(here, "fixtures", "convert-whatsapp");
const FIXTURE = join(DIR, "WhatsApp Chat with Sam Rivera.txt");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-whatsapp-"));
const chr = (...c) => String.fromCodePoint(...c);
const one = (text, opts = {}) => plan([{ file: "WhatsApp Chat with Pat.txt", text }], opts).files[0].text;
const body = (md) => md.split("\n").slice(5).join("\n"); // past the heading, source and summary

test("the fixture renders as sam.md", () => {
  const { files, stats } = plan([{ file: "WhatsApp Chat with Sam Rivera.txt", text: readFileSync(FIXTURE, "utf8") }],
    { names: { "Alex Morgan": "Alex", "Sam Rivera": "Sam" } });
  assert.equal(files[0].name, "whatsapp-Sam Rivera.md");
  assert.equal(files[0].text, readFileSync(join(DIR, "sam.md"), "utf8"));
  assert.deepEqual({ ...stats, senders: { ...stats.senders } },
    { conversations: 1, messages: 10, notices: 3, senders: { "Alex Morgan": 4, "Sam Rivera": 4, Quinn: 1, "+1 555 0100": 1 } });
});

test("Name: text is a message, any other header line a notice; lines before any header are passed over", () => {
  const { entries, messages, notices } = parse("stray\n1.2.2025, 10:00 - Pat Lee: a: b\n1.2.2025, 10:01 - You deleted this message\nmore\n\nlast\n");
  assert.deepEqual(entries.map(({ who, lines }) => [who, lines]), [["Pat Lee", ["a: b"]], [null, ["You deleted this message", "more", "last"]]]);
  assert.deepEqual([messages, notices], [1, 1]);
  assert.match(one("1.2.2025, 10:01 - Pat: x\n1.2.2025, 10:02 - Pat left\nand more\n"), /^> \[WhatsApp, Feb 1 2025 10:02 AM: Pat left and more\]$/m);
});

test("bidi marks before a header and in names and text are taken out; a BOM before the first line is passed over", () => {
  const [lrm, rlm, rli, pdi] = [chr(0x200e), chr(0x200f), chr(0x2067), chr(0x2069)];
  const md = one(`${chr(0xfeff)}${lrm}${rlm}1.2.2025, 10:00 - ${rli}Pat${pdi}: ${rlm}hi${lrm}\n${rlm}more\n`);
  assert.equal(body(md), "## 2025-02-01 (Sat)\n\n> -# Pat — Feb 1 2025 10:00 AM\n> hi\n> more\n>\n");
  const { entries } = parse(`1.2.2025, 10:00 - ${rli}Pat${pdi}: x\n`);
  assert.equal(entries[0].who, "Pat", "names are matched to --name without their marks");
});

test("lines end at \\r\\n, \\r or \\n only; a blank line in a message stays, blank lines closing it go", () => {
  const ls = chr(0x2028);
  const { entries } = parse(`1.2.2025, 10:00 - Pat: a${ls}b\r\nmore\r\rlast\n`);
  assert.deepEqual(entries[0].lines, [`a${ls}b`, "more", "", "last"]);
  assert.equal(body(one("1.2.2025, 10:00 - Pat: a\n\nb\n\n\n")), "## 2025-02-01 (Sat)\n\n> -# Pat — Feb 1 2025 10:00 AM\n> a\n>\n> b\n>\n");
});

test("times are shown as written, whatever --tz names; the range runs earliest to latest message", () => {
  const md = one("3.2.2025, 23:30 - Pat: late\n1.2.2025, 08:00 - Pat: pasted\n", { timeZone: "Asia/Tokyo" });
  assert.match(md, /^2 messages, 2025-02-01 to 2025-02-03\. Times are as the phone showed them, in Asia\/Tokyo\./m);
  assert.match(md, /> -# Pat — Feb 3 2025 11:30 PM\n/);
  assert.match(one("1.2.2025, 10:00 - Pat: x\n"), /\(the phone's local time, with no zone\)\. Attached files[^.]*\.$/m);
});

test("a header whose date doesn't exist stops with its line number", () => {
  assert.throws(() => parse("1.2.2025, 10:00 - Pat: hi\n30.2.2025, 10:00 - Pat: x\n"), /^Error: line 2: can't read the date "30\.2\.2025, 10:00"/);
  for (const bad of ["1.13.2025, 10:00", "0.1.2025, 10:00", "1.1.2025, 24:00", "1.1.2025, 10:60", "1.1.0025, 10:00"]) {
    assert.throws(() => parse(`${bad} - Pat: x\n`), /line 1: can't read the date/, bad);
  }
  assert.throws(() => plan([{ file: "x.txt", text: "30.2.2025, 10:00 - Pat: hi\n" }]), /^Error: x\.txt: line 1/);
});

test("names: --name's label, else the name as written, a phone number whole", () => {
  const md = one("1.2.2025, 10:00 - Pat Lee: a\n1.2.2025, 10:01 - +1 555 0100: b\n1.2.2025, 10:02 - constructor: c\n",
    { names: Object.assign(Object.create(null), { "Pat Lee": "P." }) });
  assert.deepEqual(md.match(/^> -# [^—]+/gm), ["> -# P. ", "> -# +1 555 0100 ", "> -# constructor "]);
});

test("a < that would start a tag is escaped, in messages and notices", () => {
  const md = one("1.2.2025, 10:00 - Pat: <Media omitted> 1 < 2\n1.2.2025, 10:01 - <b>x</b> changed the subject\n");
  assert.match(md, /^> \\<Media omitted> 1 < 2$/m);
  assert.match(md, /^> \[WhatsApp, Feb 1 2025 10:01 AM: \\<b>x\\<\/b> changed the subject\]$/m);
});

test("a file with no message, notices only or another header shape, stops the plan, naming it", () => {
  assert.throws(() => plan([{ file: "e.txt", text: "" }]), /e\.txt holds no message/);
  assert.throws(() => plan([{ file: "e.txt", text: "1.2.2025, 10:00 - Messages are encrypted\n" }]), /e\.txt holds no message/);
  assert.throws(() => plan([{ file: "e.txt", text: "2/1/25, 10:00 AM - Pat: hi\n" }]), /e\.txt holds no message \(is it .*d\.m\.yyyy, H:MM\?\)/);
});

test("file names: whatsapp-Name.md from the export's name; a clash gets a count; base and title for one", () => {
  assert.equal(conversationName("WhatsApp Chat with Sam Rivera.txt"), "Sam Rivera");
  assert.equal(conversationName("chat.TXT"), "chat");
  const t = "1.2.2025, 10:00 - Pat: hi\n";
  const { files } = plan([{ file: "WhatsApp Chat with Pat.txt", text: t }, { file: "whatsapp chat with pat.txt", text: t }, { file: "A/B.txt", text: t }]);
  assert.deepEqual(files.map((f) => f.name), ["whatsapp-Pat.md", "whatsapp-pat (2).md", "whatsapp-A-B.md"]);
  assert.match(files[0].text, /^# WhatsApp with Pat\n/);
  const [f] = plan([{ file: "a`b.txt", text: t }], { base: "pat", title: "Pat" }).files;
  assert.equal(f.name, "pat.md");
  assert.match(f.text, /^# Pat\n\nSource: ``a`b\.txt``, a chat/);
});

test("cli: a folder (its .TXT too) and a file in it are read once; senders listed on stderr", () => {
  const src = tmp(), out = tmp();
  copyFileSync(FIXTURE, join(src, "WhatsApp Chat with Sam Rivera.txt"));
  writeFileSync(join(src, "WhatsApp Chat with Pat.TXT"), "1.2.2025, 10:00 - Pat: hi\n");
  writeFileSync(join(src, "notes.md"), "not an export");
  const r = leket(["convert", "whatsapp", src, join(src, "WhatsApp Chat with Sam Rivera.txt"), "--out", out, "--name", "Alex Morgan=Alex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["whatsapp-Pat.md", "whatsapp-Sam Rivera.md"]);
  assert.match(r.stderr, /2 conversations, 11 messages, 3 WhatsApp notices; times as the phone showed them\.\nleket: senders: Alex Morgan \(4\), Sam Rivera \(4\), /);
  assert.match(readFileSync(join(out, "whatsapp-Sam Rivera.md"), "utf8"), /^> -# Alex — Mar 4 2024 9:15 AM$/m);
});

test("cli: --title, --base and --tz with one export", () => {
  const out = tmp();
  const r = leket(["convert", "whatsapp", FIXTURE, "--out", out, "--title", "Sam", "--base", "sam", "--tz", "Europe/Paris"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(out, "sam.md"), "utf8"), /^# Sam\n[^]*Times are as the phone showed them, in Europe\/Paris\./);
  assert.match(r.stderr, /times as the phone showed them \(Europe\/Paris\)\./);
});

test("cli: usage errors exit 2, an unreadable export exits 1 with nothing written", () => {
  const out = tmp(), two = tmp();
  writeFileSync(join(two, "A.txt"), "1.2.2025, 10:00 - A: hi\n");
  writeFileSync(join(two, "B.txt"), "1.2.2025, 10:00 - B: hey\n");
  for (const [args, msg] of [
    [[two, "--title", "x"], /--title goes with one export .*; 2 were given/],
    [[FIXTURE, "--base", "a/b"], /--base takes a file name/],
    [[FIXTURE, "--name", "Sam"], /--name takes NAME=LABEL/],
    [[FIXTURE, "--tz", "Mars/Base"], /unknown time zone/],
  ]) {
    const r = leket(["convert", "whatsapp", ...args, "--out", out]);
    assert.equal(r.status, 2, `${args}: ${r.stderr}`);
    assert.match(r.stderr, msg);
  }
  writeFileSync(join(two, "C.txt"), "31.4.2025, 10:00 - C: hi\n");
  const r = leket(["convert", "whatsapp", two, "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /C\.txt: line 1: can't read the date[^]*; nothing written\./);
  assert.deepEqual(readdirSync(out), []);
  assert.equal(existsSync(join(out, "whatsapp-A.md")), false);
});

test("review lows: bidi marks alone are blank, a bidi-only name makes a notice; a notice's trailing spaces go", () => {
  const lrm = chr(0x200e);
  assert.equal(body(one(`1.2.2025, 10:00 - Pat: hi\n${lrm}\n`)), "## 2025-02-01 (Sat)\n\n> -# Pat — Feb 1 2025 10:00 AM\n> hi\n>\n");
  assert.match(one(`1.2.2025, 10:00 - Pat: hi\n1.2.2025, 10:01 - Subject changed\n${lrm}\nmore   \n`), /: Subject changed more\]$/m);
  const { entries, messages } = parse(`1.2.2025, 10:00 - Pat: hi\n1.2.2025, 10:01 - ${lrm}: x\n1.2.2025, 10:02 - : y\n`);
  assert.deepEqual([messages, entries.map((e) => e.who)], [1, ["Pat", null, null]]);
});

test("review lows: an escaped < stays as it is; a label's < is escaped; no source is (unnamed)", () => {
  const md = one("1.2.2025, 10:00 - Pat <work>: \\<b> and <i>\n");
  assert.match(md, /^> -# Pat \\<work> — /m);
  assert.match(md, /^> \\<b> and \\<i>$/m);
  const parsed = parse("1.2.2025, 10:00 - Pat: hi\n");
  assert.doesNotThrow(() => assert.match(render(parsed, { title: "T" }), /^Source: \(unnamed\), /m));
});

test("the range counts messages only; month 0 is refused; senders named like Object's properties are counted", () => {
  const md = one("1.1.2020, 10:00 - Encrypted\n1.2.2025, 10:00 - Pat: hi\n1.3.2026, 10:00 - Pat left\n");
  assert.match(md, /^1 messages, 2025-02-01 to 2025-02-01\./m);
  assert.throws(() => parse("1.0.2025, 10:00 - Pat: x\n"), /line 1: can't read the date/);
  const { stats } = plan([{ file: "a.txt", text: "1.2.2025, 10:00 - __proto__: a\n1.2.2025, 10:01 - constructor: b\n1.2.2025, 10:02 - constructor: c\n" }]);
  assert.deepEqual({ ...stats.senders }, { ["__proto__"]: 1, constructor: 2 });
});

test("cli: a folder holding only a link to an export reads it; a broken link is passed over", () => {
  const src = tmp(), out = tmp();
  symlinkSync(FIXTURE, join(src, "chat.txt"));
  symlinkSync(join(src, "gone.txt"), join(src, "broken.txt"));
  const r = leket(["convert", "whatsapp", src, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out), ["whatsapp-chat.md"]);
});
