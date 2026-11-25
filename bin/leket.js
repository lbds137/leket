#!/usr/bin/env node
// leket — the extension's saves from a shell, for when there is no toolbar to click.
// One backend so far: `leket youtube <url>` saves a video's captions and its comments
// (replies included) through yt-dlp, as the same youtube-extract/v1 JSON and Markdown
// the extension writes (src/modules/youtube/extract.js builds both).
//
// The run is two independent fetches, so one failing never discards the other:
//   1. yt-dlp writes the video's info.json with its comments (no media download);
//   2. this script fetches the chosen caption track's json3 itself, from the URL that
//      info.json lists.
// Exit codes: 0 saved (an empty transcript with a note means the video has no captions
// in that language); 1 nothing saved; 2 usage; 3 saved, but the caption fetch failed
// (the note says why; comments and metadata are complete).
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  buildExtract, renderMarkdown, baseName, json3ToTranscript, pickCaptionTrack, threadsFromYtDlp,
} from "../src/modules/youtube/extract.js";

const USAGE = `usage: leket youtube <video-url> [--out DIR] [--lang CODE] [--max-comments N]

  Saves <title>-transcript-comments.json (youtube-extract/v1) and .md into DIR
  (default: the current directory).
  --lang CODE        caption language (default en): a manual track first, then auto
  --max-comments N   stop after N comments, replies included (default: all)

  yt-dlp: $LEKET_YTDLP if set (a path), else yt-dlp on PATH, else uvx.
  Exit: 0 saved; 1 failed; 2 usage; 3 saved without captions (fetch refused; see note).`;

// How to run yt-dlp: an explicit path, one on PATH, or uvx (with curl_cffi, which
// YouTube's extractor asks for to impersonate a browser).
export function ytDlpCommand(env = process.env, probe = spawnSync) {
  if (env.LEKET_YTDLP) return { cmd: env.LEKET_YTDLP, pre: [] };
  const onPath = probe("yt-dlp", ["--version"], { stdio: "ignore" });
  if (!onPath.error && onPath.status === 0) return { cmd: "yt-dlp", pre: [] };
  return { cmd: "uvx", pre: ["--with", "curl_cffi", "yt-dlp"] };
}

// yt-dlp's arguments for step 1. YouTube's player needs a JS runtime to solve its
// challenge, and yt-dlp enables only deno by default: hand it this node.
export function ytDlpArgs(url, dir, { maxComments } = {}) {
  const ex = ["comment_sort=top"];
  if (maxComments) ex.unshift(`max_comments=${maxComments},all,all,all`);
  return [
    "--js-runtimes", `node:${process.execPath}`,
    "--skip-download", "--ignore-no-formats-error", "--no-playlist",
    "--write-info-json", "--write-comments",
    "--extractor-args", `youtube:${ex.join(";")}`,
    "-o", join(dir, "video.%(ext)s"),
    "--", url,
  ];
}

// yt-dlp overwrites comment_count with the number it extracted, so the total YouTube
// reports survives only in its log line "Downloading ~97 comments".
export function reportedTotal(log) {
  const m = /Downloading ~([\d,]+) comments/.exec(log || "");
  return m ? `~${m[1]}` : "";
}

function run(cmd, args) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; process.stderr.write(d); });
    child.on("error", (e) => res({ code: 127, log: `${log}${e.message}\n` }));
    child.on("close", (code) => res({ code, log }));
  });
}

