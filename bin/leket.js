#!/usr/bin/env node
// leket — the extension's saves from a shell, for when there is no toolbar to click.
// `leket youtube <url>` saves a video's captions and its comments (replies included)
// through yt-dlp, as the same youtube-extract/v1 JSON and Markdown the extension writes
// (src/modules/youtube/extract.js builds both). `leket convert discord <save>…` turns
// Discord saves into Markdown transcripts (src/modules/discord/convert.js renders them;
// CONVERT_USAGE below); `leket convert chatgpt <export>…` does the same for ChatGPT's data
// export (src/convert/chatgpt.js), and `leket convert gemini <takeout>…` for Google
// Takeout's Gemini activity (src/convert/gemini.js), and `leket convert character-chat
// <export>…` for a character-chat site's JSON export (src/convert/character-chat.js), and
// `leket convert claude-code <transcript>…` for Claude Code's session transcripts
// (src/convert/claude-code.js), and `leket convert sms <backup.xml>` for an SMS Backup &
// Restore backup (src/convert/sms.js), and `leket convert signal <export.txt>…` for
// signalbackup-tools' text export (src/convert/signal.js).
// `leket reddit <url>` saves a post as the extension's Markdown
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
import { createHash } from "node:crypto";
import { constants, createReadStream, realpathSync, writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile, rename, rm, rmdir, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  buildExtract, renderMarkdown, baseName, json3ToTranscript, pickCaptionTrack, threadsFromYtDlp,
} from "../src/modules/youtube/extract.js";
import { mergeSaves, render as renderDiscord } from "../src/modules/discord/convert.js";
import { collect as collectChatgpt, plan as planChatgpt } from "../src/convert/chatgpt.js";
import { badFolder } from "../src/convert/common.js";
import { collect as collectGemini, plan as planGemini } from "../src/convert/gemini.js";
import { collect as collectCharacterChat, plan as planCharacterChat } from "../src/convert/character-chat.js";
import { turns as claudeCodeTurns, plan as planClaudeCode } from "../src/convert/claude-code.js";
import { digits as smsDigits, keyOf as smsKey, messages as smsMessages, plan as planSms } from "../src/convert/sms.js";
import { plan as planSignal } from "../src/convert/signal.js";
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
  message says how many files were written); 2 usage.

usage: leket convert chatgpt <export>... [--out DIR] [--user LABEL] [--assistant LABEL]
         [--tz ZONE] [--folders FILE] [--unlisted FOLDER]

  Turns ChatGPT's data export into one Markdown file per conversation, following each
  conversation's current branch. An export is its folder, its zip (not zip64: over
  4 GB, unzip it and give the folder) or its conversations.json; the attachments'
  names come from conversation_asset_file_names.json beside it. With several exports,
  a later one's copy of a conversation replaces an earlier one's.
  Writes "YYYY-MM-DD Title.md" (the day it was started) into DIR (default: the current
  directory), replacing earlier files of that name; two conversations that would share
  a name get the start of their id added.
  --user LABEL       the user's messages' heading (default User)
  --assistant LABEL  the assistant's (default ChatGPT)
  --tz ZONE          the zone times are shown in, e.g. Europe/Paris (default UTC)
  --folders FILE     a tab-separated file whose header names an id and a folder column:
                     each listed conversation goes into DIR/folder
  --unlisted FOLDER  where conversations --folders doesn't list go (default: DIR)
  Exit: 0 written; 1 an export couldn't be read (nothing written) or a write failed
  (the message says how many files were written); 2 usage.

usage: leket convert gemini <takeout>... [--out DIR] [--user LABEL] [--assistant LABEL]
         [--tz ZONE] [--folders FILE] [--unlisted FOLDER] [--titles FILE] [--other FOLDER]

  Turns Google Takeout's Gemini activity ("My Activity" JSON) into one Markdown file per
  chat, Gemini's replies converted from HTML. A takeout is its folder (searched for the
  activity JSON), its zip (not zip64) or the JSON file. Several takeouts are merged: a
  row in more than one is taken from the first given, so give the oldest first and chats
  deleted since stay. Writes "YYYY-MM-DD Start of the first prompt.md" (the day it
  started) into DIR, replacing earlier files of that name; other-activity.md (rows of no
  chat) and canvases/ (Canvas documents) go into DIR too.
  --user, --assistant, --tz, --folders, --unlisted  as for chatgpt (default labels:
                     User, Gemini)
  --titles FILE      a tab-separated file whose header names an id and a title column:
                     the title shown for each listed chat (Takeout has none)
  --other FOLDER     where other-activity.md and canvases/ go (default: DIR)
  Exit: as for chatgpt.

