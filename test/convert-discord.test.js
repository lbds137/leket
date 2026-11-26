// `leket convert discord`: src/modules/discord/convert.js renders, bin/leket.js reads the
// saves (JSON, or Leket's zip through src/lib/unzip.js) and writes. The golden files in
// test/fixtures/convert-discord/ are the reviewed output for the synthetic saves in
// test/fixtures/discord-saves.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeSaves, render } from "../src/modules/discord/convert.js";
import { build } from "../src/lib/build.js";
import { ZipWriter } from "../src/lib/zip.js";
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
  // "111" < "1234…" as a string but not as a number: the short id stays before them
  assert.equal(conv.messages.at(-3).id, "111");
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
});

test("refusals: saves of two conversations, a save with no messages list, no messages at all", () => {
  const [d] = dmSaves(), [c] = channelSaves();
  assert.throws(() => mergeSaves([d, c]), /save 2 is of channel 700, not 900/);
  assert.throws(() => mergeSaves([{ channel_id: "1" }]), /no messages list/);
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
  assert.deepEqual(readdirSync(dir).sort(), ["bad.zip", "discord-general-700-part2-of-2.zip"]);
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
