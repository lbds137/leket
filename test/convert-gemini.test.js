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
    [["convert", "gemini", "x", "--other", "/abs"], /--other takes a relative folder/],
    [["convert", "chatgpt", "x", "--other", "o"], /Unknown option '--other'/],
  ]) {
    r = leket(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, msg);
  }
  assert.match(leket(["convert", "gemini", "--help"]).stdout, /--titles FILE/);
});
