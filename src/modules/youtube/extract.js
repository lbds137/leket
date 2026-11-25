// The youtube-extract/v1 builder and its Markdown, shared by every YouTube save: the
// leket CLI (bin/leket.js, yt-dlp backend) and the extension module. Pure by design: no
// chrome APIs, no fetch, no DOM, no fs. The spec is deck-platform's console script
// (browser/youtube-extractor-guide.md, v3): its saveJSON() fixes the v1 shape and its
// save() the Markdown layout. Fields added here beyond v1 are additive only (a v1 reader
// ignores them):
// - metadata: source, video_id, transcript_language, transcript_kind, transcript_note
//   (why the transcript is empty, when it is), comments_note.
// - each reply: likes_numeric and time, which the console script reads but drops.

export const SCHEMA = "youtube-extract/v1";

// "1.2K" / "3.4M" / "1,234" / "" → a number; the console script's parseLikes, verbatim
// in behaviour (an empty or unreadable count is 0).
export function parseLikes(s) {
  if (s === null || s === undefined) return 0;
  s = String(s).replace(/,/g, "").trim();
  if (!s) return 0;
  let m = 1;
  if (/K$/i.test(s)) { m = 1e3; s = s.replace(/K/i, ""); }
  else if (/M$/i.test(s)) { m = 1e6; s = s.replace(/M/i, ""); }
  const n = parseFloat(s) * m;
  return Number.isFinite(n) ? n : 0;
}

// milliseconds → the transcript panel's own stamp: "0:14", "12:03", "1:02:03"
export function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// YouTube's json3 caption format → [{time, text}]. Auto captions carry their words in
// timed segs plus "append" events that hold only a newline, and a header event with no
// segs at all: an event whose joined text is blank is dropped, and line breaks inside
// one event read as spaces, as they do in the transcript panel.
export function json3ToTranscript(json3) {
  const events = json3 && Array.isArray(json3.events) ? json3.events : [];
  const rows = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => (s && typeof s.utf8 === "string" ? s.utf8 : "")).join("")
      .replace(/\s+/g, " ").trim();
    if (!text) continue;
    rows.push({ time: formatTimestamp(ev.tStartMs), text });
  }
  return rows;
}

// Which caption track to read for `lang`, from yt-dlp's subtitles / automatic_captions
// maps ({lang: [{ext, url}, ...]}): a manual track first; then the original speech
// recognition (`<lang>-orig`, which YouTube lists beside its translations); then the
// auto track named `lang`, which is a machine translation when its URL carries tlang.
// Returns {url, kind, language} or null when no json3 track exists for the language.
export function pickCaptionTrack(info, lang) {
  const json3 = (list) => (Array.isArray(list) ? list.find((f) => f && f.ext === "json3" && f.url) : null);
  const manual = json3(info && info.subtitles && info.subtitles[lang]);
  if (manual) return { url: manual.url, kind: "manual", language: lang };
  const auto = (info && info.automatic_captions) || {};
  const orig = json3(auto[`${lang}-orig`]);
  if (orig) return { url: orig.url, kind: "auto", language: lang };
  const plain = json3(auto[lang]);
  if (plain) {
    let translated = false;
    try { translated = new URL(plain.url).searchParams.has("tlang"); } catch { /* keep false */ }
    return { url: plain.url, kind: translated ? "auto-translated" : "auto", language: lang };
  }
  return null;
}

// yt-dlp's flat comment list (parent "root" or the parent's id) → v1 threads. YouTube
// threads are two levels deep, but yt-dlp gives a reply to a reply that reply's id as
// its parent: the parent chain is walked up to the thread, and where it leaves the list,
// the reply id's own form ("<thread id>.<suffix>") names the thread. A reply whose
// thread isn't in the list (a cap cut it off)
// is dropped rather than promoted to a top-level comment it never was; the caller
// counts it via droppedReplies.
export function threadsFromYtDlp(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const byId = new Map();
  const threads = [];
  for (const c of list) {
    if (!c || c.parent !== "root") continue;
    const t = {
      author: c.author || "",
      likes: String(c.like_count ?? 0),
      time: c._time_text || "",
      pinned: !!c.is_pinned,
      reply_count_label: null,
      text: c.text || "",
      replies: [],
    };
    byId.set(c.id, t);
    threads.push(t);
  }
  // every comment by id, so a reply's parent chain can be walked up to its thread
  const parentOf = new Map(list.filter((c) => c && c.id).map((c) => [c.id, c.parent]));
  const threadOf = (c) => {
    let id = c.parent;
    for (let hops = 0; hops < 16 && id && id !== "root"; hops++) {
      if (byId.has(id)) return byId.get(id);
      if (!parentOf.has(id)) break;
      id = parentOf.get(id);
    }
    // the chain left the list (or looped): fall back on the id's thread prefix
    return byId.get(String(c.parent ?? "").split(".")[0]);
  };
  let droppedReplies = 0;
  for (const c of list) {
    if (!c || c.parent === "root") continue;
    const t = threadOf(c);
    if (!t) { droppedReplies++; continue; }
    t.replies.push({ author: c.author || "", likes: String(c.like_count ?? 0), time: c._time_text || "", text: c.text || "" });
  }
  return { threads, droppedReplies };
}

