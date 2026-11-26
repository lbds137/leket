#!/usr/bin/env node
// leket — the extension's saves from a shell, for when there is no toolbar to click.
// `leket youtube <url>` saves a video's captions and its comments (replies included)
// through yt-dlp, as the same youtube-extract/v1 JSON and Markdown the extension writes
// (src/modules/youtube/extract.js builds both). `leket convert discord <save>…` turns
// Discord saves into Markdown transcripts (src/modules/discord/convert.js renders them;
// CONVERT_USAGE below). `leket reddit <url>` saves a post as the extension's Markdown
// (src/modules/reddit/md.js renders it; REDDIT_USAGE below). The rest of this header is
// about `leket youtube`.
//
// The run is two independent fetches, so one failing never discards the other:
//   1. yt-dlp writes the video's info.json with its comments (no media download);
//   2. this script fetches the chosen caption track's json3 itself, from the URL that
//      info.json lists.
// Exit codes: 0 saved (an empty transcript with a note means the video has no captions
// in that language); 1 nothing saved; 2 usage; 3 saved but incomplete: the caption
// fetch failed, yt-dlp stopped partway after writing the video info, or only the .json
// could be written (the notes in the files and on stderr say which).
import { constants as bufferConstants } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile, rename, rm, rmdir, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  buildExtract, renderMarkdown, baseName, json3ToTranscript, pickCaptionTrack, threadsFromYtDlp,
} from "../src/modules/youtube/extract.js";
import { mergeSaves, render as renderDiscord } from "../src/modules/discord/convert.js";
import { MANIFEST } from "../src/lib/files.js";
import { shown } from "../src/lib/shown.js";
import { readZipEntry, zipEntries } from "../src/lib/unzip.js";
import { REDDIT_IMAGES_CAP_MB, REDDIT_JSON_CAP_MB, REDDIT_MAX_IMAGES } from "../src/lib/limits.js";
import { images as redditImages, postOf, render as renderReddit } from "../src/modules/reddit/md.js";
import { fetchImageData } from "../src/modules/reddit/prepare.js";
import { guardedFetch, LEKET_UA } from "../src/lib/guarded-fetch.js";

const { MAX_STRING_LENGTH } = bufferConstants;
// a picture an earlier `leket reddit` saved: its number and one of imageFileName's extensions
const SAVED_IMAGE = /^(\d+)\.(jpe?g|png|gif|webp)$/;

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

const CONVERT_USAGE = `usage: leket convert discord <save>... [--out DIR] [--by none|year|month] [--base NAME]
         [--title TEXT] [--tz ZONE] [--name USERNAME=LABEL]... [--embeds] [--voice FILE]

  Turns saves of one Discord conversation into Markdown. A save is Leket's Discord zip
  (its first part, which holds the messages) or the JSON inside it. Several saves of the
  same conversation are merged by message id.
  Writes into DIR (default: the current directory), replacing earlier files of that name:
    NAME.md, or NAME-YYYY.md / NAME-YYYY-MM.md with --by year / month
    a server channel also gets NAME-participants.md and NAME-index.md
  --by          default: none for a DM, month for a server channel
  --base NAME   the files' name (default: the save's, e.g. discord-general-123)
  --title TEXT  the heading (default: the channel's name in the save)
  --tz ZONE     the zone times are shown in, e.g. Europe/Paris (default: this machine's)
  --name U=L    show the account with username U as L (repeatable)
  --embeds      add each message's embeds as [embed: title] at the end of its last line
  --voice FILE  machine transcripts of voice messages: JSON mapping "<message id>_<n>"
                (the n-th attachment; "<id>_f<k>_<n>" inside the k-th forward) to
                {"duration": seconds, "text": "..."}
  Exit: 0 written; 1 a save couldn't be read (nothing written) or a write failed (the
  message says how many files were written); 2 usage.`;

