// `leket convert google-voice`: src/convert/google-voice.js classifies, deduplicates and
// renders Google Voice Takeout HTML files, bin/leket.js reads the files and writes. The
// fixture is synthetic (invented names and 555-01xx numbers): one main contact with a
// Hebrew-named text file, a tag-only text file carrying a rollover duplicate, a placed call
// with duration, and a voicemail with duration and machine transcript, plus an English-named
// text file for a second contact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contactOf, kindOf, plan } from "../src/convert/google-voice.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const DIR = join(here, "fixtures", "convert-google-voice");
const CALLS = join(DIR, "calls");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-gv-"));
const body = (md) => md.split("\n").slice(5).join("\n");

const msg = (dt, who, q, span = false) =>
  `<div class="message"><abbr class="dt" title="${dt}">t</abbr><cite class="sender vcard">`
  + (span ? `<span class="fn">${who}</span>` : `<abbr class="fn" title="">${who}</abbr>`)
  + `</cite>: <q>${q}</q></div>\n`;
const callHtml = ({ dt, dur = "", vm = "", tag = "" }) =>
  `<div class="haudio">`
  + (dt !== undefined ? `<abbr class="published" title="${dt}">t</abbr>` : "")
  + (dur ? `<abbr class="duration" title="PT${dur}">d</abbr>` : "")
  + (vm ? `<span class="full-text">${vm}</span>` : "")
  + (tag ? `<a href="http://www.google.com/voice#${tag}">tag</a>` : "")
  + `</div>\n`;

test("the fixture renders main contact as expected.md and writes one transcript per contact", () => {
  const inputs = readdirSync(CALLS).sort().map((file) => ({
    folder: "calls", file, text: readFileSync(join(CALLS, file), "utf8"),
  }));
  const { files, stats } = plan(inputs, { me: "Jo", names: { "Sam Rivera": "Sam" }, timeZone: "America/New_York" });
  assert.deepEqual(files.map((f) => f.name), ["google-voice-Sam.md", "google-voice-Alex Chen.md"]);
  assert.equal(files[0].text, readFileSync(join(DIR, "expected.md"), "utf8"));
  assert.deepEqual({ ...stats, senders: { ...stats.senders } }, {
    files: 5, contacts: 2, texts: 5, calls: 1, voicemails: 1,
    undated: 0, unknownKinds: [], notExports: 0,
    senders: { "Sam Rivera": 2, "אני": 1, "Alex Chen": 1, Me: 1 },
  });
});

test("contact split: Hebrew, English, tag-only, contact holding ' - ', missing timestamp or empty contact", () => {
  assert.equal(contactOf("Sam Rivera - שלח הודעת טקסט - 2020-01-15T19_30_00Z.html"), "Sam Rivera");
  assert.equal(contactOf("Sam Rivera - Placed call - 2020-01-15T19_30_00+05_00.html"), "Sam Rivera");
  assert.equal(contactOf("Sam Rivera - 2020-01-15T19_30_00_123Z.html"), "Sam Rivera");
  assert.equal(contactOf("Sam - Work - Placed call - 2020-01-15T19_30_00Z.html"), "Sam - Work");
  assert.equal(contactOf("Sam - Work - 2020-01-15T19_30_00Z.html"), "Sam - Work");
  assert.equal(contactOf("notes.html"), null);
  assert.equal(contactOf("Sam Rivera - Placed call.html"), null);
  assert.equal(contactOf("Placed call - 2020-01-15T19_30_00Z.html"), null);
  assert.equal(contactOf(" - 2020-01-15T19_30_00Z.html"), null);

  const { files, stats } = plan([
    { file: "Sam - Work - Placed call - 2020-01-15T19_30_00Z.html", text: callHtml({ dt: "2020-01-15T19:30:00Z", dur: "10S" }) },
    { file: "notes.html", text: "<p>ignore</p>" },
    { file: "Placed call - 2020-01-15T19_30_00Z.html", text: callHtml({ dt: "2020-01-15T19:30:00Z" }) },
    { file: " - 2020-01-15T19_30_00Z.html", text: callHtml({ dt: "2020-01-15T19:30:00Z", tag: "placed" }) },
  ]);
  assert.deepEqual(files.map((f) => f.name), ["google-voice-Sam - Work.md"]);
  assert.equal(stats.notExports, 3);
});

