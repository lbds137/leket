// `leket convert claude-code`: src/convert/claude-code.js turns transcript lines into turns
// and Markdown, bin/leket.js reads the .jsonl files and writes. Every record below is
// synthetic, shaped on Claude Code's transcript records (field names and nesting as it
// writes them). On real transcripts the port matched the private converter it replaces
// turn for turn, apart from the deliberate differences the module's header names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { minute, plan, render, titleOf, turns } from "../src/convert/claude-code.js";
import { readClaudeCodeSessions } from "../bin/leket.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-claude-code-"));

// Record builders. at(n): n minutes after the fixture's start, 14:00 UTC (09:00 in New York).
const at = (n) => new Date(Date.UTC(2024, 2, 5, 14, n)).toISOString();
const base = (n, extra = {}) => ({ isSidechain: false, sessionId: "sess-0001-aaaa", timestamp: at(n), uuid: `u${n}`, ...extra });
const prompt = (n, content, origin = "human") => ({ ...base(n), type: "user", turnOrigin: origin, message: { role: "user", content } });
const reply = (n, ...blocks) => ({ ...base(n), type: "assistant", message: { role: "assistant", content: blocks } });
const text = (t) => ({ type: "text", text: t });
const tool = (id, name = "Bash", input = { command: "ls" }) => ({ type: "tool_use", id, name, input });
const result = (n, id, content, extra = {}) => ({ ...base(n), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra });
const ask = (id, questions) => tool(id, "AskUserQuestion", { questions });

const run = (records) => {
  const t = turns();
  for (const r of records) t.feed(typeof r === "string" ? r : JSON.stringify(r));
  return t.end();
};
const shape = (s) => s.turns.map((t) => [t.role, t.text]);

test("a reply's text is kept only after its last tool call, joined, with the first kept block's time", () => {
  const s = run([
    prompt(0, "Count the files?"),
    reply(1, text("Let me look."), tool("t1")), // shown before a tool call: dropped
    result(2, "t1", "a\nb"),
    reply(3, text("Two files.")),
    reply(4, text("  Both are text.  ")),
  ]);
  assert.deepEqual(shape(s), [["user", "Count the files?"], ["assistant", "Two files.\n\nBoth are text."]]);
  assert.equal(s.turns[1].at, at(3));
});

test("a tool call in a later record drops the text before it", () => {
  const s = run([prompt(0, "Go"), reply(1, text("Thinking aloud")), reply(2, tool("t1")), result(3, "t1", "x"), reply(4, text("Done."))]);
  assert.deepEqual(shape(s), [["user", "Go"], ["assistant", "Done."]]);
});

test("AskUserQuestion: the text before it, the question and options, then the answers", () => {
  const s = run([
    prompt(0, "Pick for me"),
    reply(1, text("Two ways to go."), ask("q1", [{ question: "Which colour?", options: [{ label: "Blue", description: "calm" }, { label: "Red" }] }])),
    result(2, "q1", "User has answered", { toolUseResult: { questions: [], answers: { "Which colour?": "Blue" } } }),
    reply(3, ask("q2", [{ question: "Which shapes?", multiSelect: true, options: [{ label: "Square", description: "" }] }])),
    result(4, "q2", "x", { toolUseResult: { answers: { "Which shapes?": ["Square", "Circle"] } } }),
    reply(5, ask("q3", [{ question: "Proceed?", options: [] }])),
    result(6, "q3", "The user declined to answer", { toolUseResult: "Error: declined" }), // no answers: the tool's text
    reply(7, text("Blue it is.")),
  ]);
  assert.deepEqual(shape(s), [
    ["user", "Pick for me"],
    ["assistant", "Two ways to go.\n\n**Question:** Which colour?\n\n- Blue: calm\n- Red: "],
    ["user", "*(answering the question)*\n\nWhich colour? → **Blue**"],
    ["assistant", "**Question:** Which shapes?\n\n- Square: "],
    ["user", "*(answering the question)*\n\nWhich shapes? → **Square, Circle**"],
    ["assistant", "**Question:** Proceed?\n\n"],
    ["user", "*(answering the question)*\n\nThe user declined to answer"],
    ["assistant", "Blue it is."],
  ]);
  assert.deepEqual(s.turns.map((t) => !!t.answer), [false, false, true, false, true, false, true, false]);
});

