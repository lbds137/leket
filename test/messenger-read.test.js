// Unit tests for src/modules/messenger/read.js loaded via node:vm (synthetic fixtures only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadRead({ withModule = true } = {}) {
  const src = readFileSync(new URL("../src/modules/messenger/read.js", import.meta.url), "utf8");
  const mod = { exports: {} };
  const sandbox = withModule ? { module: mod } : {};
  vm.runInNewContext(src, sandbox);
  return {
    globalApi: vm.runInContext("globalThis.LeketMessengerRead", sandbox),
    moduleApi: withModule ? mod.exports : undefined,
  };
}

test("exposes LeketMessengerRead on globalThis and module.exports when module exists", () => {
  const both = loadRead({ withModule: true });
  assert.equal(typeof both.globalApi.i64, "function");
  assert.equal(both.globalApi, both.moduleApi);

  const pageOnly = loadRead({ withModule: false });
  assert.equal(typeof pageOnly.globalApi.renderMarkdown, "function");
  assert.equal(pageOnly.moduleApi, undefined);
});

test("i64 decodes [0, 1], negative low word [1, -1], Date.UTC pair, strings, numbers, and rejects others", () => {
  const { globalApi: R } = loadRead();
  assert.equal(R.i64([0, 1]), 1n);
  assert.equal(R.i64([1, -1]), (1n << 33n) - 1n);

  const ms = Date.UTC(2026, 10, 15, 14, 25, 30, 123);
  const high = Math.floor(ms / 2 ** 32);
  const low = ms | 0;
  assert.ok(low < 0, "low word is negative as a signed 32-bit int");
  assert.equal(R.i64([high, low]), BigInt(ms));

  assert.equal(R.i64("42"), 42n);
  assert.equal(R.i64(42), 42n);
  assert.equal(R.i64(null), null);
  assert.equal(R.i64(undefined), null);
  assert.equal(R.i64(""), null);
  assert.equal(R.i64("not-a-number"), null);
  assert.equal(R.i64({}), null);
  assert.equal(R.i64([1]), null);
  assert.equal(R.i64(true), null);
});

test("toIso round-trips a Date.UTC pair and returns null for invalid inputs", () => {
  const { globalApi: R } = loadRead();
  const ms = Date.UTC(2026, 10, 15, 22, 45, 12, 345);
  const pair = [Math.floor(ms / 2 ** 32), ms | 0];
  const iso = R.toIso(pair);
  assert.equal(iso, "2026-11-15T22:45:12.345Z");
  assert.equal(Date.parse(iso), ms);
  assert.equal(R.toIso(null), null);
  assert.equal(R.toIso("bad"), null);
});

const plain = (v) => JSON.parse(JSON.stringify(v));

test("contentKinds decodes 1, 2, 1024, 16384, 1|4096, [0, n], and 0 or missing", () => {
  const { globalApi: R } = loadRead();
  assert.deepEqual(plain(R.contentKinds(1)), ["text"]);
  assert.deepEqual(plain(R.contentKinds(2)), ["media"]);
  assert.deepEqual(plain(R.contentKinds(1024)), ["link"]);
  assert.deepEqual(plain(R.contentKinds(16384)), ["sticker"]);
  assert.deepEqual(plain(R.contentKinds(1 | 4096)), ["text", "other:4096"]);
  assert.deepEqual(plain(R.contentKinds([0, 1 | 4096])), ["text", "other:4096"]);
  assert.deepEqual(plain(R.contentKinds(0)), []);
  assert.deepEqual(plain(R.contentKinds([0, 0])), []);
  assert.deepEqual(plain(R.contentKinds(null)), []);
  assert.deepEqual(plain(R.contentKinds(undefined)), []);
});