usage: leket convert character-chat <export.json>... [--out DIR] [--user LABEL]
         [--site LABEL] [--tz ZONE]

  Turns a character-chat site's JSON export (an object with a "conversations" list, each
  with its "messages", and a "characters" map of cards) into one Markdown file per
  conversation, INDEX.md (oldest first) and CARDS.md (each character's card). With
  several exports, a conversation is taken from the copy with the most messages.
  Writes "Label.md" (or "Character YYYY-MM-DD.md" for an unlabelled one) into DIR
  (default: the current directory), replacing earlier files of that name and leaving
  other files there alone; two that would share a name get " (2)", " (3)"…
  --user LABEL  the user's messages' heading when the conversation names no persona
                (default User)
  --site LABEL  the site's name in the headings (default "Character chat")
  --tz ZONE     the zone times are shown in, e.g. Europe/Paris (default UTC)
  Exit: as for chatgpt.

usage: leket convert claude-code <transcript>... [--out DIR] [--user LABEL]
         [--assistant LABEL] [--tz ZONE] [--json]

  Turns Claude Code session transcripts (the .jsonl files under ~/.claude/projects/) into
  one Markdown file per session: the person's prompts and answers to questions, and the
  text of each reply (not tool calls or their output, not text written before a tool
  call, not subagents'). A transcript is its .jsonl file, or a folder: every .jsonl
  directly in it.
  Writes "YYYY-MM-DD Title.md" (the session's name in Claude Code, else the start of its
  first prompt) into DIR (default: the current directory), replacing earlier files of
  that name; two that would share a name get the start of the session id added.
  --user LABEL       the person's messages' heading (default User)
  --assistant LABEL  the replies' heading (default Claude)
  --tz ZONE          the zone times are shown in, e.g. Europe/Paris (default UTC)
  --json             write each session's turns as "YYYY-MM-DD Title.json" instead: id,
                     source, title, turns [{ at (the transcript's UTC time), role (user or
                     assistant), answer (true on an answer to a question), text (Markdown) }]
  Exit: as for chatgpt.

usage: leket convert sms <backup.xml> [--out DIR] [--me LABEL] [--name NUMBER=LABEL]...
         [--tz ZONE] [--number NUMBER [--title TEXT] [--base NAME]] [--groups] [--media DIR]

  Turns an SMS Backup & Restore backup (the Android app's sms-*.xml) into one Markdown
  file per conversation, SMS and MMS together, in the shape convert discord writes.
  A conversation is the other number's last 10 digits. Group MMS (more than one other
  number) are left out and counted unless --groups is given.
  Writes "sms-Name.md" into DIR (default: the current directory), replacing earlier
  files of that name; two that would share a name get the number's last digits added.
  --me LABEL      the backup owner's name in the transcripts (default Me)
  --name N=LABEL  show the number N as LABEL (repeatable; default: the backup's contact
                  name, else "…" and the number's last 4 digits)
  --tz ZONE       the zone times are shown in, e.g. Europe/Paris (default UTC)
  --number N      only the conversation with N (its last 10 digits are compared); with
                  --groups, group messages that include N go into it, marked
  --title TEXT    with --number: the heading (default "Texts with Name")
  --base NAME     with --number: the file's name (NAME.md)
  --groups        keep group MMS, each message marked with its sender and the group;
                  without --number, each group is its own conversation
  --media DIR     save MMS pictures, audio and video into DIR as they are read (named as
                  the transcript's [attachment: ...] lines name them), and list them in
                  DIR/attachments.tsv (file, size, md5). A backup that turns out unreadable
                  partway leaves the files saved before then; no transcript is written.
  Exit: 0 written; 1 the backup couldn't be read or matched no message (no transcript
  written), or a write failed (the message says how many files were written); 2 usage.

usage: leket convert signal <export.txt>... [--out DIR] [--name NAME=LABEL]... [--tz ZONE]
         [--title TEXT] [--base NAME]

  Turns signalbackup-tools' text export (--exporttxt: one "Name (_idN).txt" per
  conversation) into one Markdown file per conversation, in the shape convert discord
  writes. An export is its .txt file, or a folder: every .txt directly in it. Signal's
  own events (calls, safety number changes) are shown from "Signal".
  Writes "signal-Name.md" into DIR (default: the current directory), replacing earlier
  files of that name; two that would share a name get a count added.
  --name N=LABEL  show the display name N (as the export writes it) as LABEL
                  (repeatable; default: the name's first word)
  --tz ZONE       the zone the export's times are in, named in the transcript. The
                  export writes the exporting computer's local time with no zone, so
                  times are shown as written, never converted (default: not named)
  --title TEXT    with one export: the heading (default "Signal with Name")
  --base NAME     with one export: the file's name (NAME.md)
  Exit: 0 written; 1 an export couldn't be read, held no message or has a date that
  can't be read (nothing written), or a write failed; 2 usage.`;

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

// One ChatGPT export: its folder, its zip or its conversations.json, with the attachments'
// names (conversation_asset_file_names.json) when the export has them.
export async function readChatgptExport(path) {
  const CONVS = "conversations.json", NAMES = "conversation_asset_file_names.json";
  const parse = (text, what) => { try { return JSON.parse(text); } catch (e) { throw new Error(`${what} isn't JSON (${e.message})`); } };
  if (/\.zip$/i.test(path)) {
    const entries = await zipEntries(path);
    const pick = (want) => {
      const hits = entries.filter((e) => basename(e.name) === want);
      if (hits.length > 1) throw new Error(`${path} holds ${hits.length} files named ${want}; unzip it and give the folder of the one to convert`);
      return hits[0];
    };
    const c = pick(CONVS);
    if (!c) throw new Error(`${path} holds no ${CONVS}: not a ChatGPT export`);
    // the names file that belongs to it sits in the same folder of the zip
    const n = entries.find((e) => basename(e.name) === NAMES && dirname(e.name) === dirname(c.name));
    for (const e of [c, n]) if (e && e.size > MAX_STRING_LENGTH) throw new Error(`${path}: its ${shown(e.name)} is ${Math.round(e.size / 1048576)} MB, too large to read as one text`);
    const read = async (e) => (await readZipEntry(path, e)).toString("utf8");
    return { label: path, conversations: parse(await read(c), `${path}: ${CONVS}`), names: n ? parse(await read(n), `${path}: ${NAMES}`) : {} };
  }
  let dir = path, file = join(path, CONVS);
  try { await readdir(path); } catch (e) { if (e.code !== "ENOTDIR") throw e; dir = dirname(path); file = path; }
  const conversations = parse(await readFile(file, "utf8"), file);
  let names = {};
  try { names = parse(await readFile(join(dir, NAMES), "utf8"), join(dir, NAMES)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return { label: file, conversations, names };
}

// A tab-separated file with a header row naming an "id" column and `column` → { id: value }.
// A byte-order mark is dropped and cells are trimmed; check(value) returns why a value is
// wrong, or nothing. An id listed twice with different values is an error.
async function readIdTsv(path, flag, column, check) {
  const rows = (await readFile(path, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/);
  const head = rows.shift().split("\t").map((c) => c.trim());
  const ci = head.indexOf("id"), vi = head.indexOf(column);
  if (ci < 0 || vi < 0) throw new Error(`${flag} ${path}: its header row has no "id" and "${column}" columns (tab-separated)`);
  // no prototype: an id "__proto__" is an ordinary key
  const map = Object.create(null), at = Object.create(null);
  // blank lines are skipped in the loop, not filtered out, so k + 2 is the line number
  for (const [k, line] of rows.entries()) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    const id = (cells[ci] ?? "").trim(), value = (cells[vi] ?? "").trim();
    if (!id) continue;
    const why = check(value);
    if (why) throw new Error(`${flag} ${path}: row ${k + 2} has ${column} ${shown(JSON.stringify(value))}, ${why}`);
    if (Object.hasOwn(map, id) && map[id] !== value) throw new Error(`${flag} ${path}: rows ${at[id]} and ${k + 2} give ${shown(id)} different ${column}s`);
    map[id] = value; at[id] ??= k + 2;
  }
  return map;
}

// --folders: a tab-separated file with a header row naming an "id" and a "folder" column
export const readFolders = (path) => readIdTsv(path, "--folders", "folder",
  (f) => (badFolder(f) ? "which isn't a relative folder (no \\ : * ? \" < > |, . or .. parts, no control characters)" : ""));

// --titles: a tab-separated file with a header row naming an "id" and a "title" column
export const readTitles = (path) => readIdTsv(path, "--titles", "title", (t) => (t ? "" : "which is empty"));

export async function convertChatgpt(paths, { out = ".", user, assistant, tz = "UTC", folders: foldersPath, unlisted = "" } = {}) {
  let files;
  try {
    const exports = [];
    for (const p of paths) exports.push(await readChatgptExport(p));
    const folders = foldersPath ? await readFolders(foldersPath) : {};
    // every file is rendered before any is written, so a render error writes nothing
    files = planChatgpt(collectChatgpt(exports), { folders, unlisted, user, assistant, timeZone: tz });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}; nothing written.\n`);
    return 1;
  }
  if (!(await writeConverted(files, out))) return 1;
  const turns = files.reduce((n, f) => n + f.turns, 0);
  const empty = files.filter((f) => f.empty).length;
  const skipped = Object.create(null);
  for (const f of files) for (const [k, n] of Object.entries(f.skipped)) skipped[k] = (skipped[k] || 0) + n;
  const notShown = Object.entries(skipped).map(([k, n]) => `${shown(k)} ${n}`).join(", ");
  process.stderr.write(`leket: ${files.length} conversations${empty ? ` (${empty} with no current message, written with none)` : ""}, ${turns} messages, from ${paths.length} export(s); times in ${tz}.${notShown ? ` Not shown (no text): ${notShown}.` : ""}\n`);
  return 0;
}

// Writes planned files ({ folder, name, text }) under out, printing each path; false
// (after saying how far it got) when one can't be written.
async function writeConverted(files, out) {
  let written = 0;
  try {
    for (const f of files) {
      const dir = f.folder ? join(out, ...f.folder.split("/")) : out;
      await mkdir(dir, { recursive: true });
      const p = join(dir, f.name);
      await writeFile(p, f.text);
      process.stdout.write(`${shown(p)}\n`);
      written++;
    }
  } catch (e) {
    process.stderr.write(`leket: couldn't write ${shown(files[written].name)} (${e.message}); ${written} of ${files.length} files written.\n`);
    return false;
  }
  return true;
}

// One Gemini Takeout: its folder (searched for the activity JSON, whatever the language
// names it), its zip (not zip64) or the JSON file → [{ label, rows }], one per JSON file
// that is a list of activity rows. Other JSON files (one attached to a chat) are passed over,
// and in a folder or zip one too large to read as one text (a whole-account Takeout's
// location history) is passed over unread: its label goes into `skipped`. limit and read are
// for tests.
export async function readGeminiExport(path, { skipped = [], limit = MAX_STRING_LENGTH, read = readFile } = {}) {
  const isActivity = (x) => Array.isArray(x) && x.some((e) => e && typeof e === "object" && typeof e.time === "string" && typeof e.title === "string");
  const found = [];
  const consider = (label, text) => {
    let data;
    try { data = JSON.parse(text); } catch { return; }
    if (isActivity(data)) found.push({ label, rows: data });
  };
  const mine = []; // this export's own, for its error: `skipped` may hold earlier exports' too
  const tooLarge = (label, size) => { const s = `${label} (${Math.round(size / 1048576)} MB)`; mine.push(s); skipped.push(s); };
  if (/\.zip$/i.test(path)) {
    for (const e of (await zipEntries(path)).filter((x) => /\.json$/i.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.size > limit) { tooLarge(`${path}: ${e.name}`, e.size); continue; }
      consider(`${path}: ${e.name}`, (await readZipEntry(path, e)).toString("utf8"));
    }
  } else {
    let isDir = true;
    try { await readdir(path); } catch (e) { if (e.code !== "ENOTDIR") throw e; isDir = false; }
    if (!isDir) {
      let data;
      try { data = JSON.parse(await readFile(path, "utf8")); } catch (e) { throw new Error(`${path} isn't JSON (${e.message})`); }
      if (!isActivity(data)) throw new Error(`${path} isn't a list of Takeout activity rows`);
      return [{ label: path, rows: data }];
    }
    const walk = async (dir) => {
      for (const d of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = join(dir, d.name);
        if (d.isDirectory()) await walk(p);
        else if (d.isFile() && /\.json$/i.test(d.name)) {
          const { size } = await stat(p);
          if (size > limit) { tooLarge(p, size); continue; }
          let text;
          // bytes over-count a string's length, so a file just under the limit can still be too long
          try { text = await read(p, "utf8"); } catch (e) { if (e.code !== "ERR_STRING_TOO_LONG") throw e; tooLarge(p, size); continue; }
          consider(p, text);
        }
      }
    };
    await walk(path);
  }
  if (!found.length) throw new Error(`${path} holds no Takeout activity JSON (a list of rows with "time" and "title")${mine.length ? `; passed over as too large: ${mine.map(shown).join(", ")}` : ""}`);
  return found;
}

export async function convertGemini(paths, { out = ".", user, assistant, tz = "UTC", folders: foldersPath, titles: titlesPath, unlisted = "", other = "" } = {}) {
  let planned;
  const skipped = [];
  try {
    const snapshots = [];
    for (const p of paths) snapshots.push(...await readGeminiExport(p, { skipped }));
    const folders = foldersPath ? await readFolders(foldersPath) : {};
    const titles = titlesPath ? await readTitles(titlesPath) : {};
    const collected = collectGemini(snapshots);
    if (!collected.rows.length) throw new Error(`no Gemini rows in ${paths.length} export(s)${collected.other ? ` (${collected.other} rows of other Google products)` : ""}`);
    // every file is rendered before any is written, so a render error writes nothing
    planned = planGemini(collected, { folders, titles, unlisted, other, user, assistant, timeZone: tz });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}; nothing written.\n`);
    return 1;
  }
  if (!(await writeConverted(planned.files, out))) return 1;
  const s = planned.stats;
  const unknown = Object.entries(s.unknown).map(([k, n]) => `${shown(k)} ${n}`).join(", ");
  process.stderr.write([
    `leket: ${s.chats} chats (${s.prompts} prompts, ${s.replies} replies), ${s.loose} rows outside chats, ${s.canvases} canvases, from ${s.rows} rows in ${paths.length} export(s); times in ${tz}.`,
    s.cut ? `Replies Takeout removed text from: ${s.cut}, in ${s.cutChats} chats.` : "",
    s.short ? `Replies whose Markdown has under 98% of the HTML's letters: ${s.short}.` : "",
    unknown ? `HTML tags kept as text: ${unknown}.` : "",
    s.otherProducts ? `Rows of other Google products passed over: ${s.otherProducts}.` : "",
    skipped.length ? `JSON files passed over unread, too large to read as one text: ${skipped.map(shown).join(", ")}.` : "",
    s.unrecognised ? "No row reads as a prompt (\"Prompted …\"): is the Takeout in another language? Every row went to other-activity.md." : "",
  ].filter(Boolean).join("\n") + "\n");
  return 0;
}

// One character-chat export: a JSON file. read is for tests.
export async function readCharacterChatExport(path, { read = readFile } = {}) {
  let text;
  try { text = await read(path, "utf8"); } catch (e) {
    if (e.code === "ERR_STRING_TOO_LONG") throw new Error(`${path} is too large to read as one text`);
    throw e;
  }
  try { return { label: path, data: JSON.parse(text) }; } catch (e) { throw new Error(`${path} isn't JSON (${e.message})`); }
}

export async function convertCharacterChat(paths, { out = ".", user, site, tz = "UTC" } = {}) {
  let planned;
  try {
    const exports = [];
    for (const p of paths) exports.push(await readCharacterChatExport(p));
    // every file is rendered before any is written, so a render error writes nothing
    planned = planCharacterChat(collectCharacterChat(exports), { user, site, timeZone: tz });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}; nothing written.\n`);
    return 1;
  }
  if (!(await writeConverted(planned.files, out))) return 1;
  const s = planned.stats;
  process.stderr.write([
    `leket: ${s.conversations} conversations, ${s.messages} messages, ${s.cards} cards, from ${paths.length} export(s); times in ${tz}.`,
    s.empty ? `Conversations with no messages, left out: ${s.empty}.` : "",
    s.short ? `Conversations with fewer messages than the site counts: ${s.short}.` : "",
    s.missing ? `Characters with no card in the export (no name; left out of CARDS.md): ${s.missing}.` : "",
  ].filter(Boolean).join("\n") + "\n");
  return 0;
}

async function convertCharacterChatMain(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true,
      options: { out: { type: "string" }, user: { type: "string" }, site: { type: "string" }, tz: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}\n${CONVERT_USAGE}\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) { process.stdout.write(`${CONVERT_USAGE}\n`); return 0; }
  const fail = (msg) => { process.stderr.write(`leket: ${msg}\n`); return 2; };
  if (!positionals.length) { process.stderr.write(`${CONVERT_USAGE}\n`); return 2; }
  const bad = convertOptionError(v, ["user", "site"]);
  if (bad) return fail(bad);
  return convertCharacterChat(positionals, { out: v.out, user: v.user, site: v.site, tz: v.tz });
}

// A JSONL file's lines, read a chunk at a time. Lines end at \n only (a \r before it goes):
// readline would also end one at U+2028 and U+2029, which JSON writes raw inside a string.
async function* jsonlLines(path) {
  let pending = [];
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    let start = 0;
    for (let i = chunk.indexOf("\n"); i !== -1; i = chunk.indexOf("\n", start)) {
      pending.push(chunk.slice(start, i));
      const line = pending.join("");
      pending = [];
      start = i + 1;
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  if (pending.length) yield pending.join("");
}

// Claude Code transcripts: each a .jsonl file, or a folder whose .jsonl files (directly in
// it, not in its subfolders, where subagents' transcripts live) are each one → sessions for
// planClaudeCode, read a line at a time (a transcript can outgrow one string)
export async function readClaudeCodeSessions(paths) {
  const files = [];
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) {
      const names = (await readdir(p, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name).sort();
      if (!names.length) throw new Error(`${p} holds no .jsonl transcript`);
      files.push(...names.map((n) => join(p, n)));
    } else files.push(p);
  }
  // a transcript given twice (itself and in its folder, or by a link) is read once
  const seen = new Set();
  const sessions = [];
  for (const f of files.filter((x) => !seen.has(realpathSync(x)) && seen.add(realpathSync(x)))) {
    const t = claudeCodeTurns();
    for await (const line of jsonlLines(f)) t.feed(line);
    const s = t.end();
    sessions.push({ ...s, id: s.sessionId || basename(f).replace(/\.jsonl$/, ""), source: f });
  }
  return sessions;
}

export async function convertClaudeCode(paths, { out = ".", user, assistant, tz = "UTC", json = false } = {}) {
  let planned;
  try {
    planned = planClaudeCode(await readClaudeCodeSessions(paths), { user, assistant, timeZone: tz, json });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}; nothing written.\n`);
    return 1;
  }
  if (!(await writeConverted(planned.files, out))) return 1;
  const s = planned.stats;
  process.stderr.write([
    `leket: ${s.sessions} sessions, ${s.turns} messages; times in ${tz}.`,
    s.noPrompt ? `Sessions with no prompt typed by a person (scheduled or headless runs), left out: ${s.noPrompt}.` : "",
    s.noOrigin ? `Sessions left out because no prompt in them says who typed it (a transcript from before Claude Code recorded that, or not a session): ${s.noOrigin}.` : "",
    s.unparsed ? `Lines that aren't JSON, passed over (a session still running can end in a half-written line): ${s.unparsed}.` : "",
  ].filter(Boolean).join("\n") + "\n");
  return 0;
}

