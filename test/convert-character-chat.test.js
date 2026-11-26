// `leket convert character-chat`: src/convert/character-chat.js renders, bin/leket.js reads
// the export JSON and writes. The export below is synthetic (invented characters and text).
// On a real export the port matched the private converter it replaces file for file, apart
// from the deliberate differences the module's header and plan() name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collect, minute, plan, render } from "../src/convert/character-chat.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-character-chat-"));

const T0 = Date.UTC(2024, 2, 5, 14, 3); // 2024-03-05 14:03 UTC, 09:03 in New York
const MIN = 60_000;
const msg = (id, role, content, at) => ({ id, role, content, createdAt: at });

function exportData() {
  return {
    exported: "2024-10-01T00:00:00.000Z",
    characters: {
      "ch-moth": { name: "Moth Keeper", creator_username: "inventor", title: "keeps moths", persona: "  Quiet. Likes lamps.  ", scenario: "A lighthouse.", greeting: "Hello, traveller.", dialogue: "" },
      "ch-gear": { name: "Gear | Smith", title: "", greeting: "Clank." }, // no creator; a pipe in the name
      "ch-gone": { error: "Error: failed: /characters/ch-gone" }, // the card couldn't be fetched
      "ch-aard": { name: "Aardvark Oracle", creator_username: "inventor" },
    },
    conversations: [
      { id: "conv-1", character_id: "ch-moth", meta: { label: " Lamp talk ", num_messages: 4, userPersona: { name: "Wren" } },
        messages: [msg("m1", "user", "  Is the lamp lit?  ", T0), msg("m2", "bot", "It is.\n\n*flutters*", T0 + MIN), msg("m3", "user", "Good.", T0 + 2 * MIN)] },
      // no label, no persona, the count matches
      { id: "conv-2", character_id: "ch-gear", meta: { num_messages: 2 },
        messages: [msg("g1", "user", "Fix this?", T0 + 86_400_000), msg("g2", "assistant", "Clank clank.", T0 + 86_400_000 + MIN)] },
      // the character's card is missing: the conversation's own copy names it
      { id: "conv-3", character_id: "ch-gone", character: { name: "Ghost Lantern" }, meta: {},
        messages: [msg("x1", "user", "Boo?", T0 - 86_400_000)] },
      // nothing names the character
      { id: "conv-4", character_id: "ch-none", meta: { label: "lamp TALK" }, messages: [msg("n1", "bot", "…", T0 + 3 * MIN)] },
      { id: "conv-5", character_id: "ch-moth", meta: { label: "Lamp talk" }, messages: [] }, // empty: left out
      { id: "conv-6", character_id: "ch-moth", meta: { label: "index" }, messages: [msg("i1", "user", "Odd label", T0 + 4 * MIN)] },
      { id: "conv-7", character_id: "ch-moth", meta: { label: "Why? <maybe> \"so\" *really*" }, messages: [msg("w1", "user", "Hm", T0 + 5 * MIN)] },
    ],
  };
}
const exportOf = (data = exportData(), label = "export.json") => ({ label, data });
const planned = (opts = { timeZone: "America/New_York" }) => plan(collect([exportOf()]), opts);
const byName = (files) => Object.fromEntries(files.map((f) => [f.name, f.text]));

test("a conversation renders with its label, persona, creator, count gap and stripped text", () => {
  const f = byName(planned().files)["Lamp talk.md"];
  assert.equal(f, [
    "# Lamp talk",
    "",
    "Character chat conversation with **Moth Keeper** (character by inventor), 2024-03-05 09:03 to 2024-03-05 09:05; " +
      "3 messages saved of 4 the site counts (the gap is probably regenerated or deleted replies; not checked). " +
      "Source: `export.json`, conversation `conv-1`.",
    "",
    "## Wren · 2024-03-05 09:03", "", "Is the lamp lit?", "",
    "## Moth Keeper · 2024-03-05 09:04", "", "It is.\n\n*flutters*", "",
    "## Wren · 2024-03-05 09:05", "", "Good.", "",
  ].join("\n"));
});