test("safePart and mediaName sanitize ids with /, $, =, .. and a leading dot", () => {
  const { globalApi: R } = loadRead();
  const rawId = ".mid.$a/b=c..d";
  const cleaned = R.safePart(rawId);
  assert.equal(cleaned, "mid._a_b_c..d");
  assert.ok(!cleaned.startsWith("."));
  assert.ok(!/[/$=]/.test(cleaned));

  assert.equal(R.safePart("...", 40), "x");
  assert.equal(R.safePart("$$$", 40), "_");
  assert.equal(R.safePart("abcdefghij", 5), "abcde");

  assert.equal(
    R.mediaName("2026-11-15", rawId, 1, "image/jpeg"),
    "2026-11-15_mid._a_b_c..d_1.jpg",
  );
  assert.equal(R.mediaName("2026-11-15", "m1", 2, "image/png"), "2026-11-15_m1_2.png");
  assert.equal(R.mediaName("2026-11-15", "m1", 3, "image/webp"), "2026-11-15_m1_3.webp");
  assert.equal(R.mediaName("2026-11-15", "m1", 4, "image/gif"), "2026-11-15_m1_4.gif");
  assert.equal(R.mediaName("2026-11-15", "m1", 5, "video/mp4"), "2026-11-15_m1_5.mp4");
  assert.equal(R.mediaName("2026-11-15", "m1", 6, "video/webm"), "2026-11-15_m1_6.webm");
  assert.equal(R.mediaName("2026-11-15", "m1", 7, "video/quicktime"), "2026-11-15_m1_7.mov");
  assert.equal(R.mediaName("2026-11-15", "m1", 8, "application/octet-stream"), "2026-11-15_m1_8.bin");
});

test("normalize handles both e2ee-shaped and plain-shaped message objects", () => {
  const { globalApi: R } = loadRead();
  const ms1 = Date.UTC(2026, 10, 15, 10, 0, 0);
  const e2eeMsg = {
    messageId: "m1",
    timestampMs: [Math.floor(ms1 / 2 ** 32), ms1 | 0],
    senderId: [0, 7],
    text: "synthetic reply",
    isUnsent: false,
    editCount: 1,
    replyMessageText: "quoted line",
    replySnippet: "fallback snippet",
    replyToUserId: [0, 8],
    displayedContentTypes: [0, 1],
  };
  assert.deepEqual(plain(R.normalize(e2eeMsg, "Sender A", true)), {
    id: "m1",
    time: "2026-11-15T10:00:00.000Z",
    sender_id: "7",
    sender: "Sender A",
    outgoing: true,
    text: "synthetic reply",
    unsent: false,
    edited: true,
    reply_to: { text: "quoted line" },
    kinds: ["text"],
    link: null,
    media: [],
  });

  const ms2 = Date.UTC(2026, 10, 15, 10, 5, 0);
  const plainMsg = {
    messageId: "m2",
    timestampMs: [Math.floor(ms2 / 2 ** 32), ms2 | 0],
    senderId: [0, 8],
    text: undefined,
    isUnsent: false,
    editCount: 0,
    displayedContentTypes: [0, 2],
  };
  assert.deepEqual(plain(R.normalize(plainMsg, "Sender B", false)), {
    id: "m2",
    time: "2026-11-15T10:05:00.000Z",
    sender_id: "8",
    sender: "Sender B",
    outgoing: false,
    text: null,
    unsent: false,
    edited: false,
    reply_to: null,
    kinds: ["media"],
    link: null,
    media: [],
  });
});

