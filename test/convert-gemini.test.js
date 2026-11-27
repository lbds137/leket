// `leket convert gemini`: src/convert/gemini.js rebuilds chats from Takeout's activity rows,
// bin/leket.js reads the Takeouts (folder, zip or JSON file) and writes. The fixture
// (test/fixtures/gemini-takeout.js) is synthetic; convert-gemini/lisbon.md is the reviewed output
// for its main chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collect, convId, gutted, plan, slug } from "../src/convert/gemini.js";
import { ZipWriter } from "../src/lib/zip.js";
import { readGeminiExport } from "../bin/leket.js";
import { geminiSnapshots } from "./fixtures/gemini-takeout.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-gemini-"));
const run = (opts) => plan(collect(geminiSnapshots()), opts);
const byName = (r, name) => r.files.find((f) => f.name === name);

const golden = (name) => readFileSync(join(here, "fixtures", "convert-gemini", name), "utf8");
const LISBON = golden("lisbon.md");

test("a chat is rebuilt across snapshots: prompts, drafts, files, a gem, a canvas", () => {
  const r = run();
  const f = byName(r, "2025-03-01 Plan a trip to Lisbon 3 days, cheap.md");
  // the older snapshot's reply wins for a row both have; the newer adds "thanks";
  // a repeated draft and a blank one are dropped
  assert.equal(f.text, LISBON);
  assert.equal(f.kind, "chat");
  assert.equal(f.id, "aaa111");
  assert.equal(f.prompts, 3);
  assert.ok(!f.text.includes("Changed later"));
});

test("names: oldest chat first, a shared name gets the id, non-Latin prompts keep their letters", () => {
  const r = run();
  assert.deepEqual(r.files.map((f) => `${f.folder}|${f.name}`), [
    "|2025-03-01 Plan a trip to Lisbon 3 days, cheap.md",
    "|2025-03-01 Plan a trip to Lisbon 3 days, cheap (eee555).md",
    "|2025-03-02 https g co gemini share abc.md",
    "|2025-03-04 שלום, מה שלומך היום (טסט).md",
    "|other-activity.md",
    "canvases|2025-03-01 Packing List.md",
    "canvases|2025-03-03 Trip Plan.md",
  ]);
  assert.equal(slug({ title: `Prompted ${"word ".repeat(20)}` }), "word ".repeat(11) + "word");
  assert.equal(slug({ title: "Prompted ???" }), "untitled");
  // names keep only letters, digits and _ , ' ( ) -: nothing Windows refuses (* ? " < > |)
  assert.equal(slug({ title: 'Prompted a*b?c"d<e>f|g' }), "a b c d e f g");
});