test("unlabelled conversations are named 'Character YYYY-MM-DD'; --user and --site fill in", () => {
  const files = byName(plan(collect([exportOf()]), { user: "Me", site: "Bots", timeZone: "UTC" }).files);
  const g = files["Gear - Smith 2024-03-06.md"];
  assert.match(g, /^# Gear \| Smith\n\nBots conversation with \*\*Gear \| Smith\*\*, 2024-03-06 14:03 to 2024-03-06 14:04; 2 messages, as many as the site counts\./);
  assert.match(g, /## Me · 2024-03-06 14:03\n\nFix this\?\n/);
  assert.match(g, /## Gear \| Smith · 2024-03-06 14:04\n\nClank clank\.\n/);
  assert.match(files["Ghost Lantern 2024-03-04.md"], /\*\*Ghost Lantern\*\*, .*; 1 messages saved \(the site gives no count\)\./);
  assert.match(files["lamp TALK (2).md"],/^# lamp TALK\n\nBots conversation with \*\*Unknown character\*\*/);
});

test("names: case-blind collisions get (2), INDEX and CARDS are never overwritten, unsafe characters become -", () => {
  const names = planned().files.map((f) => f.name);
  // "lamp TALK" collides with "Lamp talk" only on a case-blind disk: it still gets (2)
  assert.ok(names.includes("Lamp talk.md") && names.includes("lamp TALK (2).md"), names.join(", "));
  assert.ok(names.includes("index (2).md"));
  assert.ok(names.includes("Why- -maybe- -so- -really-.md"));
  assert.equal(names.filter((n) => n === "INDEX.md").length, 1);
  assert.equal(names.length, 6 + 2); // conv-5 is empty: left out
});

test("INDEX lists conversations oldest first, pipes escaped; stats count the skips", () => {
  const { files, stats } = planned();
  const index = byName(files)["INDEX.md"].split("\n");
  assert.equal(index[0], "# Character chat conversations");
  assert.equal(index[2], "Built by `leket convert character-chat` from `export.json`. Oldest first.");
  assert.deepEqual(index.slice(6, -1), [
    "| `Ghost Lantern 2024-03-04.md` | Ghost Lantern | 1 | 2024-03-04 | 2024-03-04 |",
    "| `Lamp talk.md` | Moth Keeper | 3 | 2024-03-05 | 2024-03-05 |",
    "| `lamp TALK (2).md` | Unknown character | 1 | 2024-03-05 | 2024-03-05 |",
    "| `index (2).md` | Moth Keeper | 1 | 2024-03-05 | 2024-03-05 |",
    "| `Why- -maybe- -so- -really-.md` | Moth Keeper | 1 | 2024-03-05 | 2024-03-05 |",
    "| `Gear - Smith 2024-03-06.md` | Gear \\| Smith | 2 | 2024-03-06 | 2024-03-06 |",
  ]);
  assert.deepEqual(stats, { conversations: 6, messages: 9, empty: 1, short: 1, cards: 3, missing: 1 });
});

test("CARDS: by name, nameless cards left out, empty fields skipped, no creator no '(by …)'", () => {
  assert.equal(byName(planned().files)["CARDS.md"], [
    "# Character cards as Character chat served them", "",
    "## Aardvark Oracle (by inventor)", "", "`ch-aard` · ", "",
    "## Gear | Smith", "", "`ch-gear` · ", "", "**greeting:**", "", "Clank.", "",
    "## Moth Keeper (by inventor)", "", "`ch-moth` · keeps moths", "",
    "**persona:**", "", "Quiet. Likes lamps.", "", "**scenario:**", "", "A lighthouse.", "", "**greeting:**", "", "Hello, traveller.", "",
  ].join("\n"));
});

test("several exports: the copy with more messages wins, a card beats an error stub", () => {
  const fuller = exportData();
  const shorter = exportData();
  shorter.conversations[0].messages = shorter.conversations[0].messages.slice(0, 1);
  shorter.characters["ch-moth"] = { error: "failed" };
  for (const order of [[fuller, shorter], [shorter, fuller]]) {
    const c = collect(order.map((d, i) => exportOf(d, `e${i}.json`)));
    assert.equal(c.conversations.find((x) => x.id === "conv-1").c.messages.length, 3);
    assert.equal(c.characters["ch-moth"].name, "Moth Keeper");
  }
});

test("a character id '__proto__' is an ordinary key", () => {
  const d = exportData();
  d.characters = JSON.parse('{"__proto__": {"name": "Proto Bot"}}');
  d.conversations = [{ id: "p", character_id: "__proto__", meta: {}, messages: [msg("p1", "user", "hi", T0)] }];
  const r = render(collect([exportOf(d)]).conversations[0], collect([exportOf(d)]).characters);
  assert.match(r.text, /\*\*Proto Bot\*\*/);
});

test("minute: zones, and no time for a missing or bad value", () => {
  assert.equal(minute(T0), "2024-03-05 14:03");
  assert.equal(minute(T0, "Asia/Kolkata"), "2024-03-05 19:33");
  assert.equal(minute(undefined), "");
  assert.equal(minute(1e20), "");
  assert.equal(minute("2024"), "");
});

test("collect refuses what isn't an export", () => {
  assert.throws(() => collect([{ label: "x.json", data: [] }]), /x\.json: not a character-chat export/);
  assert.throws(() => collect([{ label: "x.json", data: { conversations: [{ messages: [] }] } }]), /conversation 1 has no id/);
  assert.throws(() => collect([{ label: "x.json", data: { conversations: [{ id: "a" }] } }]), /"a" has no messages list|a has no messages list/);
});

test("CLI: writes every file and says what it skipped", () => {
  const dir = tmp();
  const src = join(dir, "export.json");
  writeFileSync(src, JSON.stringify(exportData()));
  const out = join(dir, "out");
  const r = leket(["convert", "character-chat", src, "--out", out, "--tz", "America/New_York"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(out).length, 8);
  assert.match(r.stderr, /6 conversations, 9 messages, 3 cards, from 1 export\(s\); times in America\/New_York\./);
  assert.match(r.stderr, /no messages, left out: 1\./);
  assert.match(r.stderr, /fewer messages than the site counts: 1\./);
  assert.match(r.stderr, /no card in the export .*: 1\./);
  assert.match(readFileSync(join(out, "Lamp talk.md"), "utf8"), /^# Lamp talk\n/);
});

test("CLI: usage errors exit 2, an unreadable export exits 1 with nothing written", () => {
  const dir = tmp();
  const src = join(dir, "export.json");
  writeFileSync(src, JSON.stringify(exportData()));
  assert.equal(leket(["convert", "character-chat"]).status, 2);
  assert.equal(leket(["convert", "character-chat", src, "--assistant", "X"]).status, 2);
  assert.equal(leket(["convert", "character-chat", src, "--tz", "Mars/Olympus"]).status, 2);
  assert.equal(leket(["convert", "character-chat", src, "--site", " "]).status, 2);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  const out = join(dir, "out");
  const r = leket(["convert", "character-chat", src, bad, "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.json isn't JSON .*; nothing written\./);
  assert.throws(() => readdirSync(out), /ENOENT/);
  assert.match(leket(["convert", "character-chat", "--help"]).stdout, /convert character-chat <export\.json>/);
});
