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
import { escapeHeading } from "../lib/html-md.js";
import { shown } from "../lib/shown.js";
import { blank, pyStrip, safeTitle, stamp } from "./common.js";

const KIND = { image_asset_pointer: "image", audio_asset_pointer: "audio", video_asset_pointer: "video" };

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
  const head = [`# ${escapeHeading(title)}`, "", `Conversation: https://chatgpt.com/c/${id}`,
    `Created: ${stamp(c.create_time, timeZone)}`, `Updated: ${stamp(c.update_time, timeZone)}`,
    `Messages: ${turns.length}`, ""];
  return { title, turns: turns.length, text: `${head.join("\n")}\n${turns.join("\n")}`, skipped };
}

// Every file to write: [{ folder, name, text, id, turns, skipped, empty }]. folders maps a
// conversation id to its folder (relative to the output folder); one it doesn't list goes
// to `unlisted` ("" = the output folder itself). Two conversations that would share a file
// name (on a case-blind disk too) are told apart by the first 8 characters of their ids,
// then a number: the name stays within 255 bytes. Conversations are taken oldest first
// (then by id), so which one gets the suffix doesn't depend on the export's order.
export function plan(convs, { folders = {}, unlisted = "", ...opts } = {}) {
  const files = [];
  const taken = new Set();
  const when = (c) => (typeof c.create_time === "number" && Number.isFinite(c.create_time) ? c.create_time : Infinity);
  const ordered = [...convs.conversations].sort((a, b) => when(a.c) - when(b.c) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const conv of ordered) {
    const r = render(conv, { ...opts, names: convs.names });
    const folder = Object.hasOwn(folders, conv.id) ? folders[conv.id] : unlisted;
    const day = stamp(conv.c.create_time, opts.timeZone).slice(0, 10) || "undated";
    let name = `${day} ${safeTitle(r.title)}.md`;
    const key = (n) => `${folder}/${n}`.toLowerCase();
    const tag = safeTitle(conv.id.slice(0, 8));
    if (taken.has(key(name))) name = `${day} ${safeTitle(r.title)} (${tag}).md`;
    for (let k = 2; taken.has(key(name)); k++) name = `${day} ${safeTitle(r.title)} (${tag} ${k}).md`;
    taken.add(key(name));
    files.push({ folder, name, text: r.text, id: conv.id, turns: r.turns, skipped: r.skipped, empty: !conv.c.current_node });
  }
  return files;
}