const REDDIT_USAGE = `usage: leket reddit <post-url> [--out DIR] [--file PATH]
       leket reddit --from-json FILE [--out DIR] [--file PATH]

  Saves a reddit post and its comment tree as Markdown, the same Markdown the
  extension's Save writes: reddit-<post id>.md in DIR (default: the current directory),
  replacing an earlier save of the post. An image post's picture and every gallery
  image go in reddit-<post id>-images/ beside it (01.jpg, 02.png… in gallery order),
  linked relatively; one that can't be saved keeps its remote link (and an earlier
  save's copy of it stays). Up to ${REDDIT_MAX_IMAGES} images, ${REDDIT_IMAGES_CAP_MB} MB in all.
  <post-url>        a post on reddit.com (www, old, new, np, m, sh, i) or redd.it, or a share link
                    (/r/SUB/s/CODE). Reddit usually refuses a logged-out fetch (HTTP
                    403): then save the post with the extension and use --from-json.
  --from-json FILE  the post's .json as the extension saves it (reddit-<id>.json)
  --file PATH       write the Markdown to PATH instead of into DIR (its images in PATH
                    minus .md, plus -images); --file - prints it and fetches no images
  Exit: 0 saved; 1 nothing saved; 2 usage; 3 saved, but some images link out (stderr
  says which and why).`;

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
// its first, which is all the readers above use. A match straddling a cut that began
// more than 1 KB before it is lost; neither pattern comes near that long. `keep` must
// not be a g or y regex.
export function lineKeeper(keep = new RegExp(`${ESTIMATE.source}|${TOO_OLD.source}`)) {
  let partial = "";
  let kept = "";
  let hit = false; // the unended line was cut and its match already recorded
  return {
    push(chunk) {
      const lines = (partial + chunk).split(/\r\n|\r|\n/);
      partial = lines.pop();
      // line 0 ends the line that was cut: when its match was recorded at the cut, the
      // tail held here would record it a second time
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
  // that ends with nothing saved removes those folders again, deepest first. Known
  // limits, both rare and harmless to saved files: a second run sharing a new --out
  // can find the folder gone if this one fails first while it is still empty (its save
  // then reports the write error); and a run killed by a signal skips `finally`, so
  // the folders it made stay.
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

// One Discord save: the JSON itself, or Leket's zip, whose top-level .json beside the
// attachments manifest is the save. Only that entry is read, never the whole zip.
// Returns { save, name } (name: the save's file name without .json).
export async function readDiscordSave(path) {
  if (!/\.zip$/i.test(path)) {
    return { save: JSON.parse(await readFile(path, "utf8")), name: basename(path).replace(/\.json$/i, "") };
  }
  const saves = (await zipEntries(path)).filter((e) => /^[^/]+\.json$/.test(e.name) && e.name !== MANIFEST);
  if (!saves.length) throw new Error(`${path} holds no Discord save (in a save split into parts, the messages are in part 1)`);
  if (saves.length > 1) throw new Error(`${path} holds ${saves.length} .json files (${saves.map((e) => shown(e.name)).join(", ")}); give the one to convert`);
  // the text has to fit in one JavaScript string; the declared size says so before any read
  if (saves[0].size > MAX_STRING_LENGTH) throw new Error(`${path}: its save ${shown(saves[0].name)} is ${Math.round(saves[0].size / 1048576)} MB, too large to read as one text`);
  return { save: JSON.parse((await readZipEntry(path, saves[0])).toString("utf8")), name: saves[0].name.replace(/\.json$/, "") };
}

export async function convertDiscord(paths, { out = ".", by, base, title, tz, names = {}, embeds = false, voice: voicePath } = {}) {
  let read, voice = {};
  try {
    read = [];
    for (const p of paths) read.push(await readDiscordSave(p));
    // the default base is the save's own name, from inside a zip: --base's rule applies to
    // it too, or a name like ..\..\x would write outside --out on Windows (and a:x into an
    // NTFS alternate stream of a, or C:x onto drive C)
    if (!base && /[/\\:]/.test(read[0].name)) {
      throw new Error(`the save in ${paths[0]} is named ${shown(JSON.stringify(read[0].name))}, which isn't a file name; give --base NAME`);
    }
    if (voicePath) {
      try { voice = JSON.parse(await readFile(voicePath, "utf8")); } catch (e) { throw new Error(`--voice ${voicePath}: ${e.message}`); }
      const shape = `--voice ${voicePath} isn't a voice map (a JSON object of "<message id>_<n>": {"duration": seconds, "text": "..."})`;
      if (!voice || typeof voice !== "object" || Array.isArray(voice)) throw new Error(shape);
      const odd = Object.entries(voice).find(([, v]) => !v || typeof v !== "object" || !Number.isFinite(v.duration) || v.duration < 0);
      if (odd) throw new Error(`${shape}: ${shown(odd[0])} has no duration in seconds (a number, 0 or more)`);
    }
  } catch (e) {
    process.stderr.write(`leket: ${e.message}; nothing written.\n`);
    return 1;
  }
  let files, conv;
  const timeZone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    conv = mergeSaves(read.map((r) => r.save));
    // every file is rendered before any is written, so a render error writes nothing
    files = renderDiscord(conv, { base: base || read[0].name, by, title, timeZone, names, embeds, voice });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}; nothing written.\n`);
    return 1;
  }
  try {
    await mkdir(out, { recursive: true });
  } catch (e) {
    process.stderr.write(`leket: couldn't make the folder ${out} (${e.message}); nothing written.\n`);
    return 1;
  }
  let written = 0;
  try {
    for (const f of files) {
      const p = join(out, f.name);
      await writeFile(p, f.text);
      process.stdout.write(`${p}\n`);
      written++;
    }
  } catch (e) {
    process.stderr.write(`leket: couldn't write ${join(out, files[written].name)} (${e.message}); ${written} of ${files.length} files written.\n`);
    return 1;
  }
  const start = conv.reachedStart ? "from its start" : conv.reachedSince ? `from ${conv.reachedSince}, as asked` : "PARTIAL: the start was not reached";
  const gaps = conv.gaps.length ? `; GAPS: ${conv.gaps.length} stretch(es) no save covers (the Source line names them)` : "";
  process.stderr.write(`leket: ${conv.messages.length} messages from ${conv.saves} save(s), ${start}${gaps}; times in ${timeZone}.\n`);
  return 0;
}

async function convertMain(rest) {
  const [kind, ...args] = rest;
  if (kind === "-h" || kind === "--help") { process.stdout.write(`${CONVERT_USAGE}\n`); return 0; }
  if (kind !== "discord") { process.stderr.write(`${CONVERT_USAGE}\n`); return 2; }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        out: { type: "string" }, by: { type: "string" }, base: { type: "string" }, title: { type: "string" },
        tz: { type: "string" }, name: { type: "string", multiple: true }, embeds: { type: "boolean" },
        voice: { type: "string" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}\n${CONVERT_USAGE}\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) { process.stdout.write(`${CONVERT_USAGE}\n`); return 0; }
  const fail = (msg) => { process.stderr.write(`leket: ${msg}\n`); return 2; };
  if (!positionals.length) { process.stderr.write(`${CONVERT_USAGE}\n`); return 2; }
  if (v.by !== undefined && !["none", "year", "month"].includes(v.by)) return fail("--by takes none, year or month");
  if (v.base !== undefined && (!v.base || /[/\\:]/.test(v.base))) return fail("--base takes a file name, not a path (no / \\ or :)");
  if (v.tz !== undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: v.tz }); } catch { return fail(`--tz: unknown time zone ${v.tz} (give one such as Europe/Paris or UTC)`); }
  }
  const names = {};
  for (const n of v.name || []) {
    const i = n.indexOf("=");
    if (i < 1) return fail(`--name takes USERNAME=LABEL, not ${n}`);
    names[n.slice(0, i)] = n.slice(i + 1);
  }
  return convertDiscord(positionals, { out: v.out, by: v.by, base: v.base, title: v.title, tz: v.tz, names, embeds: !!v.embeds, voice: v.voice });
}