async function convertClaudeCodeMain(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true,
      options: {
        out: { type: "string" }, user: { type: "string" }, assistant: { type: "string" }, tz: { type: "string" },
        json: { type: "boolean" }, help: { type: "boolean", short: "h" },
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
  const bad = convertOptionError(v, ["user", "assistant"]);
  if (bad) return fail(bad);
  return convertClaudeCode(positionals, { out: v.out, user: v.user, assistant: v.assistant, tz: v.tz, json: !!v.json });
}

// An SMS backup, read a chunk at a time (a backup can outgrow one string), into planSms's
// input; with media, each attachment is saved into it as it is read, and listed in
// media/attachments.tsv. → { read, saved: [[file, size, md5]] }. Give saved to collect into
// an array of your own: it then holds what was saved before a backup that fails partway.
export async function readSmsBackup(path, { number, groups, tz = "UTC", media, saved = [] } = {}) {
  if (media) await mkdir(media, { recursive: true });
  const onAttachment = (name, b64) => {
    const raw = Buffer.from(b64, "base64");
    writeFileSync(join(media, name), raw);
    saved.push([name, raw.length, createHash("md5").update(raw).digest("hex")]);
  };
  const m = smsMessages({ number, groups, timeZone: tz, media: !!media, onAttachment });
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) m.feed(chunk);
  return { read: m.end(), saved };
}

