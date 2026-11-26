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
// in that language); 1 nothing saved; 2 usage; 3 saved but incomplete: the caption
// fetch failed, yt-dlp stopped partway after writing the video info, or only the .json
// could be written (the notes in the files and on stderr say which).
import { spawn, spawnSync } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile, rename, rm, rmdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  buildExtract, renderMarkdown, baseName, json3ToTranscript, pickCaptionTrack, threadsFromYtDlp,
} from "../src/modules/youtube/extract.js";

const USAGE = `usage: leket youtube <video-url> [--out DIR] [--lang CODE] [--max-comments N]

  Saves <title>-<video id>-transcript-comments.json (youtube-extract/v1) and .md
  into DIR (default: the current directory), replacing an earlier save of the video.
  --lang CODE        caption language (default en): a manual track (en, else a regional
                     one such as en-US), then auto
  --max-comments N   fetch up to N comments, replies included, in YouTube's top order
                     (it can skip fresh unliked ones); without it, every comment
                     YouTube serves, fetched newest first

  yt-dlp: $LEKET_YTDLP if set (a path), else yt-dlp on PATH, else uvx. It needs a
  release that knows --js-runtimes.
  Exit: 0 saved; 1 nothing saved; 2 usage; 3 saved but incomplete (captions refused,
  yt-dlp stopped partway, or only the .json written; the notes say which).`;

// How to run yt-dlp: an explicit path, one on PATH, or uvx (with curl_cffi, which
// YouTube's extractor asks for to impersonate a browser).
export function ytDlpCommand(env = process.env, probe = spawnSync) {
  if (env.LEKET_YTDLP) return { cmd: env.LEKET_YTDLP, pre: [] };
  const onPath = probe("yt-dlp", ["--version"], { stdio: "ignore", timeout: 15_000 });
  if (!onPath.error && onPath.status === 0) return { cmd: "yt-dlp", pre: [] };
  return { cmd: "uvx", pre: ["--with", "curl_cffi", "yt-dlp"] };
}

// A YouTube VIDEO address over http(s): youtu.be/<id>, or youtube.com (www, m, music)
// /watch?v=<id>, /shorts/<id> or /live/<id>. A channel or playlist address would make
// yt-dlp walk every video in it, comments and all, for hours; yt-dlp would also take
// any of its thousand other sites. This subcommand saves one YouTube video.
export function isYouTubeUrl(s) {
  let u;
  try { u = new URL(s); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const id = /^[A-Za-z0-9_-]+$/;
  if (u.hostname === "youtu.be") return id.test(u.pathname.slice(1));
  if (!/^((www|m|music)\.)?youtube\.com$/.test(u.hostname)) return false;
  if (u.pathname === "/watch") return id.test(u.searchParams.get("v") || "");
  const m = /^\/(shorts|live)\/([^/]+)\/?$/.exec(u.pathname);
  return !!m && id.test(m[2]);
}

// yt-dlp's arguments for step 1. YouTube's player needs a JS runtime to solve its
// challenge, and yt-dlp enables only deno by default: hand it this node. Its own
// config files are ignored, so a personal -o or format setting can't move the output.
// YouTube's top order can leave out fresh comments with no likes that newest order
// returns, so an uncapped save asks for newest. A capped save keeps YouTube's top
// selection. Either way the saved file is sorted by likes (equal counts keep fetch order).
export function ytDlpArgs(url, dir, { maxComments } = {}) {
  const ex = [maxComments ? "comment_sort=top" : "comment_sort=new"];
  if (maxComments) ex.unshift(`max_comments=${maxComments},all,all,all`);
  return [
    "--ignore-config",
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
const ESTIMATE = /Downloading ~([\d,]+) comments/;
const TOO_OLD = /no such option: --js-runtimes/;
export function reportedTotal(log) {
  const m = ESTIMATE.exec(log || "");
  return m ? `~${m[1]}` : "";
}

// Collects, from a stream of chunks, only the lines that match `keep`: a long comment
// fetch logs a line per page, and only the estimate and the too-old error are read back.
// Lines end at \n or \r; an unended line over 64 KB keeps only its last 1 KB, and
// its match, when it has one, is kept first. A cut line records one match at most:
// its first, which is all the readers above use. A match that began more than 1 KB
// before a cut is lost; neither pattern comes near that long. `keep` must not be a g
// or y regex.
export function lineKeeper(keep = new RegExp(`${ESTIMATE.source}|${TOO_OLD.source}`)) {
  let partial = "";
  let kept = "";
  let hit = false; // the unended line was cut and its match already recorded
  return {
    push(chunk) {
      const lines = (partial + chunk).split(/\r\n|\r|\n/);
      partial = lines.pop();
      lines.forEach((l, i) => { if (!(i === 0 && hit) && keep.test(l)) kept += `${l}\n`; });
      if (lines.length) hit = false;
      if (partial.length > 65_536) {
        const m = hit ? null : keep.exec(partial);
        if (m) { kept += `${m[0]}\n`; hit = true; }
        partial = partial.slice(-1024);
      }
    },
    end() {
      if (partial && !hit && keep.test(partial)) kept += `${partial}\n`;
      partial = "";
      hit = false;
      return kept;
    },
  };
}

// yt-dlp's progress goes to `tee` (stderr) as it comes, both streams of it: this
// script's stdout carries only the saved paths.
export function run(cmd, args, tee = process.stderr) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    // decoded per stream, so a character split across two chunks arrives whole
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const out = lineKeeper();
    const err = lineKeeper();
    child.stdout.on("data", (d) => { out.push(d); tee.write(d); });
    child.stderr.on("data", (d) => { err.push(d); tee.write(d); });
    const log = () => out.end() + err.end();
    child.on("error", (e) => res({ code: 127, log: `${log()}${e.message}\n` }));
    // a child killed by a signal closes with code null: that is a stop, never a clean run
    child.on("close", (code, signal) => res({ code: code ?? 1, signal, log: log() }));
  });
}

