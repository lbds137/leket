// `leket convert chatgpt`: ChatGPT's data export (conversations.json, and the
// conversation_asset_file_names.json beside it) → one Markdown file per conversation.
// Each file follows the conversation's current branch, from the message on screen back to
// the root, so an edited prompt's abandoned answers stay out. Only the user's and the
// assistant's messages are shown, never system, tool or hidden ones, and only their text
// parts: a message with none (code the assistant ran, its reasoning) is counted, not shown.
//
//   # Title
//
//   Conversation: https://chatgpt.com/c/<id>
//   Created: YYYY-MM-DDTHH:MM:SSZ
//   Updated: …
//   Messages: 2
//
//   ### User · YYYY-MM-DDTHH:MM:SSZ
//   the text
//   [image: photo.png]
//
// Pure: no file access. bin/leket.js reads the exports and writes what plan() returns.
import { shown } from "../lib/shown.js";

// Python's str.isspace() set: the original converter's strip() and its "is this part
// blank" test use it, and it differs from JavaScript's \s (no U+FEFF; adds \x1c-\x1f, \x85)
const PYSPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const pyStrip = (s) => s.replace(new RegExp(`^[${PYSPACE}]+|[${PYSPACE}]+$`, "g"), "");
const blank = (s) => !pyStrip(s);

const KIND = { image_asset_pointer: "image", audio_asset_pointer: "audio", video_asset_pointer: "video" };