test("renderMarkdown splits days across midnight in a non-UTC zone, renders media links, placeholders, and line-start escaping", () => {
  const { globalApi: R } = loadRead();
  const exp = {
    leket: "messenger",
    version: 1,
    host: "www.messenger.com",
    thread_id: "99",
    url: "https://www.messenger.com/e2ee/t/99",
    title: "Synthetic Thread",
    saved_at: "2026-11-16T01:00:00.000Z",
    time_zone: "Asia/Jerusalem",
    count: 6,
    senders: { "7": "Sender A", "8": "Sender B" },
    group_warning: false,
    media_not_captured: [{ message_id: "m3", kind: "photo", reason: "empty" }, { message_id: "m4", kind: "video", reason: "MediaSource" }],
    messages: [
      {
        id: "m1",
        time: "2026-11-15T21:30:00.000Z",
        sender_id: "7",
        sender: "Sender A",
        outgoing: true,
        text: "# heading\n> quote\n- dash\n+ plus\n* star\n1. ordered\n2) paren\nplain # and - middle",
        unsent: false,
        edited: false,
        reply_to: { text: "prior text" },
        kinds: ["text", "media"],
        link: null,
        media: [{ file: "2026-11-15_m1_1.jpg", kind: "photo", mime: "image/jpeg", width: 600, height: 800, bytes: 1024, duration_s: null }],
      },
      {
        id: "m2",
        time: "2026-11-15T22:15:00.000Z",
        sender_id: "8",
        sender: "Sender B",
        outgoing: false,
        text: "after midnight in Jerusalem",
        unsent: false,
        edited: false,
        reply_to: null,
        kinds: ["text", "media", "video"],
        link: null,
        media: [{ file: "2026-11-16_m2_1.mp4", kind: "video", mime: "video/mp4", width: 720, height: 1280, bytes: 4096, duration_s: 15 }],
      },
      {
        id: "m3",
        time: "2026-11-15T22:20:00.000Z",
        sender_id: "8",
        sender: null,
        outgoing: false,
        text: null,
        unsent: false,
        edited: false,
        reply_to: null,
        kinds: ["media"],
        link: null,
        media: [],
      },
      {
        id: "m4",
        time: "2026-11-15T22:25:00.000Z",
        sender_id: null,
        sender: null,
        outgoing: false,
        text: null,
        unsent: false,
        edited: false,
        reply_to: null,
        kinds: ["media", "video", "sticker", "link"],
        link: "https://example.com/item",
        media: [],
      },
      {
        id: "m5",
        time: "2026-11-15T22:30:00.000Z",
        sender_id: "7",
        sender: "Sender A",
        outgoing: true,
        text: null,
        unsent: true,
        edited: false,
        reply_to: null,
        kinds: [],
        link: null,
        media: [],
      },
      {
        id: "m6",
        time: null,
        sender_id: "8",
        sender: "Sender B",
        outgoing: false,
        text: "undated note",
        unsent: false,
        edited: false,
        reply_to: null,
        kinds: ["text"],
        link: null,
        media: [],
      },
    ],
  };

  const md = R.renderMarkdown(exp, { timeZone: "Asia/Jerusalem" });

  assert.match(md, /^# Synthetic Thread\n/);
  assert.ok(md.includes("www.messenger.com"));
  assert.ok(md.includes("99"));
  assert.ok(md.includes("6 messages"));
  assert.ok(md.includes("2026-11-15"));
  assert.ok(md.includes("2026-11-16"));
  assert.ok(md.includes("2026-11-16T01:00:00.000Z"));

  const d1 = md.indexOf("## 2026-11-15");
  const d2 = md.indexOf("## 2026-11-16");
  const dNone = md.indexOf("## (no date)");
  assert.ok(d1 !== -1 && d2 > d1 && dNone > d2, "days ordered with (no date) at the end");

  assert.ok(md.includes("**Sender A (you)** 23:30"));
  assert.ok(md.includes("**Sender B** 00:15"));
  assert.ok(md.includes("**8** 00:20"));
  assert.ok(md.includes("**unknown** 00:25"));
  // The quote is its own block: a blank line separates it from the sender's own text.
  assert.ok(md.includes("**Sender A (you)** 23:30\n\n> prior text\n\n\\# heading\\\n"));

  // Each message's notes, exactly, so a placeholder on the wrong message fails.
  const block = (head) => md.slice(md.indexOf(head)).split(/\n\n(?=\*\*|## )/)[0];
  assert.ok(block("**Sender A (you)** 23:30").endsWith("![photo](messenger-media/2026-11-15_m1_1.jpg)"));
  assert.ok(!block("**Sender A (you)** 23:30").includes("not captured"));
  assert.equal(block("**Sender B** 00:15"),
    "**Sender B** 00:15\n\nafter midnight in Jerusalem\n\n[video, 15 s](messenger-media/2026-11-16_m2_1.mp4)");
  assert.equal(block("**8** 00:20"), "**8** 00:20\n\n[photo, not captured]");
  assert.equal(block("**unknown** 00:25"),
    "**unknown** 00:25\n\n[video, not captured]\\\n[sticker]\\\n[link preview](<https://example.com/item>)");
  assert.equal(block("**Sender A (you)** 00:30"), "**Sender A (you)** 00:30\n\n[unsent]");

  assert.ok(md.includes("\\# heading\\\n\\> quote\\\n\\- dash\\\n\\+ plus\\\n\\* star\\\n1\\. ordered\\\n2\\) paren\\\nplain # and - middle"));

  const noDuration = R.renderMarkdown({
    time_zone: "UTC",
    messages: [{ id: "v1", time: "2026-11-15T10:00:00.000Z", sender: "Sender A", text: null,
      kinds: ["media", "video"], link: null,
      media: [{ file: "v.mp4", kind: "video", mime: "video/mp4", duration_s: null }] }],
  });
  assert.ok(noDuration.includes("[video](messenger-media/v.mp4)"), "a video with no known duration omits it");
  assert.ok(!noDuration.includes("null"));
});

test("renderMarkdown keeps structure-breaking text literal", () => {
  const { globalApi: R } = loadRead();
  const NBSP = String.fromCharCode(0xa0);
  const md = R.renderMarkdown({
    title: "T # x",
    time_zone: "UTC",
    messages: [{ id: "m1", time: "2026-11-15T10:00:00.000Z", sender: "A*b", outgoing: false,
      reply_to: { text: "# q" }, kinds: ["text"], media: [],
      text: "```\n===\n   - item\n    four\n\n<b>x</b> [l](u) C:\\d & y ~~s~~ a|b" }],
  });
  assert.match(md, /^# T \\# x\n/);
  assert.ok(md.includes("**A\\*b** 10:00"));
  assert.ok(md.includes("> \\# q"));
  assert.ok(md.includes("\\`\\`\\`\\\n\\===\\\n"));
  assert.ok(md.includes(`${NBSP.repeat(3)}\\- item\\\n${NBSP.repeat(4)}four\n\n`));
  assert.ok(md.includes("\\<b\\>x\\</b\\> \\[l\\](u) C:\\\\d \\& y \\~\\~s\\~\\~ a\\|b"));
});

test("renderMarkdown sorts by time and survives a bad time zone", () => {
  const { globalApi: R } = loadRead();
  const msg = (id, time) => ({ id, time, sender: id, text: id, kinds: ["text"], media: [] });
  const md = R.renderMarkdown({ time_zone: "Not/AZone",
    messages: [msg("b", "2026-11-16T10:00:00.000Z"), msg("a", "2026-11-15T10:00:00.000Z")] });
  assert.ok(md.indexOf("## 2026-11-15") < md.indexOf("## 2026-11-16"));
  assert.equal(md.split("## 2026-11-15").length, 2);
  assert.ok(md.includes("2026-11-15 – 2026-11-16"));
});

test("toIso treats a zero timestamp as missing; normalize without a name gives null", () => {
  const { globalApi: R } = loadRead();
  assert.equal(R.toIso([0, 0]), null);
  assert.equal(R.normalize({ messageId: "m1", senderId: [0, 7] }).sender, null);
  assert.deepEqual(plain(R.contentKinds(-2147483648)), ["other:2147483648"]);
});

test("mediaName always passes the export page's name check", () => {
  const { globalApi: R } = loadRead();
  const ok = /^[\p{L}\p{N}._-]{1,120}$/u;
  for (const [day, id, n] of [
    [".x", "m1", 1], ["(no date)", "m1", 1], [null, "m1", 1], ["2026-11-15".repeat(20), "m".repeat(200), 1],
    ["2026-11-15", ".../..", -1], ["2026-11-15", "m1", 1.5],
  ]) {
    const name = R.mediaName(day, id, n, "image/jpeg");
    assert.match(name, ok, name);
    assert.ok(!name.startsWith("."), name);
    assert.ok(name.endsWith(".jpg"), name);
  }
  assert.equal(R.mediaName("(no date)", "m1", 1.5, "image/png"), "_no_date_m1_0.png");
});

test("validMediaName takes only a bare file name; validSaveName falls back for anything else", () => {
  const { globalApi: R } = loadRead();
  for (const ok of ["2026-11-15_m1_0.jpg", "a", "x".repeat(120), "ünï_çødé.mp4", "a..b.jpg"]) {
    assert.equal(R.validMediaName(ok), true, ok);
  }
  for (const bad of ["../x.jpg", "a/b.jpg", "a\\b.jpg", ".hidden", "..", "", "x".repeat(121), "a b.jpg", null, undefined, 5, ["a.jpg"]]) {
    assert.equal(R.validMediaName(bad), false, String(bad));
  }
  // every name mediaName makes passes, whatever it is given
  for (const args of [["2026-11-15", "mid.$abc", 1, "image/jpeg"], ["../..", "../../etc", -1, "__proto__"], ["", "", NaN, ""]]) {
    assert.equal(R.validMediaName(R.mediaName(...args)), true, JSON.stringify(args));
  }
  assert.equal(R.validSaveName("messenger-Some_Name-1731700000000.json"), "messenger-Some_Name-1731700000000.json");
  for (const bad of ["../messenger-a-1.json", "messenger-a-1.json.exe", "messenger-a b-1.json", "other-a-1.json", "messenger--1.json", null, 7]) {
    assert.equal(R.validSaveName(bad), "messenger-export.json", String(bad));
  }
});
