// `leket convert google-chat`: src/convert/google-chat.js parses Hebrew-locale Takeout
// messages.json files and renders one Markdown transcript per conversation; bin/leket.js
// reads the inputs and writes. Synthetic fixtures only (invented names and folders).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { plan } from "../src/convert/google-chat.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-gc-"));
const NNBSP = String.fromCharCode(0x202f);
const NBSP = String.fromCharCode(0xa0);

test("plan: renders a folder conversation with owners, --name, attachments, pyStrip lines, and placed undated rows", () => {
  const data = {
    messages: [
      {
        creator: { name: "Ava R." },
        created_date: `1 במרץ 2025 בשעה 20:04:10${NNBSP}UTC`,
        text: `first line   \n\nsecond line${NBSP}`,
      },
      {
        creator: { name: "Ben T." },
        text: "inherited date",
        attached_files: [{ original_name: "notes.pdf", export_name: " notes_1.pdf" }],
      },
      {
        creator: { name: "Ava R." },
        created_date: "2 ב-מרץ 2025 בשעה 14:30:00 UTC",
        text: "see <b> &amp; ok",
        attached_files: [{ original_name: "img <b>.png", export_name: "" }, {}],
      },
      {
        creator: { name: "Cal M." },
        created_date: "2 במרץ 2025 בשעה 14:31:00 UTC",
      },
    ],
  };
  const { files, stats } = plan(
    [{ folder: "Project Space", file: "messages.json", data }],
    { me: "Jo", owners: ["Ava R."], names: { "Ben T.": "Benny", "Ava R.": "Not Owner" }, timeZone: "America/New_York" },
  );
  assert.deepEqual(files.map((f) => f.name), ["google-chat-Project Space.md"]);
  assert.deepEqual({ ...stats, senders: { ...stats.senders } }, {
    files: 1, messages: 4, fromOwner: 2, placed: 1,
    undated: 0, empty: 0, notExports: 0,
    senders: { "Ava R.": 2, "Ben T.": 1, "Cal M.": 1 },
  });
  assert.equal(files[0].text, [
    "# Google Chat with Project Space",
    "",
    "Source: 1 Google Chat Takeout file, from `Project Space`.",
    "4 messages, 2025-03-01 to 2025-03-02. Times are America/New_York. Attachments appear as `[attachment: name]` (files are not copied). 1 message had no date in the export and is placed after the message before them.",
    "",
    "## 2025-03-01 (Sat)",
    "",
    "> -# Jo — Mar 1 2025 3:04 PM",
    "> first line",
    ">",
    "> second line",
    ">",
    "> -# Benny — Mar 1 2025 3:04 PM",
    "> [no date in the export] inherited date",
    "> [attachment: notes.pdf]",
    "",
    "## 2025-03-02 (Sun)",
    "",
    "> -# Jo — Mar 2 2025 9:30 AM",
    "> see \\<b> \\&amp; ok",
    "> [attachment: img \\<b>.png]",
    "> [attachment: unknown]",
    ">",
    "> -# Cal M. — Mar 2 2025 9:31 AM",
    "> [no text]",
    ">",
    "",
  ].join("\n"));
});