// Step 2: the caption track, fetched here. Returns {transcript, kind, language, note,
// failed}; kind and language (the track's own key, en-US when a regional track stood
// in for en) only when a track was picked.
export async function fetchTranscript(info, lang, { fetch: doFetch = fetch } = {}) {
  const track = pickCaptionTrack(info, lang);
  if (!track) {
    return { transcript: [], note: `YouTube lists no captions in "${lang}" for this video.`, failed: false };
  }
  const fail = (note) => ({ transcript: [], kind: track.kind, language: track.language, note, failed: true });
  let r;
  try {
    r = await doFetch(track.url, { signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    return fail(`Couldn't reach YouTube for the captions (${(e && e.message) || e}); run again later.`);
  }
  if (!r.ok) {
    const why = r.status === 429
      ? "YouTube refused the caption request (HTTP 429: it has rate-limited captions for this network)"
      : `YouTube answered ${r.status} to the caption request`;
    return fail(`${why}; the comments are saved. Run again later, or save from the browser with the Leket extension.`);
  }
  let raw;
  try {
    raw = await r.text();
  } catch (e) {
    return fail(`The caption download broke off (${(e && e.message) || e}); run again later.`);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.events)) {
    return fail("YouTube answered the caption request with something that isn't a caption file.");
  }
  const transcript = json3ToTranscript(body);
  return { transcript, kind: track.kind, language: track.language, note: transcript.length ? "" : "The caption track was empty.", failed: false };
}

// Steps 1 and 2 → the v1 object, given an info.json already read.
// ytDlpExit: yt-dlp's exit code; nonzero with an info.json written means it stopped
// partway (the comments especially may be cut short), which the notes and exit 3 say.
// ytDlpSignal: the signal that stopped it, when one did (its exit code is then 1).
export async function extractFromInfo(info, { lang = "en", log = "", ytDlpExit = 0, ytDlpSignal, fetch: doFetch, extractedAt } = {}) {
  const { threads, droppedReplies } = threadsFromYtDlp(info.comments);
  const cap = await fetchTranscript(info, lang, { fetch: doFetch });
  const notes = [];
  if (ytDlpExit) {
    const how = ytDlpSignal ? `was stopped (${ytDlpSignal})` : `exited ${ytDlpExit}`;
    notes.push(`yt-dlp ${how} after writing the video info, so the comments may be incomplete.`);
  }
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
      transcript_language: cap.language || "",
      transcript_kind: cap.kind,
      transcript_note: cap.note,
      comments_note: notes.join(" "),
    },
    transcript: cap.transcript,
    comments: threads,
  });
  return { extract, partial: cap.failed || !!ytDlpExit };
}

// Writes <base>.json and <base>.md through temp files renamed into place, so a failed
// write (disk full, permissions) never leaves a half-written file or a new .json beside
// an old .md unannounced. Returns {saved: "both" | "json" | "none", error}: the .json
// is renamed first, so "json" is the only partial outcome.
export async function writePair(base, json, md) {
  const tmp = (ext) => `${base}.${ext}.leket-tmp-${process.pid}`;
  const why = (e) => (e && e.code) || (e && e.message) || String(e);
  // cleanup is best effort: its own failure must not hide the write error being reported
  const drop = (p) => rm(p, { force: true }).catch(() => {});
  try {
    await writeFile(tmp("json"), json);
    await writeFile(tmp("md"), md);
    await rename(tmp("json"), `${base}.json`);
  } catch (e) {
    await Promise.all([drop(tmp("json")), drop(tmp("md"))]);
    return { saved: "none", error: why(e) };
  }
  try {
    await rename(tmp("md"), `${base}.md`);
  } catch (e) {
    await drop(tmp("md"));
    return { saved: "json", error: why(e) };
  }
  return { saved: "both", error: "" };
}

