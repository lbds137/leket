// `leket convert character-chat`: a character-chat site's JSON export → one Markdown file
// per conversation, an index (INDEX.md) and the characters' cards (CARDS.md).
//
// The export is one JSON object:
//   { exported, conversations: [{ id, character_id, character?: { name },
//       meta: { label?, num_messages?, userPersona?: { name } },
//       messages: [{ id, role: "user" | other, content, createdAt (ms since 1970) }] }],
//     characters: { <character_id>: { name, creator_username?, title?, persona?, scenario?,
//       greeting?, dialogue? } | { error } } }
//
//   # Label (or the character's name)
//
//   <site> conversation with **Name** (character by creator), YYYY-MM-DD HH:MM to …;
//   N messages saved of M the site counts. Source: `export.json`, conversation `id`.
//
//   ## Persona · YYYY-MM-DD HH:MM
//
//   the text
//
// Pure: no file access. bin/leket.js reads the exports and writes what plan() returns.
import { shown } from "../lib/shown.js";
import { codeSpan } from "../lib/html-md.js";
import { pyStrip, safeTitle } from "./common.js";

const str = (x) => (typeof x === "string" ? x : "");
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
const ms = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// Milliseconds since 1970 → "YYYY-MM-DD HH:MM" in timeZone; "" for no time
export function minute(t, timeZone = "UTC") {
  if (ms(t) === null) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Exports in the order given ({ label, data }) → { conversations: [{ id, c, source }],
// characters, sources }. A conversation in more than one export is taken from the copy
// with the most messages (the later one on a tie), so a shorter re-save never replaces a
// fuller one; a character's card from the last export that has it (an error stub only when
// no export has the card).
export function collect(exports) {
  const convs = new Map();
  // no prototype: a "__proto__" character id stays an ordinary key
  const characters = Object.create(null);
  for (const [i, e] of exports.entries()) {
    const label = e.label || `export ${i + 1}`;
    const d = obj(e.data);
    if (!d || !Array.isArray(d.conversations)) throw new Error(`${label}: not a character-chat export (no "conversations" list)`);
    const chars = obj(d.characters) || {};
    for (const id of Object.keys(chars)) {
      const ch = obj(chars[id]);
      if (!ch) continue;
      if (str(ch.name) || !Object.hasOwn(characters, id)) characters[id] = ch;
    }
    for (const [k, c] of d.conversations.entries()) {
      const id = obj(c) && (typeof c.id === "string" || typeof c.id === "number") ? String(c.id) : "";
      if (!id) throw new Error(`${label}: conversation ${k + 1} has no id`);
      if (!Array.isArray(c.messages)) throw new Error(`${label}: conversation ${shown(id)} has no messages list`);
      const had = convs.get(id);
      if (had && had.c.messages.length > c.messages.length) continue;
      convs.delete(id); // the copy taken also takes the later place
      convs.set(id, { id, c, source: e.label || "" });
    }
  }
  return { conversations: [...convs.values()], characters, sources: exports.map((e) => e.label || "") };
}

const characterOf = (chars, c) => (Object.hasOwn(chars, String(c.character_id)) ? obj(chars[String(c.character_id)]) : null) || {};
const nameOf = (chars, c) => pyStrip(str(characterOf(chars, c).name) || str(obj(c.character)?.name)) || "Unknown character";

// One conversation → { title, messages, text, short } (short: fewer messages than the
// site's own count)
export function render({ id, c, source }, characters, { user = "User", site = "Character chat", timeZone = "UTC" } = {}) {
  const msgs = c.messages.filter(obj);
  const meta = obj(c.meta) || {};
  const ch = characterOf(characters, c);
  const name = nameOf(characters, c);
  const label = pyStrip(str(meta.label));
  const persona = pyStrip(str(obj(meta.userPersona)?.name)) || user;
  const count = typeof meta.num_messages === "number" ? meta.num_messages : null;
  const creator = str(ch.creator_username);
  const first = minute(msgs[0]?.createdAt, timeZone), last = minute(msgs.at(-1)?.createdAt, timeZone);
  const gap = count === null ? `${msgs.length} messages saved (the site gives no count)` :
    count === msgs.length ? `${msgs.length} messages, as many as the site counts` :
      `${msgs.length} messages saved of ${count} the site counts (the gap is probably regenerated or deleted replies; not checked)`;
  const lines = [
    `# ${label || name}`,
    "",
    `${site} conversation with **${name}**${creator ? ` (character by ${creator})` : ""}, ${first} to ${last}; ${gap}. ` +
      `Source: ${codeSpan(source) || "(unnamed)"}, conversation ${codeSpan(id)}.`,
    "",
  ];
  for (const m of msgs) {
    const who = m.role === "user" ? persona : name;
    lines.push(`## ${who} · ${minute(m.createdAt, timeZone)}`, "", pyStrip(str(m.content)), "");
  }
  return { title: label || name, name, messages: msgs.length, text: lines.join("\n"), short: count !== null && count > msgs.length };
}

// a table cell: one line, pipes escaped
const cell = (s) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");

// Every file to write: { files: [{ name, text }], stats }. Conversations with no messages
// are left out (counted). File names (safeTitle, and * ? " < > | as "-"): the
// conversation's label, else "Name YYYY-MM-DD"
// (its first message's day); two that would share a name (on a case-blind disk too, and
// INDEX.md and CARDS.md included) get " (2)", " (3)"… in the export's order.
export function plan(collected, { user, site = "Character chat", timeZone = "UTC" } = {}) {
  const opts = { user, site, timeZone };
  const taken = new Set(["index.md", "cards.md"]);
  const files = [], rows = [];
  let empty = 0, short = 0, messages = 0;
  for (const conv of collected.conversations) {
    const msgs = conv.c.messages.filter(obj);
    if (!msgs.length) { empty++; continue; }
    const r = render(conv, collected.characters, opts);
    const meta = obj(conv.c.meta) || {};
    const day = minute(msgs[0].createdAt, timeZone).slice(0, 10) || "undated";
    // also no * ? " < > |, as the converter this ports (Windows forbids them too)
    const base = safeTitle(pyStrip(str(meta.label)) || `${r.name} ${day}`).replace(/[*?"<>|]/g, "-");
    let name = base;
    for (let n = 2; taken.has(`${name}.md`.toLowerCase()); n++) name = `${base} (${n})`;
    taken.add(`${name}.md`.toLowerCase());
    files.push({ name: `${name}.md`, text: r.text });
    rows.push({ at: ms(msgs[0].createdAt) ?? Infinity, name, character: r.name, messages: r.messages, from: day, to: minute(msgs.at(-1).createdAt, timeZone).slice(0, 10) });
    messages += r.messages;
    if (r.short) short++;
  }
  // oldest first, then by file name (plain comparison, as the original's tuple sort)
  rows.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const from = collected.sources.map((s) => codeSpan(s) || "(unnamed)").join(", ");
  const index = [`# ${site} conversations`, "", `Built by \`leket convert character-chat\` from ${from}. Oldest first.`, "",
    "| File | Character | Messages | From | To |", "|---|---|---|---|---|",
    ...rows.map((r) => `| ${cell(codeSpan(`${r.name}.md`))} | ${cell(r.character)} | ${r.messages} | ${r.from} | ${r.to} |`)];
  files.push({ name: "INDEX.md", text: `${index.join("\n")}\n` });
  const cards = [`# Character cards as ${site} served them`, ""];
  const chars = Object.entries(collected.characters).filter(([, ch]) => str(ch.name));
  chars.sort(([, a], [, b]) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const [cid, ch] of chars) {
    const creator = str(ch.creator_username);
    cards.push(`## ${pyStrip(ch.name)}${creator ? ` (by ${creator})` : ""}`, "", `${codeSpan(cid)} · ${str(ch.title)}`, "");
    for (const field of ["persona", "scenario", "greeting", "dialogue"]) {
      if (str(ch[field])) cards.push(`**${field}:**`, "", pyStrip(ch[field]), "");
    }
  }
  files.push({ name: "CARDS.md", text: cards.join("\n") });
  const missing = Object.values(collected.characters).filter((ch) => !str(ch.name)).length;
  return { files, stats: { conversations: rows.length, messages, empty, short, cards: chars.length, missing } };
}