// --- leket reddit

const REDDIT_HOST = /^((www|old|new|np|m|sh|i)\.)?reddit\.com$|^redd\.it$/;

// A reddit address as an https URL, or null: reddit's own hosts only, on the default
// port and with no login in it. An http address is asked over https.
export function redditUrl(s) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !REDDIT_HOST.test(u.hostname) || u.port || u.username || u.password) return null;
  u.protocol = "https:";
  return u;
}

// The post id a reddit URL names (/comments/ID/…, redd.it/ID), or null (a share link).
// The id is a whole path segment (or ID.json), never the start of a longer one.
export function redditPostId(u) {
  const m = u.hostname === "redd.it" ? /^\/([a-z0-9]+)\/?$/i.exec(u.pathname) : /\/comments\/([a-z0-9]+)(?:\/|\.json$|$)/i.exec(u.pathname);
  return m ? m[1] : null;
}

const dropBody = (r) => { if (r.body && typeof r.body.cancel === "function") r.body.cancel().catch(() => {}); };

// One GET that follows redirects by hand, only while they stay on reddit: the address
// comes from the command line, but the next hop comes from the server. With stopAtPost
// (resolving a share link), a hop that names a post ends the walk unfetched.
async function redditGet(start, doFetch, { stopAtPost = false } = {}) {
  let u = start;
  for (let hop = 0; hop <= 5; hop++) {
    let r;
    try {
      r = await doFetch(u.href, { redirect: "manual", headers: { "user-agent": LEKET_UA }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new Error(`couldn't reach reddit (${(e && e.message) || e})`);
    }
    if (r.status < 300 || r.status >= 400) return { r, url: u };
    dropBody(r);
    const loc = r.headers.get("location");
    if (!loc) throw new Error(`${u.href} answered ${r.status} without saying where to`);
    let next = null;
    try { next = redditUrl(new URL(loc, u).href); } catch { /* not an address: refused below */ }
    if (!next) throw new Error(`${u.href} redirects off reddit, to ${shown(loc)}`);
    if (stopAtPost && redditPostId(next)) return { url: next };
    u = next;
  }
  throw new Error(`${start.href} redirects more than 5 times`);
}

// The post's JSON for a reddit address: a share link is resolved first (its redirect
// names the post), then the .json is asked for logged out.
export async function fetchRedditPost(address, { fetch: doFetch = fetch } = {}) {
  const u = redditUrl(address);
  if (!u) throw new Error(`not a reddit address: ${address}`);
  let id = redditPostId(u);
  if (!id) {
    const got = await redditGet(u, doFetch, { stopAtPost: true });
    id = redditPostId(got.url);
    if (got.r) dropBody(got.r);
    if (!id) throw new Error(`${u.href} didn't lead to a post${got.r ? ` (reddit answered ${got.r.status})` : ""}`);
  }
  const fromJson = `save the post with the Leket extension (it writes reddit-${id}.json), then run leket reddit --from-json reddit-${id}.json`;
  const { r } = await redditGet(new URL(`https://www.reddit.com/comments/${id}.json?raw_json=1&limit=500`), doFetch);
  if (!r.ok) dropBody(r);
  if (r.status === 403 || r.status === 429) throw new Error(`reddit refused a logged-out fetch (HTTP ${r.status}); ${fromJson}`);
  if (!r.ok) throw new Error(`reddit answered ${r.status} for post ${id}`);
  const text = await readCapped(r, REDDIT_JSON_CAP_MB, `reddit's answer for post ${id}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`reddit answered with a page, not the post's JSON (a login or block page?); ${fromJson}`);
  }
  // redirects stay on reddit, but the post saved must be the one asked for; data that
  // isn't a post at all goes on to saveRedditPost, which says so
  let got;
  try { got = postOf(data).id; } catch { return data; }
  if (typeof got === "string" && got.toLowerCase() !== id.toLowerCase()) {
    throw new Error(`reddit answered with post ${shown(got)}, not ${id}`);
  }
  return data;
}

// A response body as text, read in chunks and refused past capMb, so a server can't
// make the CLI hold an unbounded answer in memory.
async function readCapped(r, capMb, what) {
  const unread = (e) => new Error(`couldn't read ${what} (${shown((e && e.message) || e)})`);
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let step;
    try { step = await reader.read(); } catch (e) { throw unread(e); }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > capMb * 1048576) {
      reader.cancel().catch(() => {});
      throw new Error(`${what} is over ${capMb} MB, more than a post's JSON should be`);
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const STDIO = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

// Writes the post's Markdown (and its images, unless printing) and returns the exit
// code; `say` takes what it prints (tests pass their own: node's test runner reports
// over the real stdout). Everything is rendered once before anything is written, so
// data that isn't a post writes nothing. Images come through guardedFetch, which refuses
// a name whose DNS answer is a private address (TASK-40).
export async function saveRedditPost(data, { out, file, fetch: doFetch = guardedFetch, say = STDIO,
  caps: { images: maxImages = REDDIT_MAX_IMAGES, mb: capMb = REDDIT_IMAGES_CAP_MB } = {} } = {}) {
  let p, md;
  try {
    p = postOf(data);
    md = renderReddit(data);
  } catch (e) {
    say.err(`leket: ${shown(e.message)}; nothing written.\n`);
    return 1;
  }
  if (file === "-") { say.out(md); return 0; }
  let dest = file;
  if (dest === undefined) {
    // the id becomes a path: a crafted file must not walk out of DIR with it
    if (typeof p.id !== "string" || !/^[a-z0-9]+$/i.test(p.id)) {
      say.err(`leket: the post's id (${shown(JSON.stringify(p.id))}) isn't reddit's form; give --file PATH; nothing written.\n`);
      return 1;
    }
    dest = join(out ?? ".", `reddit-${p.id}.md`);
  }
  const folder = `${dest.replace(/\.md$/i, "")}-images`;
  // an earlier save's pictures, by number in imageFileName's exact form (01, not 1 or
  // 001): one this run saves again under another extension (01.jpg now 01.png) is
  // replaced once the .md that links the new one is written; one this run couldn't
  // fetch is kept (it may be the only copy left) and stderr says so
  let earlier = [];
  try { earlier = (await readdir(folder)).filter((f) => SAVED_IMAGE.test(f)); } catch { /* no folder yet */ }
  const earlierOf = (n) => earlier.filter((f) => SAVED_IMAGE.exec(f)[1] === String(n).padStart(2, "0"));
  const superseded = [];
  const saved = {};
  let failed = 0, fetched = 0, bytes = 0;
  for (const [n, u, , ext] of redditImages(p)) {
    if (!u) continue;
    try {
      if (fetched >= maxImages) throw new Error(`not fetched: past ${maxImages} images`);
      fetched++;
      const { blob, name } = await fetchImageData({ n, u, ext }, { fetch: doFetch });
      if (bytes + blob.size > capMb * 1048576) throw new Error(`not kept: the images would total over ${capMb} MB`);
      bytes += blob.size;
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, name), Buffer.from(await blob.arrayBuffer()));
      saved[n] = name;
      for (const old of earlierOf(n)) if (old !== name) superseded.push([n, old]);
    } catch (e) {
      failed++;
      const kept = earlierOf(n);
      say.err(`leket: couldn't save image ${n} (${shown(e.message)}); the .md links ${shown(u)}`
        + `${kept.length ? `; ${kept.join(", ")} from an earlier save stays in ${folder}` : ""}\n`);
    }
  }
  try {
    if (Object.keys(saved).length) md = renderReddit(data, saved, basename(folder));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, md);
  } catch (e) {
    say.err(`leket: couldn't write ${dest} (${shown(e.message)})${Object.keys(saved).length ? `; the images saved in ${folder} stay` : ""}.\n`);
    return 1;
  }
  // only now: had the .md failed, the earlier one still links these
  for (const [n, old] of superseded) {
    await rm(join(folder, old), { force: true })
      .catch((e) => say.err(`leket: couldn't remove ${old}, an earlier save's image ${n} (${shown(e.message)})\n`));
  }
  say.out(`${dest}\n`);
  return failed ? 3 : 0;
}