test("kinds: every Hebrew word, every English word, every tag link, and an unknown kind with no tag", () => {
  const cases = [
    ["Pat - שלח הודעת טקסט - 2020-01-15T10_00_00Z.html", "", "text"],
    ["Pat - בוצעה - 2020-01-15T10_00_00Z.html", "", "placed"],
    ["Pat - התקבלה - 2020-01-15T10_00_00Z.html", "", "received"],
    ["Pat - שלא נענתה - 2020-01-15T10_00_00Z.html", "", "missed"],
    ["Pat - דואר קולי - 2020-01-15T10_00_00Z.html", "", "voicemail"],
    ["Pat - Text conversation - 2020-01-15T10_00_00Z.html", "", "text"],
    ["Pat - Placed call - 2020-01-15T10_00_00Z.html", "", "placed"],
    ["Pat - Received call - 2020-01-15T10_00_00Z.html", "", "received"],
    ["Pat - Missed call - 2020-01-15T10_00_00Z.html", "", "missed"],
    ["Pat - Voicemail - 2020-01-15T10_00_00Z.html", "", "voicemail"],
    ["Pat - 2020-01-15T10_00_00Z.html", '<a href="http://www.google.com/voice#sms">', "text"],
    ["Pat - 2020-01-15T10_00_00Z.html", '<a href="http://www.google.com/voice#placed">', "placed"],
    ["Pat - 2020-01-15T10_00_00Z.html", '<a href="http://www.google.com/voice#received">', "received"],
    ["Pat - 2020-01-15T10_00_00Z.html", '<a href="http://www.google.com/voice#missed">', "missed"],
    ["Pat - 2020-01-15T10_00_00Z.html", '<a href="http://www.google.com/voice#inbox">', "voicemail"],
    ["Pat - 2020-01-15T10_00_00Z.html", '<a href="http://www.google.com/voice#voicemail">', "voicemail"],
    ["Pat - Mystery - 2020-01-15T10_00_00Z.html", "<p>no tag</p>", null],
  ];
  for (const [f, html, expected] of cases) assert.equal(kindOf(f, html), expected, f);

  const { files, stats } = plan([
    { file: "Pat - התקבלה - 2020-01-15T10_00_00Z.html", text: callHtml({ dt: "2020-01-15T10:00:00Z", dur: "45S" }) },
    { file: "Pat - שלא נענתה - 2020-01-15T10_05_00Z.html", text: callHtml({ dt: "2020-01-15T10:05:00Z" }) },
    { file: "Pat - 2020-01-15T10_10_00Z.html", text: callHtml({ dt: "2020-01-15T10:10:00Z", dur: "12S", vm: "from inbox", tag: "inbox" }) },
    { file: "Pat - Unknown - 2020-01-15T10_15_00Z.html", text: "<p>no tag</p>" },
  ], { me: "Jo" });
  assert.deepEqual(stats.unknownKinds, ["Pat - Unknown - 2020-01-15T10_15_00Z.html"]);
  assert.equal(stats.calls, 2);
  assert.equal(stats.voicemails, 1);
  assert.match(files[0].text, /> call answered by Jo \(45s\)\n>\n> -# \(call\) — Jan 15 2020 10:05 AM\n> missed call\n>\n> -# \(call\) — Jan 15 2020 10:10 AM\n> voicemail \(12s\): from inbox/);
});

test("messages and calls: abbr/span fn, Me/אני, <br> lines, entities, escaping, undated rows skipped, dedup", () => {
  const f1 = "Pat - Text conversation - 2020-01-15T10_00_00Z.html";
  const f2 = "Pat - Text conversation - 2020-01-15T10_01_00Z.html";
  const t1 = msg("2020-01-15T10:00:00Z", "Pat", "line 1<br>\n# line 2 &amp; *more* <b>bold</b>", false)
    + msg("2020-01-15T10:01:00Z", "Me", "from Me", true)
    + msg("2020-01-15T10:02:00Z", " &#x5d0;&#x5e0;&#x5d9; ", "from Hebrew Me", false)
    + msg("not-a-date", "Pat", "dropped", false);
  const t2 = msg("2020-01-15T10:01:00Z", "Me", "from Me", true); // rollover duplicate
  const c1 = { file: "Pat - Placed call - 2020-01-15T10_03_00Z.html", text: callHtml({ dt: "2020-01-15T10:03:00Z", dur: "1H2M3S" }) };
  const c2 = { file: "Pat - Placed call - 2020-01-15T10_03_01Z.html", text: callHtml({ dt: "2020-01-15T10:03:00Z", dur: "1H2M3S" }) }; // duplicate call
  const cUndated = { file: "Pat - Missed call - 2020-01-15T10_04_00Z.html", text: callHtml({}) };

  const { files, stats } = plan([{ file: f1, text: t1 }, { file: f2, text: t2 }, c1, c2, cUndated], { me: "Robin" });
  assert.equal(stats.texts, 3);
  assert.equal(stats.calls, 1);
  assert.equal(stats.undated, 2);
  assert.deepEqual({ ...stats.senders }, { Pat: 1, Me: 1, "אני": 1 });
  assert.equal(body(files[0].text), [
    "## 2020-01-15 (Wed)", "",
    "> -# Pat — Jan 15 2020 10:00 AM",
    "> line 1\\",
    "> \\# line 2 & \\*more\\* **bold**", ">",
    "> -# Robin — Jan 15 2020 10:01 AM",
    "> from Me", ">",
    "> -# Robin — Jan 15 2020 10:02 AM",
    "> from Hebrew Me", ">",
    "> -# (call) — Jan 15 2020 10:03 AM",
    "> call placed by Robin (1h2m3s)", ">", "",
  ].join("\n"));
  // a call row's --me label is escaped as the text rows' labels are
  const callMd = plan([{ file: c1.file, text: c1.text }], { me: "<Jo>&Co" }).files[0].text;
  assert.match(callMd, /^> call placed by \\<Jo\>&Co \(1h2m3s\)$/m);
});

test("--tz: same instant from -05:00 and Z stamps, and day heading shifts across zones", () => {
  const inputs = [
    { file: "Pat - Text conversation - 2020-01-16T02_00_00Z.html", text: msg("2020-01-15T21:00:00-05:00", "Pat", "offset") + msg("2020-01-16T02:00:00Z", "Me", "zulu") },
  ];
  const utc = plan(inputs, { timeZone: "UTC" }).files[0].text;
  const ny = plan(inputs, { timeZone: "America/New_York" }).files[0].text;
  assert.match(utc, /2020-01-16 to 2020-01-16\. Times are UTC\./);
  assert.match(utc, /## 2020-01-16 \(Thu\)\n\n> -# Me — Jan 16 2020 2:00 AM\n> zulu\n>\n> -# Pat — Jan 16 2020 2:00 AM\n> offset/);
  assert.match(ny, /2020-01-15 to 2020-01-15\. Times are America\/New_York\./);
  assert.match(ny, /## 2020-01-15 \(Wed\)\n\n> -# Me — Jan 15 2020 9:00 PM\n> zulu\n>\n> -# Pat — Jan 15 2020 9:00 PM\n> offset/);
});

test("labels, collision numbering, Source loose/folder variants, --contact, --title and --base", () => {
  const inputs = [
    { folder: "dirA", file: "Sam 1 - Text conversation - 2020-01-15T10_00_00Z.html", text: msg("2020-01-15T10:00:00Z", "Alt Sender", "a") },
    { folder: "", file: "Sam 1 - Placed call - 2020-01-15T10_05_00Z.html", text: callHtml({ dt: "2020-01-15T10:05:00Z" }) },
    { folder: "", file: "Sam 2 - Text conversation - 2020-01-15T11_00_00Z.html", text: msg("2020-01-15T11:00:00Z", "Sam 2", "b") },
  ];
  const both = plan(inputs, { names: { "Sam 1": "Sam", "Sam 2": "sam", "Alt Sender": "Ally" } });
  assert.deepEqual(both.files.map((f) => f.name), ["google-voice-Sam.md", "google-voice-sam (2).md"]);
  assert.match(both.files[0].text, /^Source: 2 Google Voice Takeout files, from `dirA`, 1 loose file\.\n1 text message and 1 call\/voicemail,/m);
  assert.match(both.files[0].text, /> -# Ally — Jan 15 2020 10:00 AM/);
  assert.match(both.files[1].text, /^Source: 1 Google Voice Takeout file\.\n1 text message and 0 calls\/voicemails,/m);

  const filtered = plan(inputs, { contact: "Sam 2", title: "Custom Heading", base: "custom-file" });
  assert.deepEqual(filtered.files.map((f) => f.name), ["custom-file.md"]);
  assert.match(filtered.files[0].text, /^# Custom Heading\n/);
  assert.equal(filtered.stats.files, 1);
  assert.equal(filtered.stats.contacts, 1);

  assert.throws(() => plan(inputs, { contact: "Nobody" }), /^Error: no Google Voice files for the contact "Nobody"$/);
});

test("sort: a call and texts at the same second order by final label ('(call)' first)", () => {
  const inputs = [
    {
      file: "Zoe - Text conversation - 2020-01-15T10_00_00Z.html",
      text: msg("2020-01-15T10:00:00Z", "Zoe", "from zoe") + msg("2020-01-15T10:00:00Z", "Me", "from ada"),
    },
    {
      file: "Zoe - Placed call - 2020-01-15T10_00_00Z.html",
      text: callHtml({ dt: "2020-01-15T10:00:00Z" }),
    },
  ];
  const md = plan(inputs, { me: "Ada" }).files[0].text;
  assert.deepEqual(md.match(/^> -# [^\n]+/gm), [
    "> -# (call) — Jan 15 2020 10:00 AM",
    "> -# Ada — Jan 15 2020 10:00 AM",
    "> -# Zoe — Jan 15 2020 10:00 AM",
  ]);
});

test("an empty conversation is skipped as the original skipped it; no rows anywhere throws, naming a file", () => {
  const written = plan([
    { file: "Sam - Text conversation - 2020-01-15T10_00_00Z.html", text: msg("2020-01-15T10:00:00Z", "Sam", "hi") },
    { file: "Alex - Text conversation - 2020-01-15T10_00_00Z.html", text: "<div>empty</div>" },
  ]);
  assert.deepEqual(written.files.map((f) => f.name), ["google-voice-Sam.md"]);
  assert.equal(written.stats.contacts, 1);
  assert.throws(() => plan([
    { file: "Alex - Text conversation - 2020-01-15T10_00_00Z.html", text: "<div>empty</div>" },
  ]), /^Error: Alex - Text conversation - 2020-01-15T10_00_00Z\.html holds no message$/);
  assert.throws(() => plan([
    { file: "a.html", text: "not an export" },
    { file: "b.html", text: "not an export" },
  ]), /^Error: the 2 files given hold no message$/);
  // an unknown middle word reads as part of the contact (discovery can't anchor a prefix
  // like the original's given name did), so --contact "Pat" misses the file; under the
  // full name it is found, and with every kind unknown it is named in the error
  assert.throws(() => plan([
    { file: "Pat - Mystery - 2020-01-15T10_00_00Z.html", text: "<p>no tag</p>" },
  ], { contact: "Pat" }), /^Error: no Google Voice files for the contact "Pat"$/);
  assert.throws(() => plan([
    { file: "Pat - Mystery - 2020-01-15T10_00_00Z.html", text: "<p>no tag</p>" },
  ], { contact: "Pat - Mystery" }), /^Error: Pat - Mystery - 2020-01-15T10_00_00Z\.html holds no message$/);
  assert.throws(() => plan([
    { file: "Pat - Mystery - 2020-01-15T10_00_00Z.html", text: "<p>no tag</p>" },
    { file: "Pat - Mystery - 2020-01-15T10_01_00Z.html", text: "<p>no tag</p>" },
  ], { contact: "Pat - Mystery" }), /^Error: the 2 files for "Pat - Mystery" hold no message$/);
});

test("CLI: converts the fixture folder, reports unknown kinds / non-exports / undated rows, and validates flags", () => {
  const out = tmp();
  const r = leket(["convert", "google-voice", CALLS, "--out", out, "--me", "Jo",
    "--name", "Sam Rivera=Sam", "--tz", "America/New_York"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["google-voice-Alex Chen.md", "google-voice-Sam.md"]);
  assert.match(r.stderr, /5 files: 5 text messages, 1 call and 1 voicemail; times in America\/New_York\./);
  assert.match(r.stderr, /leket: senders: Sam Rivera \(2\), /);
  const md = readFileSync(join(out, "google-voice-Sam.md"), "utf8");
  assert.equal(md.replace(`\`${CALLS}\``, "`calls`"), readFileSync(join(DIR, "expected.md"), "utf8"));

  // unknown kinds (capped at 5 + …), notExports, and undated rows on stderr
  const mix = tmp(), mixOut = tmp();
  writeFileSync(join(mix, "Pat - Text conversation - 2020-01-15T10_00_00Z.html"),
    msg("2020-01-15T10:00:00Z", "Pat", "ok") + msg("bad-date", "Pat", "skip"));
  writeFileSync(join(mix, "notes.html"), "<p>not gv</p>");
  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(mix, `Pat - Mystery${i} - 2020-01-15T10_0${i}_00Z.html`), "<p>no tag</p>");
  }
  const mr = leket(["convert", "google-voice", mix, "--out", mixOut]);
  assert.equal(mr.status, 0, mr.stderr);
  assert.match(mr.stderr, /1 file: 1 text message, 0 calls and 0 voicemails; times in UTC\./);
  assert.match(mr.stderr, /6 files of an unknown kind, skipped: .*Mystery5.*, …/);
  assert.match(mr.stderr, /1 file in the input is not a Google Voice export file, skipped\./);
  assert.match(mr.stderr, /1 row had no usable time, skipped\./);

  // error exits: 1 when a folder holds no .html; 2 on usage errors
  const emptyDir = tmp();
  const er = leket(["convert", "google-voice", emptyDir, "--out", mixOut]);
  assert.equal(er.status, 1);
  assert.match(er.stderr, /holds no \.html Google Voice export file; nothing written\./);

  for (const [args, pattern] of [
    [["--bogus"], /usage:/],
    [["--title", "T"], /--title goes with --contact/],
    [["--base", "b"], /--base goes with --contact/],
    [["--contact", "Sam Rivera", "--base", "a/b"], /--base takes a file name/],
    [["--name", "Sam"], /--name takes NAME=LABEL/],
    [["--name", "Sam= "], /takes a one-line label/],
    [["--me", " "], /--me takes a one-line label/],
    [["--contact", " "], /--contact takes a one-line label/],
    [["--tz", "Mars/Base"], /unknown time zone/],
  ]) {
    const ur = leket(["convert", "google-voice", CALLS, ...args]);
    assert.equal(ur.status, 2, args.join(" "));
    assert.match(ur.stderr, pattern);
  }
});

test("bare English kind words: contactOf strips each bare word and plan() renders the right kinds", () => {
  const inputs = [
    { file: "Sam Rivera - Text - 2020-01-15T19_30_00Z.html", text: msg("2020-01-15T19:30:00Z", "Sam Rivera", "bare text") },
    { file: "Sam Rivera - Placed - 2020-01-15T19_31_00Z.html", text: callHtml({ dt: "2020-01-15T19:31:00Z", dur: "10S" }) },
    { file: "Sam Rivera - Received - 2020-01-15T19_32_00Z.html", text: callHtml({ dt: "2020-01-15T19:32:00Z", dur: "20S" }) },
    { file: "Sam Rivera - Missed - 2020-01-15T19_33_00Z.html", text: callHtml({ dt: "2020-01-15T19:33:00Z" }) },
    { file: "Sam Rivera - Voicemail - 2020-01-15T19_34_00Z.html", text: callHtml({ dt: "2020-01-15T19:34:00Z", dur: "15S", vm: "bare vm" }) },
  ];
  for (const { file } of inputs) assert.equal(contactOf(file), "Sam Rivera", file);
  const { files, stats } = plan(inputs, { me: "Jo" });
  assert.deepEqual(files.map((f) => f.name), ["google-voice-Sam Rivera.md"]);
  assert.equal(stats.texts, 1);
  assert.equal(stats.calls, 3);
  assert.equal(stats.voicemails, 1);
  assert.equal(body(files[0].text), [
    "## 2020-01-15 (Wed)", "",
    "> -# Sam Rivera — Jan 15 2020 7:30 PM",
    "> bare text", ">",
    "> -# (call) — Jan 15 2020 7:31 PM",
    "> call placed by Jo (10s)", ">",
    "> -# (call) — Jan 15 2020 7:32 PM",
    "> call answered by Jo (20s)", ">",
    "> -# (call) — Jan 15 2020 7:33 PM",
    "> missed call", ">",
    "> -# (call) — Jan 15 2020 7:34 PM",
    "> voicemail (15s): bare vm", ">", "",
  ].join("\n"));
});

test("tag-link fallback: scans every voice#<tag> link and prefers a specific tag over inbox", () => {
  const tagsHtml = (...tags) =>
    `<div class="tags">Labels: ${tags.map((t) => `<a href="https://www.google.com/voice#${t}" rel="tag">${t}</a>`).join(", ")}</div>\n`;
  const fInboxSms = {
    file: "Pat - Extra - 2020-01-15T10_00_00Z.html",
    text: msg("2020-01-15T10:00:00Z", "Pat", "tagged sms") + tagsHtml("inbox", "sms"),
  };
  const fUnreadPlaced = {
    file: "Pat - Extra - 2020-01-15T10_01_00Z.html",
    text: callHtml({ dt: "2020-01-15T10:01:00Z", dur: "30S" }) + tagsHtml("unread", "placed"),
  };
  const fStarredMissed = {
    file: "Pat - Extra - 2020-01-15T10_02_00Z.html",
    text: callHtml({ dt: "2020-01-15T10:02:00Z" }) + tagsHtml("starred", "missed"),
  };
  const fUnreadOnly = {
    file: "Pat - Extra - 2020-01-15T10_03_00Z.html",
    text: callHtml({ dt: "2020-01-15T10:03:00Z" }) + tagsHtml("unread"),
  };
  const fInboxOnly = {
    file: "Pat - Extra - 2020-01-15T10_04_00Z.html",
    text: callHtml({ dt: "2020-01-15T10:04:00Z", dur: "14S", vm: "last resort" }) + tagsHtml("inbox"),
  };

  assert.equal(kindOf(fInboxSms.file, fInboxSms.text), "text");
  assert.equal(kindOf(fUnreadPlaced.file, fUnreadPlaced.text), "placed");
  assert.equal(kindOf(fStarredMissed.file, fStarredMissed.text), "missed");
  assert.equal(kindOf(fUnreadOnly.file, fUnreadOnly.text), null);
  assert.equal(kindOf(fInboxOnly.file, fInboxOnly.text), "voicemail");

  const { files, stats } = plan([fInboxSms, fUnreadPlaced, fStarredMissed, fUnreadOnly, fInboxOnly], { me: "Jo" });
  assert.deepEqual(stats.unknownKinds, [fUnreadOnly.file]);
  assert.equal(stats.texts, 1);
  assert.equal(stats.calls, 2);
  assert.equal(stats.voicemails, 1);
  assert.equal(body(files[0].text), [
    "## 2020-01-15 (Wed)", "",
    "> -# Pat — Jan 15 2020 10:00 AM",
    "> tagged sms", ">",
    "> -# (call) — Jan 15 2020 10:01 AM",
    "> call placed by Jo (30s)", ">",
    "> -# (call) — Jan 15 2020 10:02 AM",
    "> missed call", ">",
    "> -# (call) — Jan 15 2020 10:04 AM",
    "> voicemail (14s): last resort", ">", "",
  ].join("\n"));
});

test("empty sender cite counts under (unknown) in stats.senders, and the default heading escapes contact tags", () => {
  const noFn = '<div class="message"><abbr class="dt" title="2020-01-15T10:00:00Z">t</abbr>'
    + '<cite class="sender vcard"><a class="tel" href="tel:+15550199"></a></cite>: <q>anon</q></div>\n';
  const { files, stats } = plan([
    { file: "A <b> & Co - Text - 2020-01-15T10_00_00Z.html", text: noFn },
  ]);
  assert.deepEqual({ ...stats.senders }, { "(unknown)": 1 });
  assert.match(files[0].text, /^# Google Voice with A \\<b> & Co\n/);
});