test("two questions answered in one record: its answers go to the first, the second keeps its own text", () => {
  const s = run([
    prompt(0, "Ask twice"),
    reply(1, ask("q1", [{ question: "A?", options: [] }]), ask("q2", [{ question: "B?", options: [] }])),
    { ...base(2), type: "user", toolUseResult: { answers: { "A?": "yes" } },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "x" }, { type: "tool_result", tool_use_id: "q2", content: "skipped" }] } },
  ]);
  assert.deepEqual(shape(s).filter(([r]) => r === "user").slice(1), [
    ["user", "*(answering the question)*\n\nA? → **yes**"],
    ["user", "*(answering the question)*\n\nskipped"],
  ]);
});

test("plan: a session whose only turn from the person is an answer is kept, untitled", () => {
  const s = run([reply(0, ask("q1", [{ question: "Go?", options: [] }])), result(1, "q1", "x", { toolUseResult: { answers: { "Go?": "yes" } } })]);
  const { files, stats } = plan([{ ...s, id: "sess-0009", source: "s.jsonl" }]);
  assert.deepEqual(files.map((f) => f.name), ["2024-03-05 Untitled session.md"]);
  assert.equal(stats.sessions, 1);
});

test("an answer recorded as blocks is their text; an unrelated tool's output neither shows nor ends the reply", () => {
  const s = run([
    prompt(0, "Ask me"),
    reply(1, ask("q1", [{ question: "Sure?", options: [] }])),
    result(2, "q1", [text("yes"), { type: "image" }, text("really")]),
    reply(3, text("Part one.")),
    result(4, "other", "unrelated output"), // a tool call this reply never made: passed over
    reply(5, text("Part two.")),
  ]);
  assert.deepEqual(shape(s).slice(2), [["user", "*(answering the question)*\n\nyes\n\nreally"], ["assistant", "Part one.\n\nPart two."]]);
});

test("a prompt not typed by the person ends the reply but isn't shown; reminders are stripped", () => {
  const s = run([
    prompt(0, "Start"),
    reply(1, text("Working.")),
    prompt(2, "<task-notification>done</task-notification>", "task_notification"),
    { ...base(3), type: "user", isMeta: true, message: { role: "user", content: "meta" } }, // no turnOrigin
    reply(4, text("Finished.")),
    prompt(5, "<system-reminder>\nnoise\n</system-reminder>\n"), // only a reminder: dropped
    prompt(6, [text("Look <system-reminder>x</system-reminder>  here"), { type: "image", source: {} }, text("and here")]),
  ]);
  assert.deepEqual(shape(s), [["user", "Start"], ["assistant", "Working."], ["assistant", "Finished."], ["user", "Look here\n\nand here"]]);
  assert.equal(s.origins, 4);
});

test("subagents' records, other record types and odd shapes are passed over; a half-written line is counted", () => {
  const s = run([
    { type: "custom-title", customTitle: "Old name", sessionId: "sess-0001-aaaa" },
    prompt(0, "Hi"),
    { ...reply(1, text("Subagent text"), tool("s1")), isSidechain: true }, // neither shown nor clearing
    { ...prompt(2, "Subagent prompt"), isSidechain: true },
    reply(3, text("Hello.")),
    { type: "attachment", timestamp: at(4) },
    { ...base(5), type: "assistant" }, // no message
    { ...base(6), type: "assistant", message: { content: "plain string reply" } },
    reply(7, "not a block", null, text("   ")),
    "",
    "[1, 2]",
    { type: "custom-title", customTitle: "Line\none", sessionId: "sess-0001-aaaa" },
    '{"type":"assistant","message":{"content":[{"type":"te',
  ]);
  assert.deepEqual(shape(s), [["user", "Hi"], ["assistant", "Hello.\n\nplain string reply"]]);
  assert.equal(s.unparsed, 1);
  assert.equal(s.title, "Line\none");
  assert.equal(s.sessionId, "sess-0001-aaaa");
  assert.equal(titleOf(s), "Line one");
});

