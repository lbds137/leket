// `leket convert aim`: src/convert/aim.js parses and renders, bin/leket.js reads the files
// and writes. The fixture is synthetic (invented screen names): two folders, one contact
// under two screen names, holding the shapes the real logs carry: a single-digit day written
// with two spaces, entities, a link with a quoted HREF and one unquoted with a closing
// slash, a message over several lines (<br> and <BR>, lines that would start a list),
// bold, an auto-response, a buddy alias, a screen name written with other case and spaces,
// and a session that runs past midnight. On a real archive of 364 logs the port kept every
// message the original converter kept, with the same letters and digits, plus the 8 it
// dropped (messages over several lines) and the 15 auto-responses it dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, plan, screenKey } from "../src/convert/aim.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const DIR = join(here, "fixtures", "convert-aim");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-aim-"));
const head = (day = "Thursday, August  2, 2007 at 23:58:10", owner = "lantern9", contact = "pixel42") =>
  `<!doctype html><meta charset="utf-8"/><h1>Chatlog between <span class="sender">${owner}</span> and <span class="receiver">${contact}</span> on <span title="x">${day}</span></h1>\n`;
const recv = (t, who, html) => `<span class='ImReceive'>[${t}] ${who}</span>: ${html}<br/>\n`;
const sent = (t, who, html) => `<span class='ImSend'>[${t}] ${who}</span>: ${html}<br/>\n`;
const one = (text, opts = {}) => plan([{ folder: "pixel42", file: "a.html", text }], opts).files[0].text;
const body = (md) => md.split("\n").slice(5).join("\n"); // past the heading, source and summary

test("the fixture renders as expected.md; senders counted as written", () => {
  const inputs = ["pixel42", "pixelalt"].flatMap((folder) => readdirSync(join(DIR, folder))
    .map((file) => ({ folder, file, text: readFileSync(join(DIR, folder, file), "utf8") })));
  const { files, stats } = plan(inputs, { base: "expected", me: "Jo", names: { pixel42: "Pat", pixelalt: "Pat" } });
  assert.equal(files[0].name, "expected.md");
  assert.equal(files[0].text, readFileSync(join(DIR, "expected.md"), "utf8"));
  assert.deepEqual({ ...stats, senders: { ...stats.senders }, unknown: { ...stats.unknown } },
    { logs: 2, messages: 7, autos: 1, stray: 0, unknown: {}, senders: { lantern9: 3, pixel42: 1, "Pixel 42": 1, Pix: 1, pixelalt: 1 } });
});

test("a message runs to the next entry: <br> lines stay its lines, the closing <br/> goes", () => {
  const { entries } = parse(head() + recv("23:58", "pixel42", "a<br>\nb<BR>").replace("<br/>\n", "\n<br/>\n") + sent("23:59", "lantern9", "c"));
  assert.deepEqual(entries.map((e) => e.html), ["a<br>\nb<BR>", "c"]);
  assert.equal(body(one(head() + recv("23:58", "pixel42", "a<br>\nb"))), "## 2007-08-02 (Thu)\n\n> -# pixel42 — Aug 2 2007 11:58 PM\n> a\\\n> b\n>\n");
});

test("the date moves on when the clock goes back, not within the start's own minute", () => {
  const { entries } = parse(head() + recv("23:58", "pixel42", "x") + recv("23:59", "pixel42", "y") + recv("00:01", "pixel42", "z") + recv("23:00", "pixel42", "w"));
  assert.deepEqual(entries.map((e) => new Date(e.ms).toISOString().slice(0, 16)),
    ["2007-08-02T23:58", "2007-08-02T23:59", "2007-08-03T00:01", "2007-08-03T23:00"]);
});

