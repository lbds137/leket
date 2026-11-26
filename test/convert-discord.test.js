// `leket convert discord`: src/modules/discord/convert.js renders, bin/leket.js reads the
// saves (JSON, or Leket's zip through src/lib/unzip.js) and writes. The golden files in
// test/fixtures/convert-discord/ are the reviewed output for the synthetic saves in
// test/fixtures/discord-saves.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeSaves, render } from "../src/modules/discord/convert.js";
import { build } from "../src/lib/build.js";
import { ZipWriter } from "../src/lib/zip.js";
import { readZipEntry, zipEntries } from "../src/lib/unzip.js";
import { readDiscordSave } from "../bin/leket.js";
import { channelSaves, dmSaves, dmVoice, ids } from "./fixtures/discord-saves.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const GOLDEN = join(here, "fixtures", "convert-discord");
const golden = (name) => readFileSync(join(GOLDEN, name), "utf8");
const NY = "America/New_York";
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-convert-"));
const fileMap = (files) => Object.fromEntries(files.map((f) => [f.name, f.text]));

const dmFiles = () => render(mergeSaves(dmSaves()), {
  base: "dm", by: "year", title: "Fox DM", timeZone: NY, names: { fox_77: "F" }, embeds: true, voice: dmVoice,
});

test("a DM split by year matches the golden files", () => {
  const files = fileMap(dmFiles());
  assert.deepEqual(Object.keys(files), ["dm-2024.md", "dm-2025.md"]);
  for (const [name, text] of Object.entries(files)) assert.equal(text, golden(name), name);
});

test("a server channel: monthly files, participants and index match the golden files", () => {
  const files = fileMap(render(mergeSaves(channelSaves()), { base: "ch", title: "General", timeZone: NY }));
  assert.deepEqual(Object.keys(files), ["ch-2025-01.md", "ch-2025-02.md", "ch-participants.md", "ch-index.md"]);
  for (const [name, text] of Object.entries(files)) assert.equal(text, golden(name), name);
});

test("ids past 2^53 sort as BigInts, not Numbers", () => {
  assert.equal(Number(ids.a), Number(ids.b));
  const conv = mergeSaves(dmSaves());
  const last = conv.messages.slice(-2).map((m) => m.id);
  assert.deepEqual(last, [ids.a, ids.b]);
  // "99" sorts after "1234…" as a string, before it as a number
  const [d] = dmSaves();
  const mixed = mergeSaves([{ ...d, messages: [ids.b, "99", ids.a].map((id) => ({ ...d.messages[0], id })) }]);
  assert.deepEqual(mixed.messages.map((m) => m.id), ["99", ids.a, ids.b]);
});

test("merge: the first save's copy wins, except a forward's content beats an empty forward", () => {
  const conv = mergeSaves(dmSaves());
  assert.equal(conv.messages.find((m) => m.id === "100").text, "last one of the year  \nsecond line");
  assert.equal(conv.messages.find((m) => m.id === "107").forwarded.length, 1);
  assert.equal(conv.messages.find((m) => m.id === "108").forwarded.length, 0);
  // either save reaching the start counts
  assert.equal(conv.reachedStart, true);
  assert.deepEqual(conv.extracted, ["2025-01-03", "2025-01-05"]);
});

test("a reply quote is cut at 80 characters, never inside an emoji", () => {
  const md = dmFiles().find((f) => f.name === "dm-2025.md").text;
  const quote = /\[reply to F: '(.*)'\]/.exec(md)[1];
  assert.equal([...quote].length, 81);
  assert.ok(quote.endsWith("a…"));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(quote), "no lone high surrogate");
});

