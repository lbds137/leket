// bin/leket.js: the CLI's yt-dlp wiring, caption fetch and exit codes. yt-dlp itself is
// test/fixtures/fake-yt-dlp.js (via LEKET_YTDLP), and the caption fetch is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ytDlpArgs, ytDlpCommand, reportedTotal, fetchTranscript, extractFromInfo } from "../bin/leket.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const FAKE = join(here, "fixtures", "fake-yt-dlp.js");

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const infoWithAuto = { automatic_captions: { "en-orig": [{ ext: "json3", url: "https://y.test/c?lang=en" }] } };

test("ytDlpArgs hands yt-dlp this node, skips media, and caps comments only when asked", () => {
  const a = ytDlpArgs("https://youtu.be/x", "/w");
  assert.deepEqual(a.slice(0, 2), ["--js-runtimes", `node:${process.execPath}`]);
  for (const f of ["--skip-download", "--ignore-no-formats-error", "--write-info-json", "--write-comments", "--no-playlist"]) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf("--extractor-args") + 1], "youtube:comment_sort=top");
  assert.equal(a[a.indexOf("-o") + 1], join("/w", "video.%(ext)s"));
  // the URL comes after --, so a URL starting with - can't read as an option
  assert.deepEqual(a.slice(-2), ["--", "https://youtu.be/x"]);
  const capped = ytDlpArgs("u", "/w", { maxComments: "40" });
  assert.equal(capped[capped.indexOf("--extractor-args") + 1], "youtube:max_comments=40,all,all,all;comment_sort=top");
});

test("ytDlpCommand: LEKET_YTDLP, else yt-dlp on PATH, else uvx with curl_cffi", () => {
  assert.deepEqual(ytDlpCommand({ LEKET_YTDLP: "/x/yt" }), { cmd: "/x/yt", pre: [] });
  assert.deepEqual(ytDlpCommand({}, () => ({ status: 0 })), { cmd: "yt-dlp", pre: [] });
  assert.deepEqual(ytDlpCommand({}, () => ({ error: new Error("ENOENT") })), { cmd: "uvx", pre: ["--with", "curl_cffi", "yt-dlp"] });
});

test("reportedTotal reads yt-dlp's estimate line, or nothing", () => {
  assert.equal(reportedTotal("[youtube] Downloading ~1,097 comments\n"), "~1,097");
  assert.equal(reportedTotal("no such line"), "");
});

test("fetchTranscript: no track is a note, not a failure", async () => {
  const r = await fetchTranscript({}, "de", { fetch: () => assert.fail("no fetch without a track") });
  assert.deepEqual(r, { transcript: [], note: 'This video has no captions in "de".', failed: false });
});

test("fetchTranscript: a 429 is a failure whose note says the comments are saved", async () => {
  const r = await fetchTranscript(infoWithAuto, "en", { fetch: async () => reply(429, "<html>Sorry...</html>") });
  assert.equal(r.failed, true);
  assert.match(r.note, /HTTP 429/);
  assert.match(r.note, /comments are saved/);
});

test("fetchTranscript: a network error and a non-JSON body are failures", async () => {
  const net = await fetchTranscript(infoWithAuto, "en", { fetch: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(net.failed, true);
  assert.match(net.note, /ECONNRESET/);
  const html = await fetchTranscript(infoWithAuto, "en", { fetch: async () => reply(200, "<html>") });
  assert.equal(html.failed, true);
});

test("fetchTranscript: a json3 body becomes rows with the track's kind", async () => {
  const r = await fetchTranscript(infoWithAuto, "en", {
    fetch: async (url) => { assert.equal(url, "https://y.test/c?lang=en"); return reply(200, JSON.stringify({ events: [{ tStartMs: 5000, segs: [{ utf8: "hi" }] }] })); },
  });
  assert.deepEqual(r, { transcript: [{ time: "0:05", text: "hi" }], kind: "auto", note: "", failed: false });
});

test("extractFromInfo assembles v1 with the CLI's metadata and notes", async () => {
  const { extract, captionsFailed } = await extractFromInfo({
    ...infoWithAuto,
    id: "vid", title: "T", uploader: "U",
    comments: [{ id: "A", parent: "root", author: "@a", text: "t", like_count: 1 }, { id: "Q.1", parent: "Q", author: "@o", text: "orphan" }],
  }, { lang: "en", log: "Downloading ~3 comments", fetch: async () => reply(429, ""), extractedAt: "2026-01-01T00:00:00Z" });
  assert.equal(captionsFailed, true);
  const m = extract.metadata;
  assert.equal(m.channel, "U");
  assert.equal(m.url, "https://www.youtube.com/watch?v=vid");
  assert.equal(m.total_comments_reported, "~3");
  assert.equal(m.source, "leket-cli/yt-dlp");
  assert.equal(m.transcript_language, "en");
  assert.equal(m.transcript_kind, "auto");
  assert.match(m.transcript_note, /429/);
  assert.equal(m.comments_note, "1 replies whose thread wasn't fetched were left out.");
  assert.equal(extract.comments.length, 1);
});

function runBin(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, LEKET_YTDLP: FAKE, ...env } });
}

test("leket youtube saves the json and md and exits 0 when the video has no captions", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const r = runBin(["youtube", "https://www.youtube.com/watch?v=fakeVid0001", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(out).sort(), ["a-synthetic-test-video-transcript-comments.json", "a-synthetic-test-video-transcript-comments.md"]);
    assert.equal(r.stdout.trim().split("\n").length, 2);
    const x = JSON.parse(readFileSync(join(out, "a-synthetic-test-video-transcript-comments.json"), "utf8"));
    assert.equal(x.schema, "youtube-extract/v1");
    assert.equal(x.metadata.total_comments_reported, "~5");
    assert.deepEqual(x.comments.map((c) => [c.author, c.replies.length]), [["@gamma", 0], ["@alpha", 1]]);
    assert.match(x.metadata.transcript_note, /no captions in "en"/);
    assert.match(r.stderr, /0 transcript segments, 2 comments \+ 1 replies \(YouTube reports ~5\)/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("leket youtube exits 1 and writes nothing when yt-dlp fails", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const r = runBin(["youtube", "https://youtu.be/x", "--out", out], { FAKE_YTDLP_MODE: "fail" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exited 1 and wrote no video info; nothing saved/);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("usage errors exit 2; --help exits 0 on stdout", () => {
  assert.equal(runBin([]).status, 2);
  assert.equal(runBin(["vimeo", "u"]).status, 2);
  assert.equal(runBin(["youtube"]).status, 2);
  assert.equal(runBin(["youtube", "u", "--max-comments", "0"]).status, 2);
  assert.equal(runBin(["youtube", "u", "--lang", "en;rm"]).status, 2);
  assert.equal(runBin(["youtube", "u", "--bogus"]).status, 2);
  const h = runBin(["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^usage: leket youtube/);
});