// `fetch` reaches the post's JSON only; images always go through saveRedditPost's own
// default, guardedFetch, so the DNS guard can't be swapped out from here
async function redditMain(args, { fetch: doFetch = fetch } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { out: { type: "string" }, file: { type: "string" }, "from-json": { type: "string" }, help: { type: "boolean", short: "h" } },
    });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}\n${REDDIT_USAGE}\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) { process.stdout.write(`${REDDIT_USAGE}\n`); return 0; }
  const fromJson = v["from-json"];
  if ((fromJson === undefined) === (positionals.length === 0) || positionals.length > 1) {
    process.stderr.write(`${REDDIT_USAGE}\n`);
    return 2;
  }
  const fail = (msg, code) => { process.stderr.write(`leket: ${shown(msg)}\n`); return code; };
  if (v.out !== undefined && v.file !== undefined) return fail("give --out or --file, not both", 2);
  if (v.file === "") return fail("--file takes a path (or - to print)", 2);
  if (positionals.length && !redditUrl(positionals[0])) return fail("give a reddit post address (reddit.com/r/…/comments/… or a share link), or --from-json FILE", 2);
  let data;
  if (fromJson !== undefined) {
    let text;
    try { text = await readFile(fromJson, "utf8"); } catch (e) { return fail(`couldn't read ${fromJson} (${e.message})`, 1); }
    try { data = JSON.parse(text); } catch { return fail(`${fromJson} isn't JSON`, 1); }
  } else {
    try { data = await fetchRedditPost(positionals[0], { fetch: doFetch }); } catch (e) { return fail(e.message, 1); }
  }
  return saveRedditPost(data, { out: v.out, file: v.file });
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  const all = `${USAGE}\n\n${REDDIT_USAGE}\n\n${CONVERT_USAGE}\n`;
  if (sub === "-h" || sub === "--help") { process.stdout.write(all); return 0; }
  if (sub === "convert") return convertMain(rest);
  if (sub === "reddit") return redditMain(rest);
  if (sub !== "youtube") { process.stderr.write(all); return 2; }
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
  // a reader that stops early (leket reddit --file - | head) closes the pipe: stop
  // quietly with 141, as a program killed by SIGPIPE does, instead of a stack trace. It
  // ends as usual rather than by process.exit, so cleanup in finally blocks (youtube's
  // temporary folder) still runs; writes after the close are dropped.
  let piped = false;
  process.stdout.on("error", (e) => {
    if (e.code !== "EPIPE" && !piped) throw e;
    piped = true;
    process.exitCode = 141;
  });
  main(process.argv.slice(2)).then((code) => { process.exitCode = piped ? 141 : code; }, (e) => {
    process.stderr.write(`leket: ${(e && e.stack) || e}\n`);
    process.exitCode = 1;
  });
}
