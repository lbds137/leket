// `leket convert chatgpt`: src/convert/chatgpt.js renders, bin/leket.js reads the exports
// (folder, zip or conversations.json) and writes. test/fixtures/convert-chatgpt/plans.md is
// the reviewed output for the synthetic export in test/fixtures/chatgpt-export.js; it also
// matched the private converter this ports, byte for byte, on the same input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { badFolder, collect, plan, render, safeTitle, stamp } from "../src/convert/chatgpt.js";
import { ZipWriter } from "../src/lib/zip.js";
import { chatgptExports } from "./fixtures/chatgpt-export.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const golden = readFileSync(join(here, "fixtures", "convert-chatgpt", "plans.md"), "utf8");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-chatgpt-"));
const files = (opts) => plan(collect(chatgptExports()), opts);

// each export as a folder of its own, as ChatGPT's zip unpacks
function exportDirs(root) {
  return chatgptExports().map((e, i) => {
    const d = join(root, `export-${i + 1}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "conversations.json"), JSON.stringify(e.conversations));
    writeFileSync(join(d, "conversation_asset_file_names.json"), JSON.stringify(e.names));
    return d;
  });
}

test("the current branch, in order, matches the golden file", () => {
  const f = files().find((x) => x.id === "c-plans-0001");
  assert.equal(f.name, "2024-03-05 Plans - ideas.md");
  assert.equal(f.text, golden);
  // what stays out: the abandoned answer, system, tool, hidden, blank
  for (const gone of ["before the edit", "tool output", "a hidden note", "### ChatGPT · \n \n"]) assert.ok(!f.text.includes(gone), gone);
  assert.equal(f.turns, 5);
  assert.deepEqual(f.skipped, { code: 1 });
});

test("a later export's copy of a conversation replaces the earlier one, in the later place", () => {
  const c = collect(chatgptExports());
  assert.deepEqual(c.conversations.map((x) => x.id), ["c-null-0002", "c-same1-0003", "c-plans-0001", "c-same2-0004", "c-pad-0005"]);
  assert.equal(c.conversations[2].c.title, "Plans / ideas..");
  // the file-name maps merge: the first export's name still applies
  assert.equal(c.names["file-NAMED1.dat"], "photo.png");
});

test("file names: no title, no start time, a shared name, padding", () => {
  const names = files().map((f) => f.name);
  assert.deepEqual(names, ["undated untitled.md", "2024-03-06 Same.md", "2024-03-05 Plans - ideas.md", "2024-03-06 Same (c-same2-).md", "2024-03-07 Padded.md"]);
  assert.match(files()[0].text, /^# untitled\n\nConversation: https:\/\/chatgpt\.com\/c\/c-null-0002\nCreated: \nUpdated: 1970-01-01T01:00:00Z\n/);
});

test("a shared name is also caught case-blind and past a first suffix", () => {
  const c = (id, title) => ({ conversation_id: id, title, create_time: 1709651220, mapping: {}, current_node: null });
  const out = plan(collect([{ conversations: [c("aaaaaaaa-1", "Same"), c("aaaaaaaa-2", "same"), c("aaaaaaaa-3", "SAME")], names: {} }]));
  assert.deepEqual(out.map((f) => f.name), ["2024-03-05 Same.md", "2024-03-05 same (aaaaaaaa).md", "2024-03-05 SAME (aaaaaaaa-3 2).md"]);
});

test("labels and the time zone are flags", () => {
  const f = files({ user: "Me", assistant: "Bot", timeZone: "America/New_York" }).find((x) => x.id === "c-plans-0001");
  assert.match(f.text, /^### Me · 2024-03-05T10:07:00-05:00\nfirst question\n/m);
  assert.match(f.text, /^### Bot · 2024-03-05T10:07:20-05:00\n/m);
  // the day in the file name is the zone's: 00:30 UTC is the evening before in New York
  const late = { conversation_id: "late", title: "Late", create_time: Date.UTC(2024, 2, 6, 0, 30) / 1000, mapping: {}, current_node: null };
  assert.equal(plan(collect([{ conversations: [late] }]), { timeZone: "America/New_York" })[0].name, "2024-03-05 Late.md");
});

test("stamp: whole seconds (dropped, not rounded), Z only in UTC, empty for no time", () => {
  assert.equal(stamp(1709651220.999), "2024-03-05T15:07:00Z");
  assert.equal(stamp(1709651220, "Asia/Kolkata"), "2024-03-05T20:37:00+05:30");
  assert.equal(stamp(1709651220, "Atlantic/Reykjavik"), "2024-03-05T15:07:00+00:00");
  for (const t of [0, null, undefined, "1709651220", NaN, 1e20]) assert.equal(stamp(t), "", String(t));
});

test("safeTitle and badFolder keep names inside the output folder", () => {
  assert.equal(safeTitle("a/b\\c:d\x07e..."), "a-b-c-d-e");
  assert.equal(safeTitle("..."), "untitled");
  const long = safeTitle("é".repeat(300));
  assert.ok(new TextEncoder().encode(long).length <= 200);
  assert.equal(long, "é".repeat(100));
  for (const f of ["", "/abs", "a/../b", "..", "a//b", "a\\b", "c:x", "a/", "x\n"]) assert.ok(badFolder(f), JSON.stringify(f));
  for (const f of ["topic", "a/b", "occult stuff"]) assert.ok(!badFolder(f), f);
});

test("a bad mapping is refused by name: a loop, a missing message, no id", () => {
  const base = { conversation_id: "c1", title: "t", create_time: 1 };
  const loop = { ...base, current_node: "a", mapping: { a: { parent: "b" }, b: { parent: "a" } } };
  assert.throws(() => render({ id: "c1", c: loop }), /conversation c1: its messages loop back to a/);
  const missing = { ...base, current_node: "a", mapping: { a: { parent: "gone" } } };
  assert.throws(() => render({ id: "c1", c: missing }), /conversation c1: message gone isn't in its mapping/);
  const proto = { ...base, current_node: "__proto__", mapping: {} };
  assert.throws(() => render({ id: "c1", c: proto }), /message __proto__ isn't in its mapping/);
  assert.throws(() => collect([{ conversations: [{ title: "x", mapping: {} }] }]), /conversation 1 has no conversation_id/);
  assert.throws(() => collect([{ label: "e", conversations: {} }]), /e: its conversations\.json isn't a list/);
  // an export that only has "id" (no conversation_id) still converts
  assert.equal(collect([{ conversations: [{ id: "only-id", mapping: {} }] }]).conversations[0].id, "only-id");
});

test("CLI: two export folders, routed by --folders, the rest --unlisted", () => {
  const dir = tmp(), out = join(dir, "out");
  const [one, two] = exportDirs(dir);
  writeFileSync(join(dir, "folders.tsv"), "id\tfolder\tnote\nc-pad-0005\ttopic/sub\tx\n\nc-same1-0003\tother\t\n");
  const r = leket(["convert", "chatgpt", one, two, "--out", out, "--folders", join(dir, "folders.tsv"), "--unlisted", "unsorted"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["other", "topic", "unsorted"]);
  assert.deepEqual(readdirSync(join(out, "topic", "sub")), ["2024-03-07 Padded.md"]);
  assert.deepEqual(readdirSync(join(out, "other")), ["2024-03-06 Same.md"]);
  // in its own folder, the second "Same" no longer shares a name
  assert.deepEqual(readdirSync(join(out, "unsorted")).sort(), ["2024-03-05 Plans - ideas.md", "2024-03-06 Same.md", "undated untitled.md"]);
  assert.equal(readFileSync(join(out, "unsorted", "2024-03-05 Plans - ideas.md"), "utf8"), golden);
  assert.equal(r.stdout.trim().split("\n").length, 5);
  assert.match(r.stderr, /5 conversations, 13 messages, from 2 export\(s\); times in UTC\. Not shown \(no text\): code 1\./);
});

test("CLI: a conversations.json given directly finds its names file beside it", () => {
  const dir = tmp(), out = join(dir, "out");
  const [one] = exportDirs(dir);
  const r = leket(["convert", "chatgpt", join(one, "conversations.json"), "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(out, "2024-03-05 an older title.md"), "utf8");
  assert.match(text, /\[image: photo\.png\]/);
});

test("CLI: the export's zip, its files inside a folder", async () => {
  const dir = tmp(), out = join(dir, "out");
  const [e] = chatgptExports();
  const w = new ZipWriter();
  w.add("export/conversations.json", new TextEncoder().encode(JSON.stringify(e.conversations)));
  w.add("export/conversation_asset_file_names.json", new TextEncoder().encode(JSON.stringify(e.names)));
  w.add("export/sectioned_conversations.json", new TextEncoder().encode("[]"));
  writeFileSync(join(dir, "export.zip"), Buffer.from(await w.parts()[0].arrayBuffer()));
  const r = leket(["convert", "chatgpt", join(dir, "export.zip"), "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(out).length, 3);
  assert.match(readFileSync(join(out, "2024-03-05 an older title.md"), "utf8"), /\[image: photo\.png\]/);
});

test("CLI: an unreadable export or a bad --folders row writes nothing", async () => {
  const dir = tmp(), out = join(dir, "out");
  const [one] = exportDirs(dir);
  writeFileSync(join(dir, "bad.tsv"), "id\tfolder\nc-pad-0005\t../escape\n");
  let r = leket(["convert", "chatgpt", one, "--out", out, "--folders", join(dir, "bad.tsv")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /row 2 names the folder "\.\.\/escape", which isn't a relative folder.*nothing written/);
  writeFileSync(join(dir, "nohead.tsv"), "c-pad-0005\ttopic\n");
  r = leket(["convert", "chatgpt", one, "--out", out, "--folders", join(dir, "nohead.tsv")]);
  assert.match(r.stderr, /its header row has no "id" and "folder" columns/);
  writeFileSync(join(dir, "junk.json"), "{not json");
  r = leket(["convert", "chatgpt", join(dir, "junk.json"), "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /junk\.json isn't JSON .*nothing written/);
  const w = new ZipWriter();
  w.add("other.json", new TextEncoder().encode("[]"));
  writeFileSync(join(dir, "other.zip"), Buffer.from(await w.parts()[0].arrayBuffer()));
  r = leket(["convert", "chatgpt", join(dir, "other.zip"), "--out", out]);
  assert.match(r.stderr, /holds no conversations\.json: not a ChatGPT export; nothing written/);
  r = leket(["convert", "chatgpt", join(dir, "nowhere"), "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ENOENT.*nothing written/);
  assert.ok(!readdirSync(dir).includes("out"));
});

test("CLI: usage errors exit 2", () => {
  for (const [args, msg] of [
    [["convert", "chatgpt"], /usage: leket convert chatgpt/],
    [["convert", "chatgpt", "x", "--tz", "Mars/Olympus"], /unknown time zone Mars\/Olympus/],
    [["convert", "chatgpt", "x", "--unlisted", "../up"], /--unlisted takes a relative folder/],
    [["convert", "chatgpt", "x", "--user", "a\nb"], /--user takes a one-line label/],
    [["convert", "chatgpt", "x", "--speaker", "a"], /Unknown option '--speaker'/],
  ]) {
    const r = leket(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, msg);
  }
  const h = leket(["convert", "chatgpt", "--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--unlisted FOLDER/);
});