// The v1 object. Comments sort by likes, highest first, as the console script's
// SORT_BY_LIKES default does; the sort is stable, so equal counts keep source order.
export function buildExtract({ metadata = {}, transcript = [], comments = [], extractedAt = new Date().toISOString() }) {
  const sorted = [...comments].sort((a, b) => parseLikes(b.likes) - parseLikes(a.likes));
  const meta = {
    title: metadata.title || "",
    channel: metadata.channel || "",
    url: metadata.url || "",
    total_comments_reported: metadata.total_comments_reported || "",
    transcript_segment_count: transcript.length,
    comments_captured: sorted.length,
  };
  for (const k of ["source", "video_id", "transcript_language", "transcript_kind", "transcript_note", "comments_note"]) {
    if (metadata[k] !== undefined && metadata[k] !== null && metadata[k] !== "") meta[k] = metadata[k];
  }
  return {
    schema: SCHEMA,
    extracted_at: extractedAt,
    metadata: meta,
    transcript: transcript.map((r) => ({ time: r.time, text: r.text })),
    comments: sorted.map((c) => ({
      author: c.author,
      likes: c.likes,
      likes_numeric: parseLikes(c.likes),
      time: c.time,
      pinned: !!c.pinned,
      reply_count_label: c.reply_count_label || null,
      text: c.text,
      replies: (c.replies || []).map((r) => ({
        author: r.author,
        likes: r.likes,
        likes_numeric: parseLikes(r.likes),
        time: r.time || "",
        text: r.text,
      })),
    })),
  };
}

// One line, so a multi-line comment stays inside its list item and blockquote.
// One line, so a multi-line comment stays inside its list item and blockquote, with
// every `<` escaped so a title or comment can't open raw HTML (the reddit module's
// plain() does the same). Links and emphasis stay: the text is read, not executed.
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim().replace(/</g, "&lt;");

// The console script's save() layout, from a v1 object.
export function renderMarkdown(x) {
  const m = x.metadata;
  const replies = x.comments.reduce((n, c) => n + c.replies.length, 0);
  let md = "# YouTube Video Reference File\n\n> Machine-readable extract (transcript + comments) for AI ingestion.\n\n## Metadata\n\n";
  md += `- **Title:** ${oneLine(m.title)}\n- **Channel:** ${oneLine(m.channel)}\n`;
  md += `- **URL:** ${oneLine(m.url)}\n- **Total comments (reported):** ${oneLine(m.total_comments_reported)}\n`;
  md += `- **Comments captured:** ${m.comments_captured} top-level + ${replies} replies (sorted by likes)\n`;
  md += `- **Transcript segments:** ${m.transcript_segment_count}\n`;
  if (m.transcript_kind) md += `- **Transcript:** ${m.transcript_language} (${m.transcript_kind})\n`;
  if (m.transcript_note) md += `- **Transcript note:** ${oneLine(m.transcript_note)}\n`;
  if (m.comments_note) md += `- **Comments note:** ${oneLine(m.comments_note)}\n`;
  md += "\n## Full Transcript\n\nFormat: [timestamp]\\ttext\n\n";
  // a fence longer than any backtick run in the text, so no segment can close it
  let longest = 2;
  for (const r of x.transcript) for (const run of String(r.text).matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  md += `${fence}\n`;
  for (const r of x.transcript) md += `${r.time}\t${r.text}\n`;
  md += `${fence}\n\n## Comments (${x.comments.length} captured)\n\n`;
  x.comments.forEach((c, i) => {
    const marker = `${i + 1}. `;
    // continuation lines indent by the marker's width, or from "10. " on the quote
    // and replies would fall out of their list item
    const pad = " ".repeat(marker.length);
    md += `${marker}**${oneLine(c.author)}** — ${oneLine(c.likes)} likes`;
    if (c.time) md += ` · ${oneLine(c.time)}`;
    if (c.pinned) md += " · PINNED";
    if (c.reply_count_label) md += ` · ${oneLine(c.reply_count_label)}`;
    md += `\n${pad}> ${oneLine(c.text)}\n`;
    for (const r of c.replies) md += `${pad}- ↳ **${oneLine(r.author)}** (${oneLine(r.likes)}): ${oneLine(r.text)}\n`;
    md += "\n";
  });
  return md;
}

// The console script's baseName() (the title, slugged, at most 60 characters, outer
// dashes trimmed), then the video id, so two videos with one title never share a file.
export function baseName(title, videoId) {
  const slug = String(title || "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60).toLowerCase().replace(/^-+|-+$/g, "") || "youtube";
  return /^[A-Za-z0-9_-]+$/.test(videoId || "") ? `${slug}-${videoId}` : slug;
}