// Seconds since 1970 → "YYYY-MM-DDTHH:MM:SSZ" in UTC, or with the zone's offset
// ("…-05:00") in another zone; "" for no time (missing, 0, or out of range), as the
// original shows it. Fractions of a second are dropped, not rounded.
export function stamp(t, timeZone = "UTC") {
  if (typeof t !== "number" || !t || !Number.isFinite(t)) return "";
  const d = new Date(Math.floor(t) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  if (timeZone === "UTC") return d.toISOString().replace(/\.\d+Z$/, "Z");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace(/^GMT/, "");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

// a message's text: its string parts, and each attachment as [image: name]
function textOf(content, names) {
  const out = [];
  for (const part of (content && Array.isArray(content.parts)) ? content.parts : []) {
    if (typeof part === "string") out.push(part);
    else if (part && typeof part === "object") {
      if (part.content_type === "audio_transcription") { if (typeof part.text === "string") out.push(part.text); continue; }
      const ptr = typeof part.asset_pointer === "string" ? part.asset_pointer : "";
      const fid = ptr.slice(ptr.lastIndexOf("/") + 1);
      const key = `${fid}.dat`;
      const name = Object.hasOwn(names, key) && typeof names[key] === "string" ? names[key] : fid || "attachment";
      out.push(`[${KIND[part.content_type] || (part.content_type ? "attachment" : "image")}: ${name}]`);
    }
  }
  return out.filter((p) => !blank(p)).join("\n\n");
}

const idOf = (c) => (typeof c.conversation_id === "string" && c.conversation_id) || (typeof c.id === "string" && c.id) || null;

// Exports in the order given ({conversations, names}) → one list of conversations, a later
// export's copy of a conversation replacing an earlier one's, and every file-name map merged.
export function collect(exports) {
  const convs = new Map();
  // no prototype: a "__proto__" key in the export's JSON stays an ordinary name
  const names = Object.create(null);
  for (const [i, e] of exports.entries()) {
    if (!Array.isArray(e.conversations)) throw new Error(`${e.label || `export ${i + 1}`}: its conversations.json isn't a list of conversations`);
    if (e.names && typeof e.names === "object" && !Array.isArray(e.names)) Object.assign(names, e.names);
    for (const [k, c] of e.conversations.entries()) {
      const id = c && typeof c === "object" ? idOf(c) : null;
      if (!id) throw new Error(`${e.label || `export ${i + 1}`}: conversation ${k + 1} has no conversation_id`);
      if (!c.mapping || typeof c.mapping !== "object") throw new Error(`conversation ${shown(id)} has no mapping`);
      convs.delete(id); // a later copy also takes the later place
      convs.set(id, c);
    }
  }
  return { conversations: [...convs.entries()].map(([id, c]) => ({ id, c })), names };
}

// One conversation → { title, turns, text, skipped: {content_type: count} }.
export function render({ id, c }, { names = {}, user = "User", assistant = "ChatGPT", timeZone = "UTC" } = {}) {
  const turns = [];
  const skipped = Object.create(null); // keyed by the export's content_type
  const seen = new Set();
  let node = c.current_node;
  while (node) {
    if (seen.has(node)) throw new Error(`conversation ${shown(id)}: its messages loop back to ${shown(node)}`);
    seen.add(node);
    if (!Object.hasOwn(c.mapping, node) || !c.mapping[node]) throw new Error(`conversation ${shown(id)}: message ${shown(node)} isn't in its mapping`);
    const n = c.mapping[node];
    const m = n.message;
    const role = m && m.author && m.author.role;
    if ((role === "user" || role === "assistant") && !(m.metadata && m.metadata.is_visually_hidden_from_conversation)) {
      const body = textOf(m.content, names);
      if (!blank(body)) turns.push(`### ${role === "user" ? user : assistant} · ${stamp(m.create_time, timeZone)}\n${body}\n`);
      else if (m.content && !Array.isArray(m.content.parts)) {
        const kind = String(m.content.content_type || "unknown");
        skipped[kind] = (skipped[kind] || 0) + 1;
      }
    }
    node = n.parent;
  }
  turns.reverse();
  const title = pyStrip(typeof c.title === "string" ? c.title : "") || "untitled";
  const head = [`# ${title}`, "", `Conversation: https://chatgpt.com/c/${id}`,
    `Created: ${stamp(c.create_time, timeZone)}`, `Updated: ${stamp(c.update_time, timeZone)}`,
    `Messages: ${turns.length}`, ""];
  return { title, turns: turns.length, text: `${head.join("\n")}\n${turns.join("\n")}`, skipped };
}

// A title as a file name: path separators, a drive colon and control characters become
// "-", trailing dots go (Windows drops them), and it is cut to 200 bytes of UTF-8.
export function safeTitle(title) {
  let s = title.replace(/[/\\:\x00-\x1f\x7f]/g, "-").replace(/\.+$/, "");
  const enc = new TextEncoder();
  if (enc.encode(s).length > 200) {
    // 200 bytes hold at most 200 code points: cut to those first, so a huge title costs
    // at most 200 short re-encodes
    const cps = [...s.slice(0, 400)].slice(0, 200);
    while (enc.encode(cps.join("")).length > 200) cps.pop();
    s = cps.join("").replace(/\.+$/, "");
  }
  return s || "untitled";
}

// A folder from --folders or --unlisted: relative, "/"-separated, no empty, . or .. part.
export function badFolder(f) {
  if (typeof f !== "string" || !f || /[\\:\x00-\x1f\x7f]/.test(f) || f.startsWith("/")) return true;
  return f.split("/").some((p) => !p || p === "." || p === "..");
}

// Every file to write: [{ folder, name, text, id, turns, skipped }]. folders maps a
// conversation id to its folder (relative to the output folder); one it doesn't list goes
// to `unlisted` ("" = the output folder itself). Two conversations that would share a file
// name (on a case-blind disk too) are told apart by the first 8 characters of their ids,
// then a number: the name stays within 255 bytes.
export function plan(convs, { folders = {}, unlisted = "", ...opts } = {}) {
  const files = [];
  const taken = new Set();
  for (const conv of convs.conversations) {
    const r = render(conv, { ...opts, names: convs.names });
    const folder = Object.hasOwn(folders, conv.id) ? folders[conv.id] : unlisted;
    const day = stamp(conv.c.create_time, opts.timeZone).slice(0, 10) || "undated";
    let name = `${day} ${safeTitle(r.title)}.md`;
    const key = (n) => `${folder}/${n}`.toLowerCase();
    const tag = safeTitle(conv.id.slice(0, 8));
    if (taken.has(key(name))) name = `${day} ${safeTitle(r.title)} (${tag}).md`;
    for (let k = 2; taken.has(key(name)); k++) name = `${day} ${safeTitle(r.title)} (${tag} ${k}).md`;
    taken.add(key(name));
    files.push({ folder, name, text: r.text, id: conv.id, turns: r.turns, skipped: r.skipped });
  }
  return files;
}