export async function youtube(url, { out = ".", lang = "en", maxComments } = {}) {
  // the output folder is made and checked writable before yt-dlp runs, so a bad --out
  // fails at once rather than after a long comment fetch
  const dir = resolve(out);
  // the first folder this run made on the way to dir (mkdir returns it), if any: a run
  // that ends with nothing saved removes those folders again, deepest first
  let made;
  const unmake = async () => {
    if (!made) return;
    // rmdir refuses a folder with anything in it, so a folder holding files stays; the
    // walk ends at the first folder this run made, and is bounded by the levels between
    const levels = relative(made, dir).split(sep).filter(Boolean).length;
    let p = dir;
    for (let i = 0; i <= levels; i++) {
      try { await rmdir(p); } catch { return; }
      if (p === made || dirname(p) === p) return;
      p = dirname(p);
    }
  };
  let code = 1;
  try {
    try {
      made = await mkdir(dir, { recursive: true });
      // on Windows, W_OK reads only the read-only attribute; a write refused later is
      // still reported, by writePair
      await access(dir, constants.W_OK);
    } catch (e) {
      const blocked = e && (e.code === "EEXIST" || e.code === "ENOTDIR");
      const why = blocked ? "a file is in the way" : (e && e.code) || (e && e.message) || String(e);
      process.stderr.write(`leket: can't save into ${dir} (${why}); nothing saved.\n`);
      return code;
    }
    code = await saveInto(dir, url, { lang, maxComments });
    return code;
  } finally {
    if (code === 1) await unmake();
  }
}

// yt-dlp, then the files, into a folder that exists: an exit code as youtube() returns.
async function saveInto(dir, url, { lang, maxComments }) {
  const yt = ytDlpCommand();
  const work = await mkdtemp(join(tmpdir(), "leket-yt-"));
  try {
    const { code, signal, log } = await run(yt.cmd, [...yt.pre, ...ytDlpArgs(url, work, { maxComments })]);
    if (code && TOO_OLD.test(log)) {
      process.stderr.write("leket: this yt-dlp is too old to know --js-runtimes; update it (yt-dlp -U, or your package manager), or unset LEKET_YTDLP to use uvx's.\n");
    }
    let info = null;
    try {
      info = JSON.parse(await readFile(join(work, "video.info.json"), "utf8"));
    } catch { /* reported below */ }
    if (!info || typeof info !== "object" || Array.isArray(info) || info._type === "playlist") {
      const how = code === 127 ? "could not start" : signal ? `was stopped (${signal})` : code ? `exited ${code}` : "finished";
      const what = info && info._type === "playlist" ? "a playlist, not one video" : "no readable video info";
      process.stderr.write(`leket: yt-dlp ${how} and wrote ${what}; nothing saved.\n`);
      return 1;
    }
    const { extract, partial } = await extractFromInfo(info, { lang, log, ytDlpExit: code, ytDlpSignal: signal });
    // both files are rendered before either is written, so a render error saves nothing
    const json = `${JSON.stringify(extract, null, 2)}\n`;
    const md = renderMarkdown(extract);
    const base = join(dir, `${baseName(extract.metadata.title, extract.metadata.video_id)}-transcript-comments`);
    const { saved, error } = await writePair(base, json, md);
    if (saved !== "both") {
      process.stderr.write(saved === "json"
        ? `leket: saved ${base}.json, but the .md couldn't be written (${error}); any .md there is from an earlier save.\n`
        : `leket: couldn't write the files (${error}); nothing saved, an earlier save is untouched.\n`);
      if (saved === "none") return 1;
    }
    const m = extract.metadata;
    const replies = extract.comments.reduce((n, c) => n + c.replies.length, 0);
    process.stdout.write(saved === "both" ? `${base}.json\n${base}.md\n` : `${base}.json\n`);
    process.stderr.write(`leket: ${m.transcript_segment_count} transcript segments, ${m.comments_captured} comments + ${replies} replies${m.total_comments_reported ? ` (YouTube reports ${m.total_comments_reported})` : ""}.\n`);
    if (m.transcript_note) process.stderr.write(`leket: transcript: ${m.transcript_note}\n`);
    if (m.comments_note) process.stderr.write(`leket: comments: ${m.comments_note}\n`);
    return partial || saved !== "both" ? 3 : 0;
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
  if (!isYouTubeUrl(positionals[0])) {
    process.stderr.write("leket: give a YouTube video address (youtube.com/watch?v=… or youtu.be/…)\n");
    return 2;
  }
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
