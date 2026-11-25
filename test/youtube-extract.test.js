// src/modules/youtube/extract.js: the youtube-extract/v1 builder and Markdown shared by
// the CLI and the extension. Every name and text here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA, parseLikes, formatTimestamp, json3ToTranscript, pickCaptionTrack, threadsFromYtDlp,
  buildExtract, renderMarkdown, baseName,
} from "../src/modules/youtube/extract.js";

test("parseLikes reads the counts YouTube displays, and blank or junk as 0", () => {
  assert.equal(parseLikes("1.2K"), 1200);
  assert.equal(parseLikes("3.4M"), 3400000);
  assert.equal(parseLikes("1,234"), 1234);
  assert.equal(parseLikes("7"), 7);
  assert.equal(parseLikes(""), 0);
  assert.equal(parseLikes(null), 0);
  assert.equal(parseLikes("abc"), 0);
  assert.equal(parseLikes("Infinity"), 0);
});

test("formatTimestamp writes the transcript panel's stamps", () => {
  assert.equal(formatTimestamp(0), "0:00");
  assert.equal(formatTimestamp(14_900), "0:14");
  assert.equal(formatTimestamp(723_000), "12:03");
  assert.equal(formatTimestamp(3_723_000), "1:02:03");
  assert.equal(formatTimestamp(undefined), "0:00");
});

test("json3ToTranscript joins segs, drops header and newline-only append events, flattens line breaks", () => {
  const rows = json3ToTranscript({
    events: [
      { tStartMs: 0, dDurationMs: 99999, id: 1, wpWinPosId: 1 },
      { tStartMs: 1200, segs: [{ utf8: "hello" }, { utf8: " there", tOffsetMs: 400 }] },
      { tStartMs: 2000, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 62_500, segs: [{ utf8: "two\nlines" }] },
      { tStartMs: 70_000, segs: [{}] },
    ],
  });
  assert.deepEqual(rows, [
    { time: "0:01", text: "hello there" },
    { time: "1:02", text: "two lines" },
  ]);
  assert.deepEqual(json3ToTranscript(null), []);
  assert.deepEqual(json3ToTranscript({}), []);
});

test("pickCaptionTrack prefers manual, then <lang>-orig, then the plain auto track (translated when tlang is set)", () => {
  const t = (url, ext = "json3") => [{ ext: "vtt", url: `${url}&fmt=vtt` }, { ext, url }];
  const info = {
    subtitles: { en: t("https://y.test/manual?lang=en") },
    automatic_captions: { "en-orig": t("https://y.test/orig?lang=en"), en: t("https://y.test/auto?lang=en&tlang=en") },
  };
  assert.deepEqual(pickCaptionTrack(info, "en"), { url: "https://y.test/manual?lang=en", kind: "manual", language: "en" });
  delete info.subtitles.en;
  assert.equal(pickCaptionTrack(info, "en").kind, "auto");
  assert.equal(pickCaptionTrack(info, "en").url, "https://y.test/orig?lang=en");
  delete info.automatic_captions["en-orig"];
  assert.equal(pickCaptionTrack(info, "en").kind, "auto-translated");
  info.automatic_captions.en = t("https://y.test/auto?lang=en");
  assert.equal(pickCaptionTrack(info, "en").kind, "auto");
  // a regional human track (en-GB, en-US) beats every auto track; the first by key wins
  const regional = {
    subtitles: { "en-US": t("https://y.test/us"), "en-GB": t("https://y.test/gb"), eng: t("https://y.test/eng") },
    automatic_captions: { "en-orig": t("https://y.test/orig") },
  };
  assert.deepEqual(pickCaptionTrack(regional, "en"), { url: "https://y.test/gb", kind: "manual", language: "en-GB" });
  assert.deepEqual(pickCaptionTrack(regional, "EN"), { url: "https://y.test/gb", kind: "manual", language: "en-GB" });
  // a language with only non-json3 formats, or none at all, has no track
  assert.equal(pickCaptionTrack({ automatic_captions: { fr: [{ ext: "vtt", url: "https://y.test/v" }] } }, "fr"), null);
  assert.equal(pickCaptionTrack({}, "en"), null);
});

test("threadsFromYtDlp puts a reply-to-a-reply in its thread and drops replies whose thread is missing", () => {
  const { threads, droppedReplies } = threadsFromYtDlp([
    { id: "A", parent: "root", author: "@a", text: "top", like_count: 2, _time_text: "1 day ago", is_pinned: true },
    { id: "A.x", parent: "A", author: "@b", text: "reply", like_count: 0, _time_text: "1 hour ago" },
    // yt-dlp names the reply it answers as the parent, not the thread
    { id: "A.y", parent: "A.x", author: "@c", text: "reply to reply", like_count: 1 },
    { id: "Z.q", parent: "Z", author: "@d", text: "orphan" },
    { id: "B", parent: "root", author: "@e", text: "second" },
  ]);
  assert.equal(droppedReplies, 1);
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0], {
    author: "@a", likes: "2", time: "1 day ago", pinned: true, reply_count_label: null, text: "top",
    replies: [
      { author: "@b", likes: "0", time: "1 hour ago", text: "reply" },
      { author: "@c", likes: "1", time: "", text: "reply to reply" },
    ],
  });
  assert.equal(threads[1].likes, "0");
  assert.deepEqual(threadsFromYtDlp(undefined), { threads: [], droppedReplies: 0 });
});