test("titleOf: the session's name, else the start of its first prompt, cut at a word", () => {
  const long = "Please help me rename every file in the photos folder so the dates sort properly";
  assert.equal(titleOf({ title: "", turns: [{ role: "user", text: `${long}\n\nmore` }] }), "Please help me rename every file in the photos folder so…");
  assert.equal(titleOf({ title: " ", turns: [{ role: "user", text: "Short\none" }] }), "Short one");
  assert.equal(titleOf({ title: "", turns: [{ role: "assistant", text: "x" }] }), "Untitled session");
  // an answer isn't a prompt: the first prompt names the session, even one typed to look
  // like an answer; a session of only answers is untitled
  assert.equal(titleOf({ title: "", turns: [{ role: "user", answer: true, text: "*(answering the question)*\n\nQ → **A**" }, { role: "user", text: "Real start" }] }), "Real start");
  assert.equal(titleOf({ title: "", turns: [{ role: "user", text: "*(answering myself)* ok" }] }), "*(answering myself)* ok");
  assert.equal(titleOf({ title: "", turns: [{ role: "user", answer: true, text: "*(answering the question)*\n\nQ → **A**" }] }), "Untitled session");
  // no space past the 30th character: cut at 60 code points, an emoji kept whole
  const smile = String.fromCodePoint(0x1f600);
  assert.equal(titleOf({ title: "", turns: [{ role: "user", text: `${"a".repeat(59)}${smile}b` }] }), `${"a".repeat(59)}${smile}…`);
  // a prompt of only a character JavaScript calls space but Python doesn't: still a title
  assert.equal(titleOf({ title: "", turns: [{ role: "user", text: String.fromCharCode(0xfeff) }] }), String.fromCharCode(0xfeff));
  assert.equal(titleOf({ title: "", turns: [{ role: "user", text: String.fromCharCode(0x3000) }] }), "Untitled session");
});

