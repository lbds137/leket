// bin/leket.js: the CLI's yt-dlp wiring, caption fetch and exit codes. yt-dlp itself is
// test/fixtures/fake-yt-dlp.js (via LEKET_YTDLP), and the caption fetch is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ytDlpArgs, ytDlpCommand, reportedTotal, fetchTranscript, extractFromInfo, isYouTubeUrl, writePair } from "../bin/leket.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const FAKE = join(here, "fixtures", "fake-yt-dlp.js");

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const infoWithAuto = { automatic_captions: { "en-orig": [{ ext: "json3", url: "https://y.test/c?lang=en" }] } };

test("ytDlpArgs hands yt-dlp this node, skips media, and caps comments only when asked", () => {
  const a = ytDlpArgs("https://youtu.be/x", "/w");
  assert.deepEqual(a.slice(0, 3), ["--ignore-config", "--js-runtimes", `node:${process.execPath}`]);
  for (const f of ["--skip-download", "--ignore-no-formats-error", "--write-info-json", "--write-comments", "--no-playlist"]) assert.ok(a.includes(f), f);
  // uncapped: newest order, because top order skips fresh unliked comments
  assert.equal(a[a.indexOf("--extractor-args") + 1], "youtube:comment_sort=new");
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

test("isYouTubeUrl takes YouTube's hosts only", () => {
  for (const u of ["https://youtu.be/abc", "https://www.youtube.com/watch?v=abc", "https://m.youtube.com/watch?v=abc", "https://music.youtube.com/watch?v=abc", "http://youtube.com/watch?v=abc"]) assert.ok(isYouTubeUrl(u), u);
  for (const u of ["https://vimeo.com/1", "https://youtube.com.evil.test/watch", "ftp://youtu.be/abc", "-x", "u"]) assert.ok(!isYouTubeUrl(u), u);
});

test("isYouTubeUrl takes one video's address, never a channel or playlist that yt-dlp would walk", () => {
  for (const u of ["https://www.youtube.com/shorts/abc_-1", "https://www.youtube.com/live/abc", "https://www.youtube.com/watch?v=abc&list=PLx", "https://youtu.be/abc?t=5"]) assert.ok(isYouTubeUrl(u), u);
  for (const u of [
    "https://www.youtube.com/@somechannel", "https://www.youtube.com/@somechannel/videos", "https://www.youtube.com/channel/UCx",
    "https://www.youtube.com/playlist?list=PLx", "https://www.youtube.com/watch", "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/", "https://youtu.be/", "https://youtu.be/a/b", "https://www.youtube.com/shorts/",
  ]) assert.ok(!isYouTubeUrl(u), u);
});

test("reportedTotal reads yt-dlp's estimate line, or nothing", () => {
  assert.equal(reportedTotal("[youtube] Downloading ~1,097 comments\n"), "~1,097");
  assert.equal(reportedTotal("no such line"), "");
});

test("fetchTranscript: no track is a note, not a failure", async () => {
  const r = await fetchTranscript({}, "de", { fetch: () => assert.fail("no fetch without a track") });
  assert.deepEqual(r, { transcript: [], note: 'YouTube lists no captions in "de" for this video.', failed: false });
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
  // JSON that isn't a caption file (no events list) is a failure, not an empty track
  for (const body of ["null", "{}", '{"events":"x"}']) {
    const r = await fetchTranscript(infoWithAuto, "en", { fetch: async () => reply(200, body) });
    assert.equal(r.failed, true, body);
    assert.match(r.note, /isn't a caption file/);
  }
  const broke = await fetchTranscript(infoWithAuto, "en", { fetch: async () => ({ ok: true, status: 200, text: async () => { throw new Error("aborted"); } }) });
  assert.equal(broke.failed, true);
  assert.match(broke.note, /broke off \(aborted\)/);
  // a real track that is simply empty is not a failure
  const empty = await fetchTranscript(infoWithAuto, "en", { fetch: async () => reply(200, '{"events":[]}') });
  assert.deepEqual([empty.failed, empty.note], [false, "The caption track was empty."]);
});

test("fetchTranscript: a json3 body becomes rows with the track's kind", async () => {
  const r = await fetchTranscript(infoWithAuto, "en", {
    fetch: async (url) => { assert.equal(url, "https://y.test/c?lang=en"); return reply(200, JSON.stringify({ events: [{ tStartMs: 5000, segs: [{ utf8: "hi" }] }] })); },
  });
  assert.deepEqual(r, { transcript: [{ time: "0:05", text: "hi" }], kind: "auto", note: "", failed: false });
});

test("extractFromInfo assembles v1 with the CLI's metadata and notes", async () => {
  const { extract, partial } = await extractFromInfo({
    ...infoWithAuto,
    id: "vid", title: "T", uploader: "U",
    comments: [{ id: "A", parent: "root", author: "@a", text: "t", like_count: 1 }, { id: "Q.1", parent: "Q", author: "@o", text: "orphan" }],
  }, { lang: "en", log: "Downloading ~3 comments", fetch: async () => reply(429, ""), extractedAt: "2026-01-01T00:00:00Z" });
  assert.equal(partial, true);
  const m = extract.metadata;
  assert.equal(m.channel, "U");
  assert.equal(m.url, "https://www.youtube.com/watch?v=vid");
  assert.equal(m.total_comments_reported, "~3");
  assert.equal(m.source, "leket-cli/yt-dlp");
  assert.equal(m.transcript_language, "en");
  assert.equal(m.transcript_kind, "auto");
  // a regional manual track records its own key as the language
  const us = await extractFromInfo({ subtitles: { "en-US": [{ ext: "json3", url: "https://y.test/us" }] }, comments: [] }, {
    lang: "en", fetch: async () => reply(200, JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "hi" }] }] })),
  });
  assert.deepEqual([us.extract.metadata.transcript_language, us.extract.metadata.transcript_kind], ["en-US", "manual"]);
  assert.match(m.transcript_note, /429/);
  assert.equal(m.comments_note, "1 replies whose thread wasn't fetched were left out.");
  assert.equal(extract.comments.length, 1);
});