// Step 2: the caption track, fetched here. Returns {transcript, kind, note, failed}.
export async function fetchTranscript(info, lang, { fetch: doFetch = fetch } = {}) {
  const track = pickCaptionTrack(info, lang);
  if (!track) {
    return { transcript: [], note: `This video has no captions in "${lang}".`, failed: false };
  }
  let r;
  try {
    r = await doFetch(track.url, { signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    return { transcript: [], kind: track.kind, note: `Couldn't reach YouTube for the captions (${(e && e.message) || e}); run again later.`, failed: true };
  }
  if (!r.ok) {
    const why = r.status === 429
      ? "YouTube refused the caption request (HTTP 429: it has rate-limited captions for this network)"
      : `YouTube answered ${r.status} to the caption request`;
    return { transcript: [], kind: track.kind, note: `${why}; the comments are saved. Run again later, or save from the browser with the Leket extension.`, failed: true };
  }
  let body;
  try {
    body = JSON.parse(await r.text());
  } catch {
    return { transcript: [], kind: track.kind, note: "YouTube answered the caption request with something that isn't a caption file.", failed: true };
  }
  const transcript = json3ToTranscript(body);
  return { transcript, kind: track.kind, note: transcript.length ? "" : "The caption track was empty.", failed: false };
}

// Steps 1 and 2 → the v1 object, given an info.json already read.
export async function extractFromInfo(info, { lang = "en", log = "", fetch: doFetch, extractedAt } = {}) {
  const { threads, droppedReplies } = threadsFromYtDlp(info.comments);
  const cap = await fetchTranscript(info, lang, { fetch: doFetch });
  const notes = [];
  if (!Array.isArray(info.comments)) notes.push("yt-dlp returned no comment list (comments may be off for this video).");
  if (droppedReplies) notes.push(`${droppedReplies} replies whose thread wasn't fetched were left out.`);
  const extract = buildExtract({
    extractedAt,
    metadata: {
      title: info.title,
      channel: info.channel || info.uploader,
      url: info.webpage_url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : ""),
      total_comments_reported: reportedTotal(log),
      source: "leket-cli/yt-dlp",
      video_id: info.id,
      transcript_language: cap.kind ? lang : "",
      transcript_kind: cap.kind,
      transcript_note: cap.note,
      comments_note: notes.join(" "),
    },
    transcript: cap.transcript,
    comments: threads,
  });
  return { extract, captionsFailed: cap.failed };
}

export async function youtube(url, { out = ".", lang = "en", maxComments } = {}) {
  const yt = ytDlpCommand();
  const work = await mkdtemp(join(tmpdir(), "leket-yt-"));
  try {
    const { code, log } = await run(yt.cmd, [...yt.pre, ...ytDlpArgs(url, work, { maxComments })]);
    let info;
    try {
      info = JSON.parse(await readFile(join(work, "video.info.json"), "utf8"));
    } catch {
      process.stderr.write(`leket: yt-dlp ${code === 127 ? "could not start" : `exited ${code}`} and wrote no video info; nothing saved.\n`);
      return 1;
    }
    const { extract, captionsFailed } = await extractFromInfo(info, { lang, log });
    const dir = resolve(out);
    await mkdir(dir, { recursive: true });
    const base = join(dir, `${baseName(extract.metadata.title)}-transcript-comments`);
    await writeFile(`${base}.json`, `${JSON.stringify(extract, null, 2)}\n`);
    await writeFile(`${base}.md`, renderMarkdown(extract));
    const m = extract.metadata;
    const replies = extract.comments.reduce((n, c) => n + c.replies.length, 0);
    process.stdout.write(`${base}.json\n${base}.md\n`);
    process.stderr.write(`leket: ${m.transcript_segment_count} transcript segments, ${m.comments_captured} comments + ${replies} replies${m.total_comments_reported ? ` (YouTube reports ${m.total_comments_reported})` : ""}.\n`);
    if (m.transcript_note) process.stderr.write(`leket: transcript: ${m.transcript_note}\n`);
    if (m.comments_note) process.stderr.write(`leket: comments: ${m.comments_note}\n`);
    return captionsFailed ? 3 : 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "-h" || sub === "--help") { process.stdout.write(`${USAGE}\n`); return 0; }
  if (sub !== "youtube") { process.stderr.write(`${USAGE}\n`); return 2; }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string" }, lang: { type: "string" }, "max-comments": { type: "string" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  if (positionals.length !== 1) { process.stderr.write(`${USAGE}\n`); return 2; }
  const max = v["max-comments"];
  if (max !== undefined && !/^[1-9]\d*$/.test(max)) {
    process.stderr.write("leket: --max-comments takes a whole number above 0\n");
    return 2;
  }
  if (v.lang !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(v.lang)) {
    process.stderr.write("leket: --lang takes a language code such as en or pt-BR\n");
    return 2;
  }
  return youtube(positionals[0], { out: v.out, lang: v.lang, maxComments: max });
}

// run as a program, including through a symlink on PATH (argv[1] is then the link)
const invokedAs = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ""; } })();
if (import.meta.url === invokedAs) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`leket: ${(e && e.stack) || e}\n`);
    process.exitCode = 1;
  });
}