test("an auto-response is kept and marked; under the owner's name it is the owner's", () => {
  const log = head() + "[23:59] lantern9 (auto-response from lantern9) away<br/>\n[23:59] pixel42 (Auto-response from pixel42) out<br/>\n";
  const { entries } = parse(log);
  assert.deepEqual(entries.map(({ who, sent, auto }) => [who, sent, auto]), [["lantern9", true, true], ["pixel42", false, true]]);
  assert.match(one(log, { me: "Jo" }), /^> -# Jo — Aug 2 2007 11:59 PM \(auto-response\)\n> away$/m);
});

test("labels: --me for the owner's side, --name by screen name ignoring case and spaces, else as written", () => {
  assert.equal(screenKey(" Pixel 42 "), "pixel42");
  const md = one(head() + recv("23:58", "Pixel 42", "a") + recv("23:58", "Pix", "b") + sent("23:59", "Lantern 9", "c"),
    { me: "Jo", names: { pixel42: "Pat", lantern9: "not used: --me wins" } });
  assert.deepEqual(md.match(/^> -# \S+/gm), ["> -# Pat", "> -# Pix", "> -# Jo"]);
  assert.match(one(head() + recv("23:58", "&lt;b&gt;x", "a")), /^> -# \\<b>x —/m, "a name's entities are decoded and its < escaped");
});

test("text is HTML: entities decoded, links and bold as Markdown, Markdown's characters escaped", () => {
  const md = body(one(head() + recv("23:58", "pixel42", "&quot;q&quot; *s* 1 &lt; 2 <A HREF=\"http://x.example/?a=1&amp;b\">site</A> <B>bold</B>")));
  assert.equal(md.split("\n")[3], "> \"q\" \\*s\\* 1 \\< 2 [site](http://x.example/?a=1&b) **bold**");
});

test("a log without the heading, or with a date or time that doesn't exist, stops the plan, naming it", () => {
  assert.throws(() => plan([{ folder: "f", file: "a.html", text: "<p>hi</p>" }]), /^Error: f\/a\.html: no "Chatlog between/);
  assert.throws(() => plan([{ folder: "f", file: "a.html", text: head("Friday, February 30, 2007 at 10:00:00") + recv("10:00", "x", "y") }]),
    /f\/a\.html: can't read the heading's date "February 30, 2007 at 10:00:00"/);
  assert.throws(() => plan([{ folder: "f", file: "a.html", text: head() + recv("24:00", "x", "y") }]), /can't read the time "24:00"/);
  assert.throws(() => plan([{ folder: "f", file: "a.html", text: head() }]), /a\.html holds no message/);
  assert.throws(() => plan([{ file: "a.html", text: head() }, { file: "b.html", text: head() }]), /the 2 logs given hold no message/);
});

test("logs are put in order of their start, whatever order they come in; title and base follow the contacts", () => {
  const late = head("Friday, August  3, 2007 at 12:00:00", "lantern9", "Pixel Alt") + recv("12:00", "Pixel Alt", "late");
  const early = head() + recv("23:58", "pixel42", "early");
  const { files } = plan([{ folder: "b", file: "2.html", text: late }, { folder: "a", file: "1.html", text: early }]);
  assert.equal(files[0].name, "aim-pixel42+Pixel Alt.md");
  assert.match(files[0].text, /^# AIM with pixel42, Pixel Alt\n\nSource: 2 AIM chat logs saved as HTML, from `a`, `b`\./);
  assert.ok(files[0].text.indexOf("early") < files[0].text.indexOf("late"));
});

test("cli: folders merge into one transcript; senders on stderr; --tz names the zone", () => {
  const out = tmp();
  const r = leket(["convert", "aim", join(DIR, "pixel42"), join(DIR, "pixelalt"), "--out", out, "--me", "Jo",
    "--name", "PIXEL 42=Pat", "--name", "pixelalt=Pat", "--tz", "America/Los_Angeles"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out), ["aim-pixel42+pixelalt.md"]);
  assert.match(r.stderr, /2 logs, 7 messages \(1 auto-response\); times as logged \(America\/Los_Angeles\)\.\nleket: senders: lantern9 \(3\), /);
  const md = readFileSync(join(out, "aim-pixel42+pixelalt.md"), "utf8");
  assert.match(md, /Times are as logged, in America\/Los_Angeles\./);
  assert.equal(md.replace(/, in America\/Los_Angeles/, " (the logging computer's local time, with no zone)"),
    readFileSync(join(DIR, "expected.md"), "utf8")
      .replace(/^# .*/, "# AIM with pixel42, pixelalt")
      .replace("`pixel42`, `pixelalt`", `\`${join(DIR, "pixel42")}\`, \`${join(DIR, "pixelalt")}\``));
});

test("cli: a loose log has no 'from' folder in Source and singularizes 1 log on stderr", () => {
  const dir = tmp(), out = tmp();
  const loose = join(dir, "one.html");
  writeFileSync(loose, `${head()}stray<br/>\n${recv("23:58", "pixel42", "hi")}`);
  const r = leket(["convert", "aim", loose, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^leket: 1 log, 1 messages \(0 auto-responses\); times as logged\.\n/);
  assert.match(r.stderr, /leket: 1 log has text before its first message, not shown\./);
  const md = readFileSync(join(out, "aim-pixel42.md"), "utf8");
  assert.match(md, /^Source: 1 AIM chat logs saved as HTML\.$/m);
});

test("dates before 1970 parse and render; years under 1000 throw; equal start times keep input order; unsafe contact names are escaped and sanitised", () => {
  const pre70 = one(head("Sunday, July 20, 1969 at 20:17:40") + recv("20:17", "pixel42", "landed"));
  assert.match(pre70, /1 messages, 1969-07-20 to 1969-07-20\./);
  assert.match(pre70, /## 1969-07-20 \(Sun\)\n\n> -# pixel42 — Jul 20 1969 8:17 PM\n> landed\n>/);
  assert.throws(() => parse(head("Sunday, July 20, 0999 at 20:17:40") + recv("20:17", "pixel42", "old")),
    /can't read the heading's date "July 20, 0999 at 20:17:40"/);
  const a = head("Thursday, August  2, 2007 at 12:00:00") + recv("12:00", "pixel42", "first");
  const b = head("Thursday, August  2, 2007 at 12:00:00") + recv("12:00", "pixel42", "second");
  const sameStart = plan([{ folder: "a", file: "1.html", text: a }, { folder: "b", file: "2.html", text: b }]).files[0].text;
  assert.ok(sameStart.indexOf("first") < sameStart.indexOf("second"));
  const unsafe = plan([{ folder: "f", file: "a.html", text: head("Thursday, August  2, 2007 at 12:00:00", "lantern9", "&lt;b&gt;&amp;c;?*") + recv("12:00", "&lt;b&gt;&amp;c;?*", "hi") }]);
  assert.equal(unsafe.files[0].name, "aim--b-&c;--.md");
  assert.match(unsafe.files[0].text, /^> -# \\<b>\\&c;\?\* — Aug 2 2007 12:00 PM$/m);
});

test("cli: usage errors exit 2; an unreadable log exits 1 with nothing written", () => {
  for (const args of [["--name", "x"], ["--name", "=x"], ["--name", "a="], ["--me", " "], ["--base", "a/b"], ["--tz", "Nowhere/Else"], ["--bogus"]]) {
    const r = leket(["convert", "aim", DIR, ...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  const bad = tmp(), out = tmp();
  writeFileSync(join(bad, "x.html"), "<p>not a log</p>");
  const r = leket(["convert", "aim", bad, "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /x\.html: no "Chatlog between … and …" heading .*; nothing written\./);
  assert.deepEqual(readdirSync(out), []);
});

test("review lows: an auto-response name holding ')'; \\r\\n; text before the first entry; a -# line; __proto__", () => {
  const { entries } = parse(head() + "[23:59] Pat (away) (auto-response from Pat (away)) out<br/>\n");
  assert.deepEqual([entries[0].who, entries[0].html], ["Pat (away)", "out"]);
  const crlf = parse((head() + recv("23:58", "pixel42", "a<br>\nb")).replace(/\n/g, "\r\n"));
  assert.deepEqual(crlf.entries.map((e) => e.html), ["a<br>\r\nb"]);
  const r = plan([{ folder: "f", file: "a.html", text: `${head()}stray<br/>\n${recv("23:58", "__proto__", "-# not a header<br>\n# nor this<font>x</font>")}` }]);
  assert.equal(r.stats.stray, 1);
  assert.deepEqual(Object.entries(r.stats.senders), [["__proto__", 1]]);
  assert.deepEqual({ ...r.stats.unknown }, { font: 1 });
  assert.match(r.files[0].text, /^> -# __proto__ — .*\n> \\-# not a header\\\n> \\# nor thisx$/m);
});