test("render: heading, span, labels and times in the zone given", () => {
  const s = { ...run([prompt(0, "Is it *on*?"), reply(2, text("It is."))]), id: "sess-0001-aaaa", source: "dir/sess.jsonl" };
  assert.equal(render(s, { user: "Wren", assistant: "Helper", timeZone: "America/New_York" }), [
    "# Is it \\*on\\*?",
    "",
    "Claude Code session `sess-0001-aaaa`, 2024-03-05 09:00 to 2024-03-05 09:02; 2 messages. Source: `dir/sess.jsonl`.",
    "",
    "## Wren · 2024-03-05 09:00", "", "Is it *on*?", "",
    "## Helper · 2024-03-05 09:02", "", "It is.", "",
  ].join("\n"));
  assert.equal(minute("not a time"), "");
  // a session name with a line break and a trailing #, and labels with markup, each stay on one heading line
  const named = { ...s, title: "Fix\n# the build #" };
  const r = render(named, { user: "*me*", assistant: "C#", timeZone: "UTC" });
  assert.match(r, /^# Fix # the build \\#\n/);
  assert.match(r, /\n## \\\*me\\\* · 2024-03-05 14:00\n/);
  assert.match(r, /\n## C# · 2024-03-05 14:02\n/);
});

test("plan: oldest first, clashing names told apart by the session id, empty sessions counted by kind", () => {
  const sess = (id, n, records) => ({ ...run(records), id, source: `${id}.jsonl` });
  const p = plan([
    sess("bbbbbbbb-2", 10, [prompt(10, "Same title")]),
    sess("aaaaaaaa-1", 5, [prompt(5, "Same title")]),
    sess("bbbbbbbb-9", 20, [prompt(20, "SAME TITLE")]), // a case-blind clash, the same id start
    // a scheduled run's reply alone is left out, as is an old transcript's
    sess("cccccccc-3", 0, [prompt(0, "Run nightly", "scheduled"), reply(1, text("ok"))]),
    sess("dddddddd-4", 0, [prompt(0, "Nightly", "scheduled")]),
    sess("eeeeeeee-5", 0, [{ ...base(0), type: "user", message: { content: "old format" } }, reply(1, text("answer"))]),
  ], { timeZone: "UTC" });
  assert.deepEqual(p.files.map((f) => f.name), [
    "2024-03-05 Same title.md", "2024-03-05 Same title (bbbbbbbb).md", "2024-03-05 SAME TITLE (bbbbbbbb 2).md",
  ]);
  assert.deepEqual(p.stats, { sessions: 3, turns: 3, noPrompt: 2, noOrigin: 1, unparsed: 0 });
  const j = plan([sess("aaaaaaaa-1", 5, [prompt(5, "Hi")])], { json: true });
  assert.equal(j.files[0].name, "2024-03-05 Hi.json");
  assert.deepEqual(JSON.parse(j.files[0].text), { id: "aaaaaaaa-1", source: "aaaaaaaa-1.jsonl", title: "Hi", turns: [{ at: at(5), role: "user", text: "Hi" }] });
});

const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

test("CLI: a folder's top-level transcripts become one file each; the summary names what was left out", () => {
  const d = tmp(), src = join(d, "project"), out = join(d, "out");
  mkdirSync(join(src, "sess-0001-aaaa", "subagents"), { recursive: true });
  writeFileSync(join(src, "sess-0001-aaaa.jsonl"), jsonl([prompt(0, "Hello there"), reply(1, text("Hi."))]) + '{"half');
  writeFileSync(join(src, "sess-0002-bbbb.jsonl"), jsonl([prompt(0, "Nightly", "scheduled")]));
  writeFileSync(join(src, "sess-0001-aaaa", "subagents", "agent-1.jsonl"), jsonl([prompt(0, "Not read")]));
  writeFileSync(join(src, "notes.txt"), "not a transcript");
  const r = leket(["convert", "claude-code", src, "--out", out, "--tz", "America/New_York"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out), ["2024-03-05 Hello there.md"]);
  assert.match(readFileSync(join(out, "2024-03-05 Hello there.md"), "utf8"), /^# Hello there\n\nClaude Code session `sess-0001-aaaa`, 2024-03-05 09:00 to 2024-03-05 09:01; 2 messages\./);
  assert.match(r.stderr, /1 sessions, 2 messages; times in America\/New_York\./);
  assert.match(r.stderr, /no prompt typed by a person.*: 1\./);
  assert.match(r.stderr, /Lines that aren't JSON.*: 1\./);
  const j = leket(["convert", "claude-code", join(src, "sess-0001-aaaa.jsonl"), "--out", out, "--json"]);
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, "2024-03-05 Hello there.json"), "utf8")).turns.length, 2);
  // a transcript given both itself and in its folder is read once
  const twice = leket(["convert", "claude-code", join(src, "sess-0001-aaaa.jsonl"), src, "--out", join(d, "twice")]);
  assert.equal(twice.status, 0, twice.stderr);
  assert.deepEqual(readdirSync(join(d, "twice")), ["2024-03-05 Hello there.md"]);
  assert.match(twice.stderr, /1 sessions, 2 messages/);
});

test("reader: lines end at \\n only, a CRLF's \\r goes, and the file name is the id when no record has one", async () => {
  const d = tmp(), f = join(d, "named-by-file.jsonl");
  const ls = String.fromCharCode(0x2028), ps = String.fromCharCode(0x2029);
  const { sessionId, ...noId } = prompt(0, `one${ls}two${ps}three`);
  writeFileSync(f, `${JSON.stringify({ ...noId, sessionId: "  " })}\r\n${JSON.stringify(reply(1, text("ok")))}`);
  const [s] = await readClaudeCodeSessions([f]);
  assert.deepEqual(shape(s), [["user", `one${ls}two${ps}three`], ["assistant", "ok"]]);
  assert.equal(s.unparsed, 0);
  // the blank id is passed over; the reply's record names the session
  assert.equal(s.id, sessionId);
  writeFileSync(f, JSON.stringify(noId));
  assert.equal((await readClaudeCodeSessions([f]))[0].id, "named-by-file");
});

test("CLI: usage errors exit 2; a missing transcript or an empty folder exits 1 with nothing written", () => {
  const d = tmp();
  assert.equal(leket(["convert", "claude-code"]).status, 2);
  assert.equal(leket(["convert", "claude-code", d, "--tz", "Nowhere/Else"]).status, 2);
  assert.equal(leket(["convert", "claude-code", d, "--user", "two\nlines"]).status, 2);
  const missing = leket(["convert", "claude-code", join(d, "nope.jsonl"), "--out", join(d, "out")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /nothing written/);
  const empty = leket(["convert", "claude-code", d]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /holds no \.jsonl transcript; nothing written/);
});