test("extractFromInfo: a nonzero yt-dlp exit is partial, with a note, even when captions came", async () => {
  const { extract, partial } = await extractFromInfo({ comments: [] }, { ytDlpExit: 1, fetch: () => assert.fail("no track, no fetch") });
  assert.equal(partial, true);
  assert.match(extract.metadata.comments_note, /^yt-dlp exited 1 after writing the video info/);
  const ok = await extractFromInfo({ comments: [] }, {});
  assert.equal(ok.partial, false);
});

const STEM = "a-synthetic-test-video-fakeVid0001-transcript-comments";
const VIDEO = "https://www.youtube.com/watch?v=fakeVid0001";

function runBin(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, LEKET_YTDLP: FAKE, ...env } });
}

test("leket youtube saves the json and md and exits 0 when the video has no captions", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const r = runBin(["youtube", VIDEO, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(out).sort(), [`${STEM}.json`, `${STEM}.md`]);
    assert.equal(r.stdout.trim().split("\n").length, 2);
    const x = JSON.parse(readFileSync(join(out, `${STEM}.json`), "utf8"));
    assert.equal(x.schema, "youtube-extract/v1");
    assert.equal(x.metadata.total_comments_reported, "~5");
    assert.deepEqual(x.comments.map((c) => [c.author, c.replies.length]), [["@gamma", 0], ["@alpha", 1]]);
    assert.match(x.metadata.transcript_note, /no captions in "en"/);
    assert.match(readFileSync(join(out, `${STEM}.md`), "utf8"), /Comments captured:\*\* 2 top-level \+ 1 replies/);
    assert.match(r.stderr, /0 transcript segments, 2 comments \+ 1 replies \(YouTube reports ~5\)/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("leket youtube exits 1 and writes nothing when yt-dlp fails", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const r = runBin(["youtube", VIDEO, "--out", out], { FAKE_YTDLP_MODE: "fail" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exited 1 and wrote no readable video info; nothing saved/);
    assert.deepEqual(readdirSync(out), []);
    const n = runBin(["youtube", VIDEO, "--out", out], { FAKE_YTDLP_MODE: "null" });
    assert.equal(n.status, 1);
    assert.match(n.stderr, /finished and wrote no readable video info/);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("leket youtube saves and exits 3 when yt-dlp stops partway after writing the info", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const r = runBin(["youtube", VIDEO, "--out", out], { FAKE_YTDLP_MODE: "partial" });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /comments: yt-dlp exited 1 after writing the video info/);
    const x = JSON.parse(readFileSync(join(out, `${STEM}.json`), "utf8"));
    assert.equal(x.comments.length, 2);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("leket youtube hands --lang and --max-comments through to yt-dlp and the caption pick", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const argsFile = join(out, "args.json");
    const r = runBin(["youtube", VIDEO, "--out", out, "--lang", "de", "--max-comments", "7"], { FAKE_YTDLP_ARGS: argsFile });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.equal(a[a.indexOf("--extractor-args") + 1], "youtube:max_comments=7,all,all,all;comment_sort=top");
    assert.deepEqual(a.slice(-2), ["--", VIDEO]);
    assert.match(r.stderr, /no captions in "de"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("leket youtube: yt-dlp missing, too old, killed, or handing back a playlist", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const missing = runBin(["youtube", VIDEO, "--out", out], { LEKET_YTDLP: join(out, "no-such-yt-dlp") });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /yt-dlp could not start and wrote no readable video info/);
    const old = runBin(["youtube", VIDEO, "--out", out], { FAKE_YTDLP_MODE: "old" });
    assert.equal(old.status, 1);
    assert.match(old.stderr, /too old to know --js-runtimes; update it/);
    const playlist = runBin(["youtube", VIDEO, "--out", out], { FAKE_YTDLP_MODE: "playlist" });
    assert.equal(playlist.status, 1);
    assert.match(playlist.stderr, /wrote a playlist, not one video; nothing saved/);
    assert.deepEqual(readdirSync(out), []);
    // a signal is a stop, not a clean finish: saved, but exit 3
    const killed = runBin(["youtube", VIDEO, "--out", out], { FAKE_YTDLP_MODE: "kill" });
    assert.equal(killed.status, 3, killed.stderr);
    assert.match(killed.stderr, /comments: yt-dlp exited 1 after writing the video info/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("leket youtube: when the .md can't be written, the .json is kept and the exit is 3; no temp files stay", () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    mkdirSync(join(out, `${STEM}.md`)); // a directory where the .md goes: its rename fails
    const r = runBin(["youtube", VIDEO, "--out", out]);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /but the \.md couldn't be written/);
    assert.equal(r.stdout, join(out, `${STEM}.json`) + "\n");
    assert.deepEqual(readdirSync(out).sort(), [`${STEM}.json`, `${STEM}.md`]);
    assert.equal(JSON.parse(readFileSync(join(out, `${STEM}.json`), "utf8")).schema, "youtube-extract/v1");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("writePair: a failed write replaces nothing and leaves no temp files", async () => {
  const out = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const base = join(out, "x");
    writeFileSync(`${base}.json`, "old");
    mkdirSync(`${base}.json.leket-tmp-${process.pid}`); // the temp write fails
    const r = await writePair(base, "new", "md");
    assert.equal(r.saved, "none");
    assert.equal(readFileSync(`${base}.json`, "utf8"), "old");
    assert.deepEqual(readdirSync(out).sort(), ["x.json", `x.json.leket-tmp-${process.pid}`]);
    rmSync(`${base}.json.leket-tmp-${process.pid}`, { recursive: true });
    assert.deepEqual(await writePair(base, "new", "md"), { saved: "both", error: "" });
    assert.deepEqual(readdirSync(out).sort(), ["x.json", "x.md"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("leket runs through a symlink, the way npm link puts it on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "leket-cli-test-"));
  try {
    const link = join(dir, "leket");
    symlinkSync(BIN, link);
    const r = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: leket youtube/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage errors exit 2; --help exits 0 on stdout", () => {
  assert.equal(runBin([]).status, 2);
  assert.equal(runBin(["vimeo", VIDEO]).status, 2);
  assert.equal(runBin(["youtube"]).status, 2);
  const notYt = runBin(["youtube", "https://vimeo.com/1"]);
  assert.equal(notYt.status, 2);
  assert.match(notYt.stderr, /YouTube video address/);
  const max = runBin(["youtube", VIDEO, "--max-comments", "0"]);
  assert.equal(max.status, 2);
  assert.match(max.stderr, /--max-comments takes/);
  const lang = runBin(["youtube", VIDEO, "--lang", "en;rm"]);
  assert.equal(lang.status, 2);
  assert.match(lang.stderr, /--lang takes/);
  assert.equal(runBin(["youtube", VIDEO, "--bogus"]).status, 2);
  const h = runBin(["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^usage: leket youtube/);
});