test("a chat added from a link, and a reply that was a malformed <pre>", () => {
  const r = run();
  assert.match(byName(r, "2025-03-02 https g co gemini share abc.md").text,
    /### User · 2025-03-02T10:00:00Z\n\*\(chat added from a shared link\)\*\n\nhttps:\/\/g\.co\/gemini\/share\/abc\n\n### Gemini · 2025-03-02T10:00:00Z\nShared answer with \\\$5 and a\\\|pipe\.\n$/);
  assert.match(byName(r, "2025-03-04 שלום, מה שלומך היום (טסט).md").text,
    /> file: `photo\.png`\n\n### Gemini · 2025-03-04T12:00:00Z\n```\nmodel A \{\nid String\n\}\n-- end\n```\n$/);
});

test("rows of no chat go to other-activity.md; canvases get files; --other moves both", () => {
  let r = run();
  const other = byName(r, "other-activity.md").text;
  // a linked conversation with no prompt (phone Assistant) is not a chat
  assert.match(other, /\*Used an Assistant feature · 2025-03-02T11:00:00Z\*\nhttps:\/\/gemini\.google\.com\/app\/ccc333\n/);
  assert.match(other, /Document: \[canvases\/2025-03-03 Trip Plan\.md\]\(canvases\/2025-03-03%20Trip%20Plan\.md\)/);
  assert.match(other, /\*Gave feedback: Good response · 2025-03-03T08:30:00Z\*\n$/);
  assert.equal(byName(r, "2025-03-01 Packing List.md").text, "# Packing\n\n- socks\n- charger\n");
  r = run({ other: "gemini/misc", folders: { aaa111: "trips" } });
  assert.match(byName(r, "other-activity.md").text, /\(canvases\/2025-03-03%20Trip%20Plan\.md\)/);
  assert.equal(byName(r, "2025-03-01 Packing List.md").folder, "gemini/misc/canvases");
  assert.match(byName(r, "2025-03-01 Plan a trip to Lisbon 3 days, cheap.md").text,
    /\]\(\.\.\/gemini\/misc\/canvases\/2025-03-01%20Packing%20List\.md\)/);
  // two canvases of one name on one day are numbered
  const canvas = (t) => ({ header: "Gemini Apps", title: "Created Gemini Canvas titled Same", time: t, subtitles: [{ name: "x\ny" }] });
  const c = plan(collect([{ rows: [canvas("2025-01-01T01:00:00Z"), canvas("2025-01-01T02:00:00Z")] }]));
  assert.deepEqual(c.files.filter((f) => f.kind === "canvas").map((f) => f.name), ["2025-01-01 Same.md", "2025-01-01 Same (2).md"]);
  // a title with nothing left is "untitled"; a parenthesis in the link is encoded, or it
  // would end the Markdown link early
  const odd = (title) => ({ header: "Gemini Apps", title: `Created Gemini Canvas titled ${title}`, time: "2025-01-01T01:00:00Z", subtitles: [{ name: "x\ny" }] });
  const o = plan(collect([{ rows: [odd("???"), odd("1) List")] }]));
  assert.deepEqual(o.files.filter((f) => f.kind === "canvas").map((f) => f.name), ["2025-01-01 untitled.md", "2025-01-01 1) List.md"]);
  assert.match(byName(o, "other-activity.md").text, /\]\(canvases\/2025-01-01%201%29%20List\.md\)/);
});