export async function convertSms(path, { out = ".", me, names = {}, tz = "UTC", number = "", title, base, groups = false, media } = {}) {
  let planned;
  const saved = [];
  try {
    let read;
    try {
      ({ read } = await readSmsBackup(path, { number, groups, tz, media, saved }));
    } catch (e) {
      if (e.code) throw e; // a file error says which file
      throw new Error(`${path} isn't a readable SMS backup (${e.message})`);
    }
    planned = planSms(read, { source: basename(path), number, title, base, me, names, timeZone: tz });
    if (!planned.files.length) throw new Error(`no messages matched${number ? ` the number ending ${smsDigits(number).slice(-4)}` : ""}`);
  } catch (e) {
    const kept = saved.length ? ` (${saved.length} attachments were already saved in ${shown(media)})` : "";
    process.stderr.write(`leket: ${e.message}; no transcript written${kept}.\n`);
    return 1;
  }
  if (media) {
    const tsv = join(media, "attachments.tsv");
    try {
      await writeFile(tsv, `file\tsize\tmd5\n${saved.map((r) => `${r.join("\t")}\n`).join("")}`);
    } catch (e) {
      process.stderr.write(`leket: couldn't write ${shown(tsv)} (${e.message}); no transcript written.\n`);
      return 1;
    }
  }
  if (!(await writeConverted(planned.files, out))) return 1;
  const s = planned.stats;
  process.stderr.write([
    `leket: ${s.conversations} conversations, ${s.messages} messages (${s.mine} sent from the backup's phone); times in ${tz}.`,
    s.skippedGroups ? `Group messages left out (give --groups to keep them): ${s.skippedGroups}.` : "",
    s.undated ? `Messages with no usable date, left out: ${s.undated}.` : "",
    media ? `${saved.length} attachments saved in ${shown(media)}, listed in attachments.tsv there.` : "",
  ].filter(Boolean).join("\n") + "\n");
  return 0;
}

