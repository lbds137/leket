// `leket convert gemini`: Google Takeout's Gemini activity ("My Activity" JSON: one row per
// prompt, Gemini's replies as HTML) → one Markdown file per chat, rebuilt from the
// gemini.google.com/app/<id> link each row carries. Several Takeout snapshots are merged:
// a row is the same row when its time and title match, and the first snapshot given keeps
// it, so a later Takeout made after chats were deleted at the source loses nothing.
//
//   # Title (the start of the first prompt: Takeout has no chat titles; --titles gives them)
//
//   Conversation: https://gemini.google.com/app/<id>
//   First: …   Last: …   Prompts: N   Gem: … (when one was used)
//
//   ### User · YYYY-MM-DDTHH:MM:SSZ
//   the prompt
//
//   ### Gemini · …
//   the reply, as Markdown
//
// Rows that belong to no chat (a Canvas, feedback, phone Assistant actions) go to
// other-activity.md, and each Canvas document's text to canvases/.
// Pure: no file access. bin/leket.js reads the exports and writes what plan() returns.
import { decode, htmlToMarkdown } from "../lib/html-md.js";
import { safeTitle, stamp } from "./common.js";

const CONV = /gemini\.google\.com\/app\/([0-9a-f]+)/;
const PROMPTED = "Prompted ", ADDED = "Added chat from link: ", CANVAS = "Created Gemini Canvas titled ";
// a reply element Takeout left empty or as bare dots: text it removed
const EMPTIED = /<(li|p|h[1-6]|td)>(?:\s|\.|<br>|\*)*(?=<\/\1>|<ul>|<ol>)/g;
// Python's \w (the original's file names keep letters and digits in any script)
const NOT_NAME = /[^\p{L}\p{N}_\s,'()-]/gu;

const isRow = (e) => e && typeof e === "object" && typeof e.time === "string" && typeof e.title === "string";
const list = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === "string" ? x : "");

export function convId(e) {
  for (const d of list(e.details)) {
    const m = CONV.exec(str(d?.url) || str(d?.name));
    if (m) return m[1];
  }
  return null;
}

const isGemini = (e) => /Gemini/.test(str(e.header)) || list(e.products).some((p) => /Gemini/.test(str(p))) || !!convId(e);
const isPrompt = (e) => e.title.startsWith(PROMPTED) || e.title.startsWith(ADDED);
const secs = (e) => { const t = Date.parse(e.time); return Number.isNaN(t) ? Infinity : t / 1000; };