test("the day and year come from the zone asked for", () => {
  const utc = render(mergeSaves(dmSaves()), { base: "dm", by: "year", timeZone: "UTC" });
  assert.deepEqual(utc.map((f) => f.name), ["dm-2025.md"]);
  assert.match(utc[0].text, /^## 2025-01-01 \(Wed\)$/m);
  assert.match(utc[0].text, /Jan 1 2025 4:30 AM/);
  const ny = dmFiles()[0].text;
  assert.match(ny, /^## 2024-12-31 \(Tue\)$/m);
  assert.match(ny, /Dec 31 2024 11:30 PM/);
});

test("defaults: a DM is one file titled by its channel; a server channel goes by month", () => {
  const dm = render(mergeSaves(dmSaves()), { base: "x", timeZone: "UTC" });
  assert.deepEqual(dm.map((f) => f.name), ["x.md"]);
  assert.match(dm[0].text, /^# fox_77\n/);
  // no "whole DM so far" when the file holds all of it
  assert.ok(!dm[0].text.includes("whole DM so far"));
  // without --name, display names; without --embeds, no embed tags (and no voice map)
  assert.ok(dm[0].text.includes("-# Fox —") && !dm[0].text.includes("[embed:"));
  assert.match(dm[0].text, /-# Wren — Jan 1 2025 5:18 AM\n> \[no text; message type 0\]/);
  const ch = render(mergeSaves(channelSaves()), { base: "c", timeZone: "UTC" });
  assert.deepEqual(ch.map((f) => f.name), ["c-2025-01.md", "c-2025-02.md", "c-participants.md", "c-index.md"]);
  const one = render(mergeSaves(channelSaves()), { base: "c", by: "none", timeZone: "UTC" });
  assert.deepEqual(one.map((f) => f.name), ["c.md", "c-participants.md", "c-index.md"]);
  assert.match(one.at(-1).text, /in one file;/);
});

test("a save that stopped at its asked-for day says so instead of PARTIAL", () => {
  const [s] = dmSaves();
  const md = render(mergeSaves([{ ...s, reached_since: "2025-01-01" }]), { base: "x", timeZone: "UTC" })[0].text;
  assert.match(md, /the save began at 2025-01-01, as asked, so messages before that day were not collected/);
  assert.ok(!md.includes("PARTIAL"));
  assert.match(render(mergeSaves([s]), { base: "x", timeZone: "UTC" })[0].text, /PARTIAL: the start of the DM was not reached/);
});

test("hidden bars: largest count per kind across saves; unopened bars skipped; a bar without a count marks +", () => {
  const [a, b] = channelSaves();
  const conv = mergeSaves([a, { ...b, hidden_groups: { groups: [{ kind: "ignored", count: null }] } }]);
  assert.deepEqual(Object.fromEntries(conv.hidden), { blocked: { count: 2, uncounted: false }, ignored: { count: 1, uncounted: true } });
  const p = render(conv, { base: "c", timeZone: "UTC" }).find((f) => f.name === "c-participants.md").text;
  assert.match(p, /\(2 blocked, 1\+ ignored\)/);
  // two opened bars of one kind in one save add up; the max is then taken across saves
  const two = mergeSaves([{ ...a, hidden_groups: { groups: [{ kind: "blocked", count: 2 }, { kind: "blocked", count: 4 }] } }, b]);
  assert.deepEqual(two.hidden.get("blocked"), { count: 6, uncounted: false });
});

test("refusals: saves of two conversations, a save with no messages list, no messages at all", () => {
  const [d] = dmSaves(), [c] = channelSaves();
  assert.throws(() => mergeSaves([d, c]), /save 2 is of channel 700, not 900/);
  assert.throws(() => mergeSaves([{ channel_id: "1" }]), /no messages list/);
  // a non-save after a save is named as one, not as another channel; a null save doesn't crash
  assert.throws(() => mergeSaves([d, {}]), /save 2 has no messages list/);
  assert.throws(() => mergeSaves([null]), /save 1 has no messages list/);
  assert.throws(() => render(mergeSaves([{ ...d, messages: [] }]), { base: "x", timeZone: "UTC" }), /hold no messages/);
});

// --- the CLI ---

test("CLI: converts JSON saves into --out and prints each path", () => {
  const dir = tmp(), out = join(dir, "out");
  const paths = dmSaves().map((s, i) => { const p = join(dir, `discord-fox_77-900-${i}.json`); writeFileSync(p, JSON.stringify(s)); return p; });
  const v = join(dir, "voice.json");
  writeFileSync(v, JSON.stringify(dmVoice));
  const r = leket(["convert", "discord", ...paths, "--out", out, "--by", "year", "--base", "dm", "--title", "Fox DM",
    "--tz", NY, "--name", "fox_77=F", "--embeds", "--voice", v]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [join(out, "dm-2024.md"), join(out, "dm-2025.md")]);
  for (const f of readdirSync(out)) assert.equal(readFileSync(join(out, f), "utf8"), golden(f), f);
  assert.match(r.stderr, /14 messages from 2 save\(s\), from its start; times in America\/New_York/);
});

test("CLI: reads the save out of Leket's own zip, named after the save", async () => {
  const dir = tmp();
  const [s] = channelSaves();
  const { parts } = await build(s, { file: "discord-general-700.json", attachments: false });
  const zip = join(dir, parts[0].name);
  writeFileSync(zip, Buffer.from(await parts[0].blob.arrayBuffer()));
  const read = await readDiscordSave(zip);
  assert.equal(read.name, "discord-general-700");
  assert.deepEqual(read.save, s);
  const r = leket(["convert", "discord", zip, "--out", dir, "--tz", "UTC"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(join(dir, "discord-general-700-2025-01.md")));
});

test("CLI: a deflated zip (re-zipped by hand) reads too", () => {
  const dir = tmp();
  const json = join(dir, "discord-fox_77-900.json");
  writeFileSync(json, JSON.stringify(dmSaves()[0]));
  const zip = join(dir, "again.zip");
  const py = spawnSync("python3", ["-I", "-c",
    "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED); z.write(sys.argv[2], 'discord-fox_77-900.json'); z.writestr('discord-attachments/a.png', b'x'); z.close()",
    zip, json], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const r = leket(["convert", "discord", zip, "--out", dir, "--tz", "UTC"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(dir, "discord-fox_77-900.md"));
});

test("CLI: a zip part without the save, and a damaged entry, write nothing and exit 1", async () => {
  const dir = tmp();
  const z = new ZipWriter();
  z.add("discord-attachments.json", new TextEncoder().encode("[]"));
  const part2 = join(dir, "discord-general-700-part2-of-2.zip");
  writeFileSync(part2, Buffer.from(await z.parts()[0].arrayBuffer()));
  let r = leket(["convert", "discord", part2, "--out", join(dir, "o")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holds no Discord save \(in a save split into parts, the messages are in part 1\); nothing written/);
  const good = new ZipWriter();
  good.add("discord-x-1.json", new TextEncoder().encode(JSON.stringify(dmSaves()[0])));
  const bytes = Buffer.from(await good.parts()[0].arrayBuffer());
  bytes[30 + "discord-x-1.json".length + 5] ^= 0xff; // inside the entry's data, past its 30-byte header and name
  const bad = join(dir, "bad.zip");
  writeFileSync(bad, bytes);
  r = leket(["convert", "discord", bad, "--out", join(dir, "o")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fails its checksum/);
  // a central directory cut inside an entry's name, and one claiming more bytes than the file has
  const whole = Buffer.from(await (() => { const w = new ZipWriter(); w.add("discord-x-1.json", new TextEncoder().encode("{}")); return w.parts()[0]; })().arrayBuffer());
  const eocd = whole.length - 22, cdSize = whole.readUInt32LE(eocd + 12), cdOffset = whole.readUInt32LE(eocd + 16);
  const cut = Buffer.concat([whole.subarray(0, cdOffset + 50), whole.subarray(eocd)]);
  cut.writeUInt32LE(50, cut.length - 22 + 12);
  const huge = Buffer.from(whole);
  huge.writeUInt32LE(0xfffffff0, eocd + 12);
  assert.ok(cdSize > 50);
  for (const [name, buf] of [["cut.zip", cut], ["huge.zip", huge]]) {
    writeFileSync(join(dir, name), buf);
    r = leket(["convert", "discord", join(dir, name), "--out", join(dir, "o")]);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /central directory is damaged/, name);
  }
  assert.ok(!readdirSync(dir).includes("o"), "nothing written");
});

// one stored entry, with its central record's sizes (or name) changed after the fact
async function zipOf(name, bytes, patch = () => {}) {
  const w = new ZipWriter();
  w.add(name, bytes);
  const buf = Buffer.from(await w.parts()[0].arrayBuffer());
  patch(buf, buf.readUInt32LE(buf.length - 22 + 16)); // the central record's offset
  return buf;
}

test("unzip: an entry claiming more bytes than the file has is refused before any buffer that size is made", async () => {
  const dir = tmp();
  const path = join(dir, "claims.zip");
  // compressed and plain size 0x7ffffff0 (2 GiB) in the central record; the file is ~200 bytes
  writeFileSync(path, await zipOf("discord-x-1.json", new TextEncoder().encode("{}"), (b, cd) => {
    b.writeUInt32LE(0x7ffffff0, cd + 20);
    b.writeUInt32LE(0x7ffffff0, cd + 24);
  }));
  const [entry] = await zipEntries(path);
  const size = readFileSync(path).length;
  const alloc = Buffer.alloc, asked = [];
  Buffer.alloc = (n, ...rest) => { asked.push(n); if (n > size) throw new Error(`asked for ${n} bytes`); return alloc(n, ...rest); };
  try {
    await assert.rejects(readZipEntry(path, entry), /discord-x-1\.json is cut short \(the zip is incomplete\)/);
  } finally {
    Buffer.alloc = alloc;
  }
  assert.ok(asked.every((n) => n <= size), `no buffer past the file's ${size} bytes: ${asked}`);
  // the CLI refuses a save too large for one string on its declared size, before reading
  await assert.rejects(readDiscordSave(path), /its save discord-x-1\.json is 2048 MB, too large to read as one text/);
});

test("unzip: a deflated entry inflating past its declared size is refused (inflate is capped there)", async () => {
  const dir = tmp();
  const zip = join(dir, "bomb.zip");
  const json = join(dir, "discord-x-1.json");
  writeFileSync(json, "0".repeat(100000));
  const py = spawnSync("python3", ["-I", "-c",
    "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED); z.write(sys.argv[2], 'discord-x-1.json'); z.close()",
    zip, json], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const buf = readFileSync(zip);
  const cd = buf.readUInt32LE(buf.length - 22 + 16);
  for (const declared of [10, 0]) {
    buf.writeUInt32LE(declared, cd + 24);
    writeFileSync(zip, buf);
    const [entry] = await zipEntries(zip);
    await assert.rejects(readZipEntry(zip, entry), /discord-x-1\.json holds more than its declared \d+ bytes \(the zip is damaged\)/, `declared ${declared}`);
  }
  // deflate data that isn't deflate: the damaged-zip wording, not zlib's own
  const junk = readFileSync(zip);
  junk.writeUInt32LE(100000, cd + 24);
  junk.fill(0xff, 30 + "discord-x-1.json".length, 30 + "discord-x-1.json".length + 8);
  writeFileSync(zip, junk);
  const [entry] = await zipEntries(zip);
  await assert.rejects(readZipEntry(zip, entry), /discord-x-1\.json can't be unpacked \(the zip is damaged:/);
});

test("CLI: a save entry named with a backslash is refused unless --base names the files", async () => {
  const dir = tmp(), out = join(dir, "o");
  const path = join(dir, "sneaky.zip");
  const evil = "..\\..\\x.json";
  writeFileSync(path, await zipOf(evil, new TextEncoder().encode(JSON.stringify(dmSaves()[0]))));
  let r = leket(["convert", "discord", path, "--out", out, "--tz", "UTC"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /the save in .*sneaky\.zip is named "\.\.\\\\\.\.\\\\x", which isn't a file name; give --base NAME; nothing written/);
  assert.deepEqual(readdirSync(dir), ["sneaky.zip"], "nothing written, in --out or beside it");
  r = leket(["convert", "discord", path, "--out", out, "--tz", "UTC", "--base", "fox"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out), ["fox.md"]);
});

test("CLI: usage errors exit 2", () => {
  for (const [args, msg] of [
    [["convert", "discord", "x.json", "--by", "week"], /--by takes none, year or month/],
    [["convert", "discord", "x.json", "--tz", "Mars/Olympus"], /unknown time zone Mars\/Olympus/],
    [["convert", "discord", "x.json", "--name", "=F"], /--name takes USERNAME=LABEL/],
    [["convert", "discord", "x.json", "--base", "a/b"], /--base takes a file name/],
    [["convert", "discord"], /usage: leket convert discord/],
    [["convert", "slack", "x.json"], /usage: leket convert discord/],
  ]) {
    const r = leket(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, msg);
  }
  const h = leket(["convert", "--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--voice FILE/);
});

// --- carried #196 lows: gaps, the index label, refusals that name their cause

test("gaps: a stretch no save covers is named in the Source line; overlapping saves have none", () => {
  assert.deepEqual(mergeSaves(dmSaves()).gaps, [], "the second save reached the start, so it covers the first's span");
  const [a, b] = channelSaves();
  assert.deepEqual(mergeSaves([a, b]).gaps, [{ from: "2025-02-02T09:00:00.000Z", to: "2025-02-03T09:00:00.000Z" }]);
  // the later save reaching back past the earlier one's newest message closes the gap
  const back = { ...b, messages: [...b.messages, { ...a.messages[5], id: "2050", datetime: "2025-02-02T08:00:00.000Z" }] };
  assert.deepEqual(mergeSaves([a, back]).gaps, []);
  // a save asked to stop at a day covers back to that day
  assert.deepEqual(mergeSaves([a, { ...b, reached_since: "2025-02-01" }]).gaps, []);
  const md = render(mergeSaves([b, a]), { base: "c", by: "none", timeZone: "UTC" })[0].text;
  assert.match(md, /; GAP: no save covers 2025-02-02 09:00 UTC to 2025-02-03 09:00 UTC, so messages from then may be missing\./);
});

test("a message id that isn't a Discord id is refused by name, not by BigInt", () => {
  const [d] = dmSaves();
  assert.throws(() => mergeSaves([{ ...d, messages: [...d.messages, { ...d.messages[0], id: "abc" }] }]), /save 1 has a message whose id \("abc"\) isn't a Discord id/);
  assert.throws(() => mergeSaves([{ ...d, messages: [null] }]), /id \(null\) isn't a Discord id/);
});

test("the --by none index row escapes the title's | and ] so the cell and link hold", () => {
  const [a] = channelSaves();
  const idx = render(mergeSaves([a]), { base: "c", by: "none", title: "a | b] [c", timeZone: "UTC" }).at(-1).text;
  assert.ok(idx.includes("| [a \\| b\\] \\[c](c.md) | 6 |"), idx);
});

test("CLI: a bad --voice map, a save that isn't JSON or a bad id write nothing and say why", () => {
  const dir = tmp(), out = join(dir, "o");
  const save = join(dir, "s.json");
  writeFileSync(save, JSON.stringify(dmSaves()[0]));
  const voice = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  for (const [v, msg] of [
    [voice("arr.json", "[1]"), /isn't a voice map/],
    [voice("odd.json", JSON.stringify({ "105_0": { text: "no duration" } })), /isn't a voice map .*: 105_0 has no duration in seconds/],
    [voice("bad.json", "{"), /--voice .*bad\.json: .*JSON/],
  ]) {
    const r = leket(["convert", "discord", save, "--out", out, "--voice", v]);
    assert.equal(r.status, 1, v);
    assert.match(r.stderr, msg, v);
    assert.match(r.stderr, /nothing written/, v);
  }
  const junk = voice("junk.json", "<html>");
  const notJson = leket(["convert", "discord", junk, "--out", out]);
  assert.equal(notJson.status, 1);
  assert.match(notJson.stderr, /JSON.*nothing written/);
  const badId = voice("badid.json", JSON.stringify({ ...dmSaves()[0], messages: [{ id: "x1", datetime: "2025-01-01T00:00:00Z" }] }));
  const r = leket(["convert", "discord", badId, "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't a Discord id; nothing written/);
  assert.ok(!readdirSync(dir).includes("o"), "nothing written");
});

test("CLI: a folder that can't be made, and a file write that fails partway, say which", () => {
  const dir = tmp();
  const saves = channelSaves().map((s, i) => { const p = join(dir, `c${i}.json`); writeFileSync(p, JSON.stringify(s)); return p; });
  writeFileSync(join(dir, "afile"), "");
  const blocked = leket(["convert", "discord", ...saves, "--out", join(dir, "afile", "o"), "--base", "c"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /couldn't make the folder .*afile\/o .*; nothing written/);
  // the third of four files is a folder already: two written, then the failure names it
  const out = join(dir, "o");
  mkdirSync(join(out, "c-participants.md"), { recursive: true });
  const partway = leket(["convert", "discord", ...saves, "--out", out, "--base", "c"]);
  assert.equal(partway.status, 1);
  assert.match(partway.stderr, /couldn't write .*c-participants\.md .*; 2 of 4 files written/);
  assert.equal(partway.stdout.trim().split("\n").length, 2);
});

test("a save with no usable newer time adds no span, so the gap check can't crash on it", () => {
  const [a, b] = channelSaves();
  const timeless = { ...a, reached_start: true, extracted_at: "not a date", messages: [] };
  assert.deepEqual(mergeSaves([timeless, b]).gaps, []);
  assert.doesNotThrow(() => render(mergeSaves([timeless, b]), { base: "c", timeZone: "UTC" }));
  // a hole in the messages list is a bad entry too, not a pass
  assert.throws(() => mergeSaves([{ ...a, messages: new Array(1) }]), /save 1 has a message whose id \(undefined\) isn't a Discord id/);
});

test("the index links a --base holding # ? ( ) as one encoded file name, and a title's line break stays in its cell", () => {
  const [a] = channelSaves();
  const idx = render(mergeSaves([a]), { base: "a#b?(c)", by: "none", title: "two\nlines", timeZone: "UTC" }).at(-1).text;
  assert.ok(idx.includes("| [two lines](a%23b%3F%28c%29.md) | 6 |"), idx);
});

test("CLI: a voice entry with a negative duration is refused", () => {
  const dir = tmp();
  const save = join(dir, "s.json");
  writeFileSync(save, JSON.stringify(dmSaves()[0]));
  const v = join(dir, "neg.json");
  writeFileSync(v, JSON.stringify({ "105_0": { duration: -3, text: "x" } }));
  const r = leket(["convert", "discord", save, "--out", join(dir, "o"), "--voice", v]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /105_0 has no duration in seconds \(a number, 0 or more\)/);
});