async function convertSmsMain(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true,
      options: {
        out: { type: "string" }, me: { type: "string" }, name: { type: "string", multiple: true }, tz: { type: "string" },
        number: { type: "string" }, title: { type: "string" }, base: { type: "string" }, groups: { type: "boolean" },
        media: { type: "string" }, help: { type: "boolean", short: "h" },
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
  if (positionals.length > 1) return fail("give one backup (each backup is the whole phone, so two would repeat its messages)");
  const bad = convertOptionError(v, ["me", "title"]);
  if (bad) return fail(bad);
  if (v.number !== undefined && !smsDigits(v.number)) return fail("--number takes a phone number");
  for (const k of ["title", "base"]) if (v[k] !== undefined && v.number === undefined) return fail(`--${k} goes with --number (it names that one conversation's file)`);
  if (v.base !== undefined && (!v.base || /[/\\:]/.test(v.base))) return fail("--base takes a file name, not a path (no / \\ or :)");
  const names = Object.create(null); // no prototype: an address can be any word
  for (const n of v.name || []) {
    const i = n.indexOf("=");
    const key = i < 1 ? "" : smsKey(n.slice(0, i));
    if (!key) return fail(`--name takes NUMBER=LABEL, not ${n}`);
    const label = n.slice(i + 1);
    if (!label.trim() || /[\r\n]/.test(label)) return fail(`--name ${n.slice(0, i)}= takes a one-line label`);
    names[key] = label;
  }
  return convertSms(positionals[0], { out: v.out, me: v.me, names, tz: v.tz, number: v.number, title: v.title, base: v.base, groups: !!v.groups, media: v.media });
}

// The text exports given (each a .txt, or a folder: every .txt directly in it) →
// [{ file, text }] (file: its name); one given twice (itself and in its folder, or by a
// link) is read once.
export async function readSignalExports(paths) {
  const files = [];
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) {
      const names = (await readdir(p, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".txt")).map((e) => e.name).sort();
      if (!names.length) throw new Error(`${p} holds no .txt export`);
      files.push(...names.map((n) => join(p, n)));
    } else files.push(p);
  }
  const seen = new Set();
  const exports = [];
  for (const f of files) {
    const real = realpathSync(f);
    if (seen.has(real)) continue;
    seen.add(real);
    exports.push({ file: basename(f), text: await readFile(f, "utf8") });
  }
  return exports;
}

