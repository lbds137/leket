#!/usr/bin/env node
// A stand-in for yt-dlp in test/cli.test.js (LEKET_YTDLP points here): writes a
// synthetic video.info.json where -o says, and logs the comment estimate the way
// yt-dlp does. FAKE_YTDLP_MODE: fail exits 1 without writing anything; old fails the
// way a yt-dlp without --js-runtimes does; partial writes the info and then exits 1;
// kill writes the info and then dies by SIGTERM; null writes the JSON literal null;
// playlist writes a playlist's info. FAKE_YTDLP_ARGS names a file to record argv in.
// FAKE_YTDLP_CHMOD names a folder made read-only (0555) first, so the CLI's own writes
// there fail after yt-dlp succeeded. Every name and text below is invented.
import { chmodSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_YTDLP_ARGS) writeFileSync(process.env.FAKE_YTDLP_ARGS, JSON.stringify(args));
if (process.env.FAKE_YTDLP_CHMOD) chmodSync(process.env.FAKE_YTDLP_CHMOD, 0o555);
if (process.env.FAKE_YTDLP_MODE === "fail") {
  process.stderr.write("ERROR: [youtube] fake: Video unavailable\n");
  process.exit(1);
}
if (process.env.FAKE_YTDLP_MODE === "old") {
  process.stderr.write("yt-dlp: error: no such option: --js-runtimes\n");
  process.exit(2);
}
const tmpl = args[args.indexOf("-o") + 1];
const info = {
  id: "fakeVid0001",
  title: "A Synthetic Test Video",
  channel: "Test Channel",
  webpage_url: "https://www.youtube.com/watch?v=fakeVid0001",
  subtitles: {},
  automatic_captions: {},
  comments: [
    { id: "rootA", parent: "root", author: "@alpha", text: "first comment", like_count: 3, _time_text: "2 days ago", is_pinned: false },
    { id: "rootA.r1", parent: "rootA", author: "@beta", text: "a reply", like_count: 1, _time_text: "1 day ago" },
    { id: "rootB", parent: "root", author: "@gamma", text: "second comment", like_count: 9, _time_text: "3 days ago", is_pinned: true },
  ],
};
// on stdout, as yt-dlp's to_screen writes it
process.stdout.write("[youtube] Downloading ~5 comments\n");
const mode = process.env.FAKE_YTDLP_MODE;
const body = mode === "null" ? "null"
  : mode === "playlist" ? JSON.stringify({ _type: "playlist", id: "PLfake", title: "A Synthetic Playlist", entries: [] })
  : JSON.stringify(info);
writeFileSync(tmpl.replace("%(ext)s", "info.json"), body);
if (mode === "partial") {
  process.stderr.write("ERROR: [youtube] fake: comment page failed\n");
  process.exit(1);
}
if (mode === "kill") process.kill(process.pid, "SIGTERM");