test("dates: all 12 Hebrew month words, U+202F and U+00A0 normalization, transitive inheritance, first-row undated skip, and stable sort", () => {
  const months = [
    "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
    "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
  ];
  const monthRows = months.map((m, i) => ({
    creator: { name: "Ava R." },
    created_date: `יום ה׳, 15 ב${i % 2 ? "-" : ""}${m}${NNBSP}2024${NBSP}בשעה 12:00:00 UTC`,
    text: `m${i + 1}`,
  }));
  const { files: mFiles, stats: mStats } = plan([{ folder: "Months", file: "messages.json", data: { messages: monthRows } }]);
  assert.equal(mStats.messages, 12);
  assert.match(mFiles[0].text, /12 messages, 2024-01-15 to 2024-12-15\. Times are UTC\. Attachments appear as `\[attachment: name\]` \(files are not copied\)\.\n/);

  // Undated first row is skipped; two consecutive undated rows after a dated row inherit transitively
  // and stay after their neighbour even when a later row in the file carries an earlier timestamp
  const { files, stats } = plan([{
    folder: "Order",
    file: "messages.json",
    data: {
      messages: [
        { creator: { name: "Ava R." }, text: "dropped first undated" },
        { creator: { name: "Ava R." }, created_date: "10 במאי 2025 בשעה 10:00:00 UTC", text: "second" },
        { creator: { name: "Ben T." }, text: "inherited 1" },
        { creator: { name: "Cal M." } },
        { creator: { name: "Ava R." }, created_date: "10 במאי 2025 בשעה 09:00:00 UTC", text: "first by clock" },
        { creator: { name: "Ava R." }, created_date: "10 בחודשלאקיים 2025 בשעה 11:00:00 UTC", text: "unknown month" },
        { creator: { name: "Ava R." }, created_date: "not a date", text: "bad grammar" },
        { creator: { name: "Ben T." }, text: "poisoned: inherits the bad date, as the raw-string chain does" },
        { creator: { name: "Ava R." }, created_date: 12345, text: "non-string" },
        { creator: { name: "Ava R." }, created_date: "31 בפברואר 2025 בשעה 10:00:00 UTC", text: "day rolls over" },
        { creator: { name: "Ava R." }, created_date: "10 במאי 2025 בשעה 25:61:00 UTC", text: "hour and minute roll over" },
      ],
    },
  }]);
  assert.equal(stats.messages, 4);
  assert.equal(stats.placed, 2);
  assert.equal(stats.undated, 7);
  assert.match(files[0].text, /2 messages had no date in the export and are placed after the message before them\./);
  assert.deepEqual(files[0].text.match(/^> (?!-#).*/gm), [
    "> first by clock",
    "> second",
    "> [no date in the export] inherited 1",
    "> [no date in the export]",
  ]);
});

test("names, loose files, headings, escapeTag, collision numbering, and empty/non-export skipping", () => {
  // Without --owner, nobody is the owner (even "Me"); multi-line names collapse; missing name is "?"
  const inputs = [
    {
      folder: "",
      file: "loose.json",
      data: {
        messages: [
          { creator: { name: "Me" }, created_date: "1 בינואר 2025 בשעה 00:00:00 UTC", text: 42, attached_files: "not-an-array" },
          { creator: { name: "Ben\n  T. <script>" }, created_date: "1 בינואר 2025 בשעה 00:01:00 UTC", text: "hi" },
          { creator: {}, created_date: "1 בינואר 2025 בשעה 00:02:00 UTC", text: "anon" },
        ],
      },
    },
    {
      folder: "Loose <tag>",
      file: "messages.json",
      data: { messages: [{ creator: { name: "Ava R." }, created_date: "2 בינואר 2025 בשעה 00:00:00 UTC", text: "ok" }] },
    },
    {
      folder: "loose -tag-",
      file: "messages.json",
      data: { messages: [{ creator: { name: "Ava R." }, created_date: "3 בינואר 2025 בשעה 00:00:00 UTC", text: "collision" }] },
    },
    { folder: "EmptyChat", file: "messages.json", data: { messages: [] } },
    { folder: "NoMessagesKey", file: "messages.json", data: {} },
    { folder: "NotExportDir", file: "", data: null },
    { folder: "", file: "notes.txt", data: {} },
    // a conversation whose every row is skipped for dates counts as BOTH empty and undated
    { folder: "AllUndated", file: "messages.json", data: { messages: [{ creator: { name: "Ava R." }, created_date: "not a date", text: "x" }] } },
  ];
  const { files, stats } = plan(inputs);
  assert.deepEqual(files.map((f) => f.name), [
    "google-chat-loose.md",
    "google-chat-Loose -tag-.md",
    "google-chat-loose -tag- (2).md",
  ]);
  assert.equal(stats.fromOwner, 0);
  assert.equal(stats.empty, 3);
  assert.equal(stats.undated, 1);
  assert.equal(stats.notExports, 2);
  assert.deepEqual({ ...stats.senders }, { Me: 1, "Ben T. <script>": 1, "?": 1, "Ava R.": 2 });
  assert.match(files[0].text, /^# Google Chat with loose\n\nSource: 1 Google Chat Takeout file\.\n/);
  assert.match(files[0].text, /> -# Me — Jan 1 2025 12:00 AM\n> \[no text\]\n>\n> -# Ben T\. \\<script> — Jan 1 2025 12:01 AM\n> hi\n>\n> -# \? — Jan 1 2025 12:02 AM\n> anon/);
  assert.match(files[1].text, /^# Google Chat with Loose \\<tag>\n\nSource: 1 Google Chat Takeout file, from `Loose <tag>`\.\n/);

  // --title changes only the heading, not the file name, and is not escaped
  const titled = plan([inputs[1]], { title: "Custom <Heading>" });
  assert.equal(titled.files[0].name, "google-chat-Loose -tag-.md");
  assert.match(titled.files[0].text, /^# Custom <Heading>\n/);

  // Every input empty or skipped throws, naming the number of input paths
  assert.throws(
    () => plan([inputs[3], inputs[5]]),
    /^Error: the 2 input paths given hold no Google Chat messages$/,
  );
});

test("CLI: converts folders and loose .json, deduplicates by realpath, descends into a Groups-style folder, scopes --title, reports all summary lines, and validates flags", () => {
  const src = tmp(), out = tmp();
  const spaceDir = join(src, "Project Space");
  const teamBDir = join(src, "Team B");
  const emptyChatDir = join(src, "Empty Space");
  const noJsonDir = join(src, "No Json");
  mkdirSync(spaceDir);
  mkdirSync(teamBDir);
  mkdirSync(emptyChatDir);
  mkdirSync(noJsonDir);

  const spaceFile = join(spaceDir, "messages.json");
  writeFileSync(spaceFile, JSON.stringify({
    messages: [
      { creator: { name: "Ava R." }, created_date: "26 בנובמבר 2026 בשעה 20:11:40 UTC", text: "hello" },
      { creator: { name: "Ben T." }, text: "undated reply" },
      { creator: { name: "Ben T." }, created_date: "bad date", text: "skipped" },
    ],
  }));
  const teamBFile = join(teamBDir, "messages.json");
  writeFileSync(teamBFile, JSON.stringify({
    messages: [{ creator: { name: "Cal M." }, created_date: "3 בנובמבר 2026 בשעה 15:00:00 UTC", text: "team b" }],
  }));
  writeFileSync(join(emptyChatDir, "messages.json"), JSON.stringify({ messages: [] }));
  const looseTxt = join(src, "ignore.txt");
  writeFileSync(looseTxt, "not json");

  // Pass each folder together with its own messages.json: realpath dedup counts each
  // once. --owner "Ava  R." (two spaces) must match the collapsed sender name.
  const r = leket([
    "convert", "google-chat", spaceDir, spaceFile, teamBDir, teamBFile,
    emptyChatDir, noJsonDir, looseTxt,
    "--out", out, "--me", "Jo", "--owner", "Ava  R.", "--name", "Ben T.=Benny",
    "--tz", "America/New_York",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["google-chat-Project Space.md", "google-chat-Team B.md"]);
  assert.equal(r.stderr, [
    "leket: 2 Google Chat Takeout files: 3 messages, 1 from Jo, 1 with no date placed after the message before them; times in America/New_York.",
    "leket: senders: Ava R. (1), Ben T. (1), Cal M. (1).",
    "leket: 1 row had no usable date, skipped.",
    "leket: 1 file held no usable messages, skipped.",
    "leket: 2 input paths aren't a Google Chat export (no messages.json), skipped.",
    "",
  ].join("\n"));
  const md = readFileSync(join(out, "google-chat-Project Space.md"), "utf8");
  assert.match(md, /^# Google Chat with Project Space\n\nSource: 1 Google Chat Takeout file, from `Project Space`\./);

  // --title names one conversation: works for a single input, refused (exit 1) for several
  const titledOut = tmp();
  const titled = leket(["convert", "google-chat", spaceDir, "--title", "Team Chat", "--out", titledOut]);
  assert.equal(titled.status, 0, titled.stderr);
  assert.match(readFileSync(join(titledOut, "google-chat-Project Space.md"), "utf8"), /^# Team Chat\n/);

  const multiTitle = leket(["convert", "google-chat", spaceDir, teamBDir, "--title", "Team Chat", "--out", tmp()]);
  assert.equal(multiTitle.status, 1);
  assert.match(multiTitle.stderr, /^leket: --title names one conversation's heading; the inputs hold 2 conversations; nothing written\.\n/);

  // A Groups-style parent (no own messages.json) descends one level into its
  // conversation folders; loose files and message-less subdirs inside it are ignored
  const descentOut = tmp();
  const descended = leket(["convert", "google-chat", src, "--out", descentOut]);
  assert.equal(descended.status, 0, descended.stderr);
  assert.deepEqual(readdirSync(descentOut).sort(), ["google-chat-Project Space.md", "google-chat-Team B.md"]);
  assert.equal(descended.stderr, [
    "leket: 2 Google Chat Takeout files: 3 messages, 1 with no date placed after the message before them; times in UTC.",
    "leket: senders: Ava R. (1), Ben T. (1), Cal M. (1).",
    "leket: 1 row had no usable date, skipped.",
    "leket: 1 file held no usable messages, skipped.",
    "",
  ].join("\n"));

  // Exit 1 when every input is empty/non-export (word() covers the singular), or when a .json file is invalid JSON
  const failEmpty = leket(["convert", "google-chat", emptyChatDir, noJsonDir, "--out", tmp()]);
  assert.equal(failEmpty.status, 1);
  assert.match(failEmpty.stderr, /leket: the 2 input paths given hold no Google Chat messages; nothing written\./);

  const failEmpty1 = leket(["convert", "google-chat", emptyChatDir, "--out", tmp()]);
  assert.equal(failEmpty1.status, 1);
  assert.match(failEmpty1.stderr, /leket: the 1 input path given holds no Google Chat messages; nothing written\./);

  const badJson = join(src, "bad.json");
  writeFileSync(badJson, "{not json");
  const failJson = leket(["convert", "google-chat", badJson, "--out", tmp()]);
  assert.equal(failJson.status, 1);
  assert.match(failJson.stderr, /bad\.json isn't JSON .*; nothing written\./);

  // Usage errors exit 2; --help exits 0
  const help = leket(["convert", "google-chat", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: leket convert google-chat/);

  for (const [args, pattern] of [
    [[], /usage: leket convert/],
    [[spaceDir, "--bogus"], /usage: leket convert/],
    [[spaceDir, "--me", " "], /--me takes a one-line label/],
    [[spaceDir, "--title", "a\nb"], /--title takes a one-line label/],
    [[spaceDir, "--owner", " "], /--owner takes a one-line name/],
    [[spaceDir, "--name", "Ava"], /--name takes NAME=LABEL/],
    [[spaceDir, "--name", "Ava= "], /takes a one-line label/],
    [[spaceDir, "--tz", "Mars/Base"], /unknown time zone/],
  ]) {
    const ur = leket(["convert", "google-chat", ...args]);
    assert.equal(ur.status, 2, args.join(" "));
    assert.match(ur.stderr, pattern);
  }
});