// Snapshots in the order given ([{ label, rows }]) → { rows (oldest first), other }: the
// Gemini rows of all of them, each (time, title) once, from the first snapshot that has it;
// `other` counts rows of other Google products (a whole-account Takeout has those too).
export function collect(snapshots) {
  const seen = new Map();
  let other = 0;
  for (const s of snapshots) {
    for (const e of list(s.rows)) {
      if (!isRow(e)) continue;
      if (!isGemini(e)) { other++; continue; }
      const key = JSON.stringify([e.time, e.title]);
      if (!seen.has(key)) seen.set(key, e);
    }
  }
  const rows = [...seen.values()].sort((a, b) => secs(a) - secs(b) || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return { rows, other };
}

export function canvasDoc(e) {
  for (const s of list(e.subtitles)) if (str(s?.name).includes("\n")) return s.name;
  return null;
}

// distinct reply HTML fragments with any text (Takeout repeats drafts)
export function replies(e) {
  const out = [];
  for (const s of list(e.safeHtmlItem)) {
    const h = str(s?.html);
    if (h.replace(/<[^>]+>|\s/g, "") && !out.includes(h)) out.push(h);
  }
  return out;
}

export const gutted = (h) => (h.match(EMPTIED) || []).length >= 2;

const letters = (s) => (s.match(/[\p{L}\p{N}_]/gu) || []).length;

function clean(text) {
  return text.replace(NOT_NAME, " ").replace(/\s+/g, " ").trim();
}

// a chat's name: the start of its first prompt, cut at a word within 60 characters
export function slug(e) {
  let text = clean(e.title.replace(/^(Prompted|Added chat from link:)\s+/, ""));
  const cps = [...text];
  if (cps.length > 60) { text = cps.slice(0, 60).join(""); const i = text.lastIndexOf(" "); if (i >= 0) text = text.slice(0, i); }
  return text || "untitled";
}

const code = (s) => {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${s.startsWith("`") || s.endsWith("`") ? ` ${s} ` : s}${f}`;
};

// blockquote lines for what Takeout says about attachments and images
function fileLines(e) {
  const lines = [], named = new Set();
  for (const s of list(e.subtitles)) {
    let text = str(s?.name).trim();
    const url = str(s?.url);
    if (str(s?.name).includes("\n")) continue; // a Canvas document: written to canvases/
    if (/^https?:/.test(url)) text += ` <${url}>`;
    else if (url) { named.add(url); text += ` (saved as ${code(url)})`; }
    lines.push(`> ${text}`);
  }
  const extra = [...list(e.attachedFiles).filter((x) => typeof x === "string")];
  if (typeof e.imageFile === "string" && e.imageFile) extra.push(e.imageFile);
  for (const name of new Set(extra)) if (!named.has(name)) lines.push(`> file: ${code(name)}`);
  return lines;
}

// one row → Markdown. md maps reply HTML to Markdown; canvas(e) gives the link to its
// document, relative to the file being written.
function renderRow(e, { md, user, assistant, timeZone, canvas, inChat }) {
  const t = stamp(secs(e), timeZone);
  const out = [];
  if (e.title.startsWith(PROMPTED)) out.push(`### ${user} · ${t}`, e.title.slice(PROMPTED.length));
  else if (e.title.startsWith(ADDED)) out.push(`### ${user} · ${t}`, "*(chat added from a shared link)*", "", e.title.slice(ADDED.length));
  else {
    out.push(`*${e.title} · ${t}*`);
    const cid = convId(e);
    if (cid && !inChat) out.push(`https://gemini.google.com/app/${cid}`);
    if (canvasDoc(e)) out.push(`Document: ${canvas(e)}`);
  }
  const fl = fileLines(e);
  if (fl.length) out.push("", ...fl);
  for (const [i, h] of replies(e).entries()) {
    out.push("", `### ${i ? `${assistant} (draft ${i + 1})` : assistant} · ${t}`);
    if (gutted(h)) out.push("*(Takeout removed text from this reply; gemini.google.com may still have it)*", "");
    out.push(md.get(h));
  }
  return out.join("\n");
}

// the link from a file in folder `from` to the file `to` (both relative to the output folder)
const pathTo = (from, to) => {
  const a = from ? from.split("/") : [], b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].map(encodeURIComponent).join("/");
};