test("threadsFromYtDlp walks the parent chain, so a thread is found even when ids don't share its prefix", () => {
  const { threads, droppedReplies } = threadsFromYtDlp([
    { id: "T1", parent: "root", author: "@a", text: "top" },
    { id: "r1", parent: "T1", author: "@b", text: "one" },
    { id: "r2", parent: "r1", author: "@c", text: "two" },
    // a loop that never reaches a thread is dropped, not followed forever
    { id: "L1", parent: "L2", author: "@d", text: "loop" },
    { id: "L2", parent: "L1", author: "@e", text: "loop" },
  ]);
  assert.deepEqual(threads[0].replies.map((r) => r.text), ["one", "two"]);
  assert.equal(droppedReplies, 2);
});

test("buildExtract keeps the v1 shape, sorts by likes stably, and adds extra metadata only when set", () => {
  const x = buildExtract({
    extractedAt: "2026-01-01T00:00:00.000Z",
    metadata: { title: "T", channel: "C", url: "https://y.test/w", total_comments_reported: "~5", source: "test", transcript_note: "" },
    transcript: [{ time: "0:00", text: "hi", extra: 1 }],
    comments: [
      { author: "@low", likes: "1", time: "", pinned: false, text: "l", replies: [] },
      { author: "@k", likes: "1.2K", time: "t", pinned: true, reply_count_label: "2 replies", text: "k", replies: [{ author: "@r", likes: "3", text: "r" }] },
      { author: "@low2", likes: "1", time: "", pinned: false, text: "l2" },
    ],
  });
  assert.equal(x.schema, SCHEMA);
  assert.equal(x.extracted_at, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(x.metadata, {
    title: "T", channel: "C", url: "https://y.test/w", total_comments_reported: "~5",
    transcript_segment_count: 1, comments_captured: 3, source: "test",
  });
  assert.deepEqual(x.transcript, [{ time: "0:00", text: "hi" }]);
  assert.deepEqual(x.comments.map((c) => c.author), ["@k", "@low", "@low2"]);
  assert.deepEqual(x.comments[0], {
    author: "@k", likes: "1.2K", likes_numeric: 1200, time: "t", pinned: true, reply_count_label: "2 replies", text: "k",
    replies: [{ author: "@r", likes: "3", likes_numeric: 3, time: "", text: "r" }],
  });
  assert.deepEqual(x.comments[2].replies, []);
});

test("renderMarkdown keeps the console script's layout, fences past any backticks, and keeps comments on one line", () => {
  const x = buildExtract({
    metadata: { title: "T", channel: "C", url: "u", transcript_note: "No captions.", transcript_kind: "auto", transcript_language: "en" },
    transcript: [{ time: "0:01", text: "code ``` here" }],
    comments: [{ author: "@a", likes: "2", time: "now", pinned: true, text: "line one\nline two", replies: [{ author: "@b", likes: "0", text: "ok\n> not a quote" }] }],
  });
  const md = renderMarkdown(x);
  assert.match(md, /^# YouTube Video Reference File\n/);
  assert.match(md, /- \*\*Transcript:\*\* en \(auto\)\n/);
  assert.match(md, /- \*\*Transcript note:\*\* No captions\.\n/);
  assert.match(md, /\n````\n0:01\tcode ``` here\n````\n/);
  assert.match(md, /1\. \*\*@a\*\* — 2 likes · now · PINNED\n {3}> line one line two\n {3}- ↳ \*\*@b\*\* \(0\): ok > not a quote\n/);
  assert.match(md, /Comments captured:\*\* 1 top-level \+ 1 replies/);
});

test("renderMarkdown escapes < outside the transcript fence and indents past a two-digit marker", () => {
  const comments = Array.from({ length: 10 }, (_, i) => ({ author: `@u${i}`, likes: String(10 - i), time: "", text: `t${i}`, replies: [] }));
  comments[9].text = "<img src=x onerror=alert(1)> hi";
  comments[9].replies = [{ author: "<b>@r</b>", likes: "0", text: "r" }];
  const md = renderMarkdown(buildExtract({ metadata: { title: "<script>", url: "u" }, transcript: [{ time: "0:00", text: "a <b> c" }], comments }));
  assert.match(md, /\*\*Title:\*\* &lt;script>/);
  assert.match(md, /\n10\. \*\*@u9\*\* — 1 likes\n {4}> &lt;img src=x onerror=alert\(1\)> hi\n {4}- ↳ \*\*&lt;b>@r&lt;\/b>\*\* \(0\): r\n/);
  // inside the fence the text is literal already, so it stays as said
  assert.match(md, /\n0:00\ta <b> c\n/);
  assert.doesNotMatch(md, /<img|<script|<b>@r/);
});

test("baseName slugs the title like the console script, trims outer dashes, and adds a well-formed video id", () => {
  assert.equal(baseName("A Synthetic Test Video!"), "a-synthetic-test-video");
  assert.equal(baseName("A Video", "abc_-123"), "a-video-abc_-123");
  assert.equal(baseName("A Video", "../x"), "a-video");
  assert.equal(baseName(""), "youtube");
  assert.equal(baseName("!!!", "id1"), "youtube-id1");
  assert.equal(baseName("x".repeat(80)).length, 60);
});