test("--folders, --titles, --unlisted, labels and time zone", () => {
  const r = run({ folders: { eee555: "trips/again" }, unlisted: "unsorted", titles: { aaa111: "Lisbon trip" }, user: "Me", assistant: "Bot", timeZone: "America/New_York" });
  const f = r.files.find((x) => x.id === "aaa111");
  assert.equal(f.folder, "unsorted");
  assert.match(f.text, /^# Lisbon trip\n/);
  assert.match(f.text, /### Me · 2025-03-01T04:00:00-05:00\n/);
  assert.match(f.text, /### Bot \(draft 2\) · /);
  // the name comes from the prompt, not the title; in its own folder, no suffix
  assert.equal(r.files.find((x) => x.id === "eee555").name, "2025-03-01 Plan a trip to Lisbon 3 days, cheap.md");
  assert.equal(r.files.find((x) => x.id === "eee555").folder, "trips/again");
  // "Titles" naming Object.prototype's keys stay data
  assert.match(plan(collect(geminiSnapshots()), { titles: JSON.parse('{"__proto__": "x"}') }).files[0].text, /^# Plan a trip/);
});

test("the numbers the summary reports", () => {
  const s = run().stats;
  assert.deepEqual({ ...s, unknown: { ...s.unknown } }, {
    rows: 10, chats: 4, loose: 3, canvases: 2, prompts: 6, replies: 6, cut: 1, cutChats: 1,
    short: 0, unknown: {}, otherProducts: 1, unrecognised: false,
  });
  // a Takeout in another language: links, but no row reads as a prompt
  const r = plan(collect([{ rows: [{ header: "Gemini-Apps", title: "Eingabe: hallo", time: "2025-01-01T00:00:00Z", details: [{ url: "https://gemini.google.com/app/abc" }] }] }]));
  assert.equal(r.stats.unrecognised, true);
  assert.equal(r.stats.chats, 0);
});

test("small parts: the chat id, the gutted test, the row filter", () => {
  assert.equal(convId({ details: [{ name: "x" }, { url: "https://gemini.google.com/app/0fa9?hl=en" }] }), "0fa9");
  assert.equal(convId({ details: "nope" }), null);
  // only a link that is to gemini.google.com, not one that mentions it
  assert.equal(convId({ details: [{ url: "https://e.example/?u=gemini.google.com/app/abc" }] }), null);
  // a row of no chat shows its title as written, inside the *…*
  const fb = plan(collect([{ rows: [{ header: "Gemini Apps", title: " Gave feedback: *bad* [x] ", time: "2025-01-01T00:00:00Z" }] }]));
  assert.match(byName(fb, "other-activity.md").text, /\n\*Gave feedback: \\\*bad\\\* \\\[x\\\] · 2025-01-01T00:00:00Z\*\n/);
  // a chat sent by --folders into the canvas folder never takes a canvas's file name
  const at = "2025-01-01T01:00:00Z";
  const rows = [
    { header: "Gemini Apps", title: "Created Gemini Canvas titled Same", time: at, subtitles: [{ name: "canvas\ntext" }] },
    { header: "Gemini Apps", title: "Prompted Same", time: at, details: [{ url: "https://gemini.google.com/app/abcdef12" }] },
  ];
  const clash = plan(collect([{ rows }]), { folders: { abcdef12: "canvases" } }).files.filter((f) => f.folder === "canvases");
  assert.deepEqual(clash.map((f) => [f.kind, f.name]).sort(), [["canvas", "2025-01-01 Same.md"], ["chat", "2025-01-01 Same (abcdef).md"]]);
  assert.ok(gutted("<ul><li>.</li><li> </li></ul>"));
  assert.ok(!gutted("<ul><li>.</li><li>ok</li></ul>"));
  // rows that aren't rows are passed over; other products are counted, not kept
  const c = collect([{ rows: [null, 5, { time: 1, title: "x" }, { header: "Maps", title: "Viewed", time: "2025-01-01T00:00:00Z" }] }]);
  assert.deepEqual(c, { rows: [], other: 1 });
});

// each snapshot as a Takeout folder, its activity file named in another language
function takeoutDirs(root) {
  return geminiSnapshots().map((s, i) => {
    const d = join(root, `takeout-${i + 1}`, "My Activity", "Gemini");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "הפעילות שלי.json"), JSON.stringify(s.rows));
    // a JSON file attached to a chat sits beside it and isn't activity
    writeFileSync(join(d, "attached.json"), JSON.stringify({ time: "x", title: "y" }));
    return join(root, `takeout-${i + 1}`);
  });
}

test("CLI: two Takeout folders, the older first", () => {
  const dir = tmp(), out = join(dir, "out");
  const [one, two] = takeoutDirs(dir);
  writeFileSync(join(dir, "folders.tsv"), "id\tfolder\ttitle\neee555\ttrips\t\n");
  writeFileSync(join(dir, "titles.tsv"), "id\ttitle\naaa111\tLisbon trip\n");
  const r = leket(["convert", "gemini", one, two, "--out", out, "--folders", join(dir, "folders.tsv"),
    "--titles", join(dir, "titles.tsv"), "--unlisted", "unsorted", "--other", "gemini"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["gemini", "trips", "unsorted"]);
  assert.deepEqual(readdirSync(join(out, "gemini")).sort(), ["canvases", "other-activity.md"]);
  assert.match(readFileSync(join(out, "unsorted", "2025-03-01 Plan a trip to Lisbon 3 days, cheap.md"), "utf8"), /^# Lisbon trip\n/);
  assert.equal(r.stdout.trim().split("\n").length, 7);
  assert.match(r.stderr, /4 chats \(6 prompts, 6 replies\), 3 rows outside chats, 2 canvases, from 10 rows in 2 export\(s\); times in UTC\./);
  assert.match(r.stderr, /Replies Takeout removed text from: 1, in 1 chats\./);
  assert.match(r.stderr, /Rows of other Google products passed over: 1\./);
});

test("CLI: a Takeout zip, and the activity JSON given directly", async () => {
  const dir = tmp();
  const [older, newer] = geminiSnapshots();
  const w = new ZipWriter();
  w.add("Takeout/My Activity/Gemini/MyActivity.json", new TextEncoder().encode(JSON.stringify(older.rows)));
  w.add("Takeout/My Activity/Gemini/notes.json", new TextEncoder().encode("{not json"));
  writeFileSync(join(dir, "takeout.zip"), Buffer.from(await w.parts()[0].arrayBuffer()));
  writeFileSync(join(dir, "newer.json"), JSON.stringify(newer.rows));
  const r = leket(["convert", "gemini", join(dir, "takeout.zip"), join(dir, "newer.json"), "--out", join(dir, "out")]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "out", "2025-03-01 Plan a trip to Lisbon 3 days, cheap.md"), "utf8"), LISBON);
});

test("a JSON file too large to read is passed over and named, in a zip or a folder", async () => {
  const dir = tmp();
  const activity = JSON.stringify(geminiSnapshots()[0].rows);
  const bytes = Buffer.byteLength(activity); // the limit is in bytes: the fixture isn't all ASCII
  const huge = `[${" ".repeat(bytes + 100)}]`;
  const w = new ZipWriter();
  w.add("Takeout/My Activity/Gemini/MyActivity.json", new TextEncoder().encode(activity));
  w.add("Takeout/Location History/Records.json", new TextEncoder().encode(huge));
  writeFileSync(join(dir, "takeout.zip"), Buffer.from(await w.parts()[0].arrayBuffer()));
  mkdirSync(join(dir, "t", "Maps"), { recursive: true });
  writeFileSync(join(dir, "t", "MyActivity.json"), activity);
  writeFileSync(join(dir, "t", "Maps", "Records.json"), huge);
  const limit = bytes + 1;
  for (const path of [join(dir, "takeout.zip"), join(dir, "t")]) {
    const skipped = [];
    const found = await readGeminiExport(path, { skipped, limit });
    assert.equal(found.length, 1, path);
    assert.equal(skipped.length, 1, path);
    assert.match(skipped[0], /Records\.json \(0 MB\)$/);
  }
  // nothing else there: the error says what was passed over
  await assert.rejects(readGeminiExport(join(dir, "t"), { limit: 10 }), /holds no Takeout activity JSON.*passed over as too large: .*MyActivity\.json/);
  // ...naming only its own export's files, not those an earlier export passed over
  const shared = [];
  await readGeminiExport(join(dir, "t"), { skipped: shared, limit });
  mkdirSync(join(dir, "empty"));
  await assert.rejects(readGeminiExport(join(dir, "empty"), { skipped: shared, limit }), (e) => !/Records|passed over/.test(e.message));
  assert.equal(shared.length, 1);
  // a read that throws ERR_STRING_TOO_LONG although the file's size passed the limit: that
  // file is passed over and named too
  const tooLong = async (p, enc) => {
    if (p.endsWith("Records.json")) throw Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
    return readFileSync(p, enc);
  };
  const skipped = [];
  assert.equal((await readGeminiExport(join(dir, "t"), { skipped, read: tooLong })).length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /Records\.json \(0 MB\)$/);
});

test("CLI: no activity, a bad file, usage errors", () => {
  const dir = tmp(), out = join(dir, "out");
  writeFileSync(join(dir, "list.json"), "[1, 2]");
  let r = leket(["convert", "gemini", join(dir, "list.json"), "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /list\.json isn't a list of Takeout activity rows; nothing written/);
  mkdirSync(join(dir, "empty"));
  r = leket(["convert", "gemini", join(dir, "empty"), "--out", out]);
  assert.match(r.stderr, /holds no Takeout activity JSON.*nothing written/);
  writeFileSync(join(dir, "maps.json"), JSON.stringify([{ header: "Maps", title: "Viewed", time: "2025-01-01T00:00:00Z" }]));
  r = leket(["convert", "gemini", join(dir, "maps.json"), "--out", out]);
  assert.match(r.stderr, /no Gemini rows in 1 export\(s\) \(1 rows of other Google products\); nothing written/);
  assert.ok(!readdirSync(dir).includes("out"));
  for (const [args, msg] of [
    [["convert", "gemini"], /usage: leket convert/],
    [["convert", "gemini", "x", "--other", "/abs"], /--other takes a relative folder \(no \\ : \* \? " < > \|, \. or \.\. parts, no part ending in a dot or space, no Windows reserved name like con, nul, conin\$ or conout\$, no control characters\)/],
    [["convert", "chatgpt", "x", "--other", "o"], /Unknown option '--other'/],
  ]) {
    r = leket(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, msg);
  }
  assert.match(leket(["convert", "gemini", "--help"]).stdout, /--titles FILE/);
});

test("heading escapes the break-class in chat titles", () => {
  const r = run({ titles: { aaa111: "Trip &amp; <b> ` #" } });
  const f = r.files.find((x) => x.id === "aaa111");
  assert.equal(f.text.split("\n")[0], "# Trip \\&amp; \\<b> \\` \\#");
});