// Every file to write: [{ folder, name, text, kind: "chat" | "other" | "canvas", id?, prompts? }]
// and the run's numbers. folders maps a chat id to its folder (relative to the output
// folder), unlisted is where the others go, other is where other-activity.md and canvases/
// go ("" = the output folder itself). titles maps a chat id to the title to show.
export function plan({ rows, other: otherProducts = 0 }, {
  folders = {}, unlisted = "", other = "", titles = {}, user = "User", assistant = "Gemini", timeZone = "UTC",
} = {}) {
  const fragments = [...new Set(rows.flatMap(replies))];
  const unknown = Object.create(null);
  const md = new Map();
  let short = 0;
  for (const h of fragments) {
    const r = htmlToMarkdown(h);
    for (const [k, n] of Object.entries(r.unknown)) unknown[k] = (unknown[k] || 0) + n;
    md.set(h, r.md);
    // the original's check: Markdown with under 98% of the HTML's letters lost text
    if (letters(r.md) < letters(decode(h.replace(/<[^>]+>/g, ""))) * 0.98) short++;
  }

  const convs = new Map();
  let loose = [];
  for (const e of rows) {
    const cid = convId(e);
    if (!cid) { loose.push(e); continue; }
    if (!convs.has(cid)) convs.set(cid, []);
    convs.get(cid).push(e);
  }
  // a linked conversation with no prompt in it (phone Assistant actions) is not a chat
  for (const [cid, es] of [...convs]) if (!es.some(isPrompt)) { loose.push(...es); convs.delete(cid); }
  loose = loose.sort((a, b) => secs(a) - secs(b));

  const day = (e) => stamp(secs(e), timeZone).slice(0, 10) || "undated";
  const canvasNames = new Map(), canvasFiles = [], takenCanvas = new Set();
  const canvasDir = other ? `${other}/canvases` : "canvases";
  for (const e of rows) {
    const doc = canvasDoc(e);
    if (!doc) continue;
    const base = safeTitle(`${day(e)} ${[...clean(e.title.replace(CANVAS, ""))].slice(0, 60).join("").trim()}`);
    let name = `${base}.md`;
    for (let k = 2; takenCanvas.has(name.toLowerCase()); k++) name = `${base} (${k}).md`;
    takenCanvas.add(name.toLowerCase());
    canvasNames.set(e, name);
    canvasFiles.push({ folder: canvasDir, name, text: `${doc}\n`, kind: "canvas" });
  }
  const canvasLink = (from) => (e) => {
    const name = canvasNames.get(e);
    return `[canvases/${name}](${pathTo(from, `${canvasDir}/${name}`)})`;
  };

  const files = [], taken = new Set();
  let prompts = 0, cut = 0, cutChats = 0;
  const order = [...convs].map(([cid, es]) => ({ cid, es, first: es.find(isPrompt) }))
    .sort((a, b) => secs(a.first) - secs(b.first) || (a.cid < b.cid ? -1 : 1));
  for (const { cid, es, first } of order) {
    const folder = Object.hasOwn(folders, cid) ? folders[cid] : unlisted;
    const base = `${day(es[0])} ${safeTitle(slug(first))}`;
    const key = (n) => `${folder}/${n}`.toLowerCase();
    let name = `${base}.md`;
    if (taken.has(key(name))) name = `${base} (${cid.slice(0, 6)}).md`;
    for (let k = 2; taken.has(key(name)); k++) name = `${base} (${cid.slice(0, 6)} ${k}).md`;
    taken.add(key(name));
    const n = es.filter(isPrompt).length;
    const gems = [...new Set(es.flatMap((e) => list(e.subtitles).map((s) => str(s?.name))
      .filter((s) => s.includes(" was used in this chat")).map((s) => s.split(" was used")[0])))].sort();
    const head = [`# ${Object.hasOwn(titles, cid) ? titles[cid] : slug(first)}`, "",
      `Conversation: https://gemini.google.com/app/${cid}`,
      `First: ${stamp(secs(es[0]), timeZone)}`, `Last: ${stamp(secs(es[es.length - 1]), timeZone)}`, `Prompts: ${n}`];
    if (gems.length) head.push(`Gem: ${gems.join(", ")}`);
    const ctx = { md, user, assistant, timeZone, canvas: canvasLink(folder), inChat: true };
    const body = es.map((e) => renderRow(e, ctx)).join("\n\n");
    const c = es.reduce((k, e) => k + replies(e).filter(gutted).length, 0);
    prompts += n; cut += c; if (c) cutChats++;
    files.push({ folder, name, text: `${head.join("\n")}\n\n${body}\n`, kind: "chat", id: cid, prompts: n });
  }

  if (loose.length) {
    const ctx = { md, user, assistant, timeZone, canvas: canvasLink(other), inChat: false };
    files.push({
      folder: other, name: "other-activity.md", kind: "other",
      text: "# Gemini activity outside the chats\n\n" +
        "Rows that belong to no chat: Canvas documents (text in `canvases/`), feedback, and " +
        "phone Assistant actions (linked, but with no prompt or reply recorded).\n\n" +
        `${loose.map((e) => renderRow(e, ctx)).join("\n\n")}\n`,
    });
  }
  files.push(...canvasFiles);

  // rows that link a chat but none of them reads as a prompt: a Takeout in another
  // language words its titles differently, and every chat would land in other-activity.md
  const unrecognised = !convs.size && rows.some((e) => convId(e));
  return {
    files,
    stats: {
      rows: rows.length, chats: convs.size, loose: loose.length, canvases: canvasFiles.length, prompts,
      replies: fragments.length, cut, cutChats, short, unknown, otherProducts, unrecognised,
    },
  };
}