export async function convertSignal(paths, { out = ".", names = {}, tz = "", title, base } = {}) {
  let planned;
  try {
    planned = planSignal(await readSignalExports(paths), { title, base, names, timeZone: tz });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}; nothing written.\n`);
    return 1;
  }
  if (!(await writeConverted(planned.files, out))) return 1;
  const s = planned.stats;
  process.stderr.write(`leket: ${s.conversations} conversations, ${s.messages} messages, ${s.events} Signal events; times as exported${tz ? ` (${tz})` : ""}.\n`);
  return 0;
}

async function convertSignalMain(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true,
      options: {
        out: { type: "string" }, name: { type: "string", multiple: true }, tz: { type: "string" },
        title: { type: "string" }, base: { type: "string" }, help: { type: "boolean", short: "h" },
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
  const bad = convertOptionError(v, ["title"]);
  if (bad) return fail(bad);
  for (const k of ["title", "base"]) {
    if (v[k] !== undefined && positionals.length > 1) return fail(`--${k} goes with one export (it names that one conversation's file)`);
  }
  if (v.base !== undefined && (!v.base || /[/\\:]/.test(v.base))) return fail("--base takes a file name, not a path (no / \\ or :)");
  const names = Object.create(null); // no prototype: a display name can be any word
  for (const n of v.name || []) {
    const i = n.indexOf("=");
    if (i < 1) return fail(`--name takes NAME=LABEL, not ${n}`);
    const label = n.slice(i + 1);
    if (!label.trim() || /[\r\n]/.test(label)) return fail(`--name ${n.slice(0, i)}= takes a one-line label`);
    names[n.slice(0, i)] = label;
  }
  return convertSignal(positionals, { out: v.out, names, tz: v.tz, title: v.title, base: v.base });
}

// The checks every convert main makes: each label given is one line (and not blank,
// unless blankOk), and --tz is a zone Intl knows. → the first failure's message, or "".
function convertOptionError(v, labels, { blankOk = false } = {}) {
  for (const k of labels) if (v[k] !== undefined && ((!blankOk && !v[k].trim()) || /[\r\n]/.test(v[k]))) return `--${k} takes a one-line label`;
  if (v.tz !== undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: v.tz }); } catch { return `--tz: unknown time zone ${v.tz} (give one such as Europe/Paris or UTC)`; }
  }
  return "";
}

const CONVERT_OPTIONS = {
  out: { type: "string" }, user: { type: "string" }, assistant: { type: "string" }, tz: { type: "string" },
  folders: { type: "string" }, unlisted: { type: "string" }, help: { type: "boolean", short: "h" },
};

// `convert chatgpt` and `convert gemini`: the same options, gemini adding --titles and --other
async function convertExportMain(kind, args) {
  let parsed;
  try {
    const options = kind === "gemini" ? { ...CONVERT_OPTIONS, titles: { type: "string" }, other: { type: "string" } } : CONVERT_OPTIONS;
    parsed = parseArgs({ args, allowPositionals: true, options });
  } catch (e) {
    process.stderr.write(`leket: ${e.message}\n${CONVERT_USAGE}\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) { process.stdout.write(`${CONVERT_USAGE}\n`); return 0; }
  const fail = (msg) => { process.stderr.write(`leket: ${msg}\n`); return 2; };
  if (!positionals.length) { process.stderr.write(`${CONVERT_USAGE}\n`); return 2; }
  const bad = convertOptionError(v, ["user", "assistant"], { blankOk: true });
  if (bad) return fail(bad);
  for (const k of ["unlisted", "other"]) if (v[k] !== undefined && badFolder(v[k])) return fail(`--${k} takes a relative folder (no \\ : * ? " < > |, . or .. parts, no control characters)`);
  const opts = { out: v.out, user: v.user, assistant: v.assistant, tz: v.tz, folders: v.folders, unlisted: v.unlisted };
  return kind === "gemini" ? convertGemini(positionals, { ...opts, titles: v.titles, other: v.other }) : convertChatgpt(positionals, opts);
}

async function convertMain(rest) {
  const [kind, ...args] = rest;
  if (kind === "-h" || kind === "--help") { process.stdout.write(`${CONVERT_USAGE}\n`); return 0; }
  if (kind === "chatgpt" || kind === "gemini") return convertExportMain(kind, args);
  if (kind === "character-chat") return convertCharacterChatMain(args);
  if (kind === "claude-code") return convertClaudeCodeMain(args);
  if (kind === "sms") return convertSmsMain(args);
  if (kind === "signal") return convertSignalMain(args);
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
  const bad = convertOptionError(v, []);
  if (bad) return fail(bad);
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
  // temporary folder) still runs; writes after the close are dropped. A failure's own
  // code (1, 3) wins over 141: the close may come before or after main settles.
  let piped = false, failed = false;
  process.stdout.on("error", (e) => {
    // once the pipe has closed, any later stdout error (EPIPE or not) is dropped on
    // purpose: it is the same closed pipe, and the run's own result still decides the code
    if (e.code !== "EPIPE" && !piped) throw e;
    piped = true;
    if (!failed) process.exitCode = 141;
  });
  main(process.argv.slice(2)).then((code) => {
    failed = code !== 0;
    process.exitCode = failed ? code : piped ? 141 : 0;
  }, (e) => {
    failed = true;
    process.stderr.write(`leket: ${(e && e.stack) || e}\n`);
    process.exitCode = 1;
  });
}
