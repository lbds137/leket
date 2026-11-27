// `leket convert google-chat`: a Google Chat Takeout (`Google Chat/Groups/<conversation
// folder>/messages.json`) → one Markdown transcript per conversation, in the shape
// `leket convert discord` and `leket convert google-voice` write:
//
//   # Google Chat with Project Space
//
//   Source: 1 Google Chat Takeout file, from `Project Space`.
//   12 messages, 2025-03-01 to 2025-03-02. Times are America/New_York. Attachments appear as `[attachment: name]` (files are not copied).
//
//   ## YYYY-MM-DD (Day)
//
//   > -# Ava R. — Mar 1 2025 3:04 PM
//   > the text, line by line
//   > [attachment: notes.pdf]
//   >
//
// Each `messages.json` is an object `{ messages: [row, …] }`, where each row carries
// `creator.name`, a Hebrew-locale `created_date` ("26 בנובמבר 2026 בשעה 20:11:40 UTC"),
// `text` and `attached_files` (`[{ original_name, export_name }]`). A row whose
// `created_date` key is absent inherits the previous row's raw `created_date` (transitively)
// before parsing, and its text is prefixed `[no date in the export] `; a row after an
// unparseable date inherits that bad string, and both then skip as undated.
//
// A port of a private converter, made generic: names and the time zone are options. The
// deliberate differences:
//   - generic options (`--me`, `--owner`, `--name`, `--tz` default UTC, `--title`, `--out`)
//     replace a hardcoded owner name, sender map and fixed `America/New_York` time zone;
//     the default owner set is empty, so without `--owner` every row shows as written
//   - date normalization replaces both U+202F and U+00A0 with a plain space (the original
//     replaced only U+202F)
//   - skip-not-crash: an undated first row (nothing to inherit), a non-string
//     `created_date`, a date that doesn't match the Hebrew Takeout grammar or an unknown
//     month word is skipped and counted in `stats.undated` rather than crashing or exiting;
//     a conversation with zero messages is skipped and counted in `stats.empty`
//   - non-owner names not mapped by `--name` are shown as written (whitespace collapsed),
//     rather than shortened to their first name
//   - an attachment with neither `original_name` nor `export_name` falls back to `unknown`
//     rather than printing Python's literal `None`
//   - output files are named `google-chat-<safeTitle(folder label)>.md` with collision
//     numbering (`name (2).md`); `--title` changes the heading only, never the file name
//
// Pure: no file access. bin/leket.js reads the files and writes what plan() returns.
import { clock } from "../modules/discord/convert.js";
import { codeSpan } from "../lib/html-md.js";
import { escapeTag, pyStrip, safeTitle, span, word } from "./common.js";

const NBSP = new RegExp(`[${String.fromCharCode(0x202f)}${String.fromCharCode(0xa0)}]`, "g");
const DATE = /(\d{1,2}) ב-?(\S+) (\d{4}) בשעה (\d{1,2}):(\d{2}):(\d{2}) UTC/;
const MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

function parseDate(s) {
  if (typeof s !== "string") return null;
  const m = DATE.exec(s.replace(NBSP, " "));
  if (!m) return null;
  const [, d, mon, y, hh, mm, ss] = m;
  const mo = MONTHS.indexOf(mon);
  if (mo < 0) return null;
  const [D, H, M, S] = [+d, +hh, +mm, +ss];
  const ms = Date.UTC(+y, mo, D, H, M, S);
  // Date.UTC rolls impossible values over (31 February becomes March 3, hour 25 the next
  // day): reject whatever doesn't round-trip, as a date that "doesn't match the grammar"
  const t = new Date(ms);
  if (t.getUTCDate() !== D || t.getUTCHours() !== H || t.getUTCMinutes() !== M || t.getUTCSeconds() !== S) return null;
  return ms;
}

function render(c, { title, timeZone = "UTC" }) {
  const local = clock(timeZone);
  const [first, last] = span(c.rows.map((r) => r.ms));
  const from = c.folder ? `, from ${codeSpan(c.folder)}` : "";
  const placed = c.placed
    ? ` ${word(c.placed, "message")} had no date in the export and ${c.placed === 1 ? "is" : "are"} placed after the message before them.`
    : "";
  const L = [
    `# ${title || `Google Chat with ${escapeTag(c.label)}`}`,
    "",
    `Source: 1 Google Chat Takeout file${from}.`,
    `${word(c.rows.length, "message")}, ${local(first).date} to ${local(last).date}. Times are ${timeZone}. `
      + `Attachments appear as \`[attachment: name]\` (files are not copied).${placed}`,
    "",
  ];
  let day = null;
  for (const r of c.rows) {
    const t = local(r.ms);
    if (t.date !== day) {
      day = t.date;
      if (L.at(-1) === ">") L[L.length - 1] = "";
      L.push(`## ${t.date} (${t.weekday})`, "");
    }
    L.push(`> -# ${r.label} — ${t.stamp}`);
    for (const line of r.lines) L.push(line);
    L.push(">");
  }
  return `${L.join("\n")}\n`;
}

// [{ folder, file, data }] → { files: [{ name, text }], stats }
export function plan(inputs, { title, me = "Me", owners = [], names = {}, timeZone = "UTC" } = {}) {
  const ownerSet = new Set(owners);
  const stats = {
    files: 0, messages: 0, fromOwner: 0, placed: 0,
    undated: 0, empty: 0, notExports: 0, senders: Object.create(null),
  };
  const convs = [];
  for (const { folder = "", file = "", data } of inputs) {
    if ((file && !/\.json$/i.test(file)) || data === null || data === undefined) {
      stats.notExports++;
      continue;
    }
    const list = data && typeof data === "object" && Array.isArray(data.messages) ? data.messages : [];
    const resolved = [];
    let prevDate, hasPrev = false;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") { stats.undated++; continue; }
      if (!Object.hasOwn(raw, "created_date") || raw.created_date === undefined) {
        if (!hasPrev) { stats.undated++; continue; }
        resolved.push({ raw, createdDate: prevDate, placed: true });
      } else {
        prevDate = raw.created_date;
        hasPrev = true;
        resolved.push({ raw, createdDate: raw.created_date, placed: false });
      }
    }
    const rows = [];
    let placed = 0;
    for (const { raw, createdDate, placed: isPlaced } of resolved) {
      const ms = parseDate(createdDate);
      if (ms === null) { stats.undated++; continue; }
      if (isPlaced) placed++;
      const rawWho = typeof raw.creator?.name === "string" ? raw.creator.name.replace(/\s+/g, " ").trim() : "";
      const who = rawWho || "?";
      const isOwner = ownerSet.has(who);
      const sender = isOwner ? me : (Object.hasOwn(names, who) && names[who]) || who;
      const rawText = typeof raw.text === "string" && raw.text ? raw.text : "";
      const text = isPlaced ? `[no date in the export] ${rawText}` : rawText;
      const lines = [];
      if (text) for (const line of text.split("\n")) lines.push(pyStrip(`> ${escapeTag(line)}`));
      if (Array.isArray(raw.attached_files)) {
        for (const a of raw.attached_files) {
          const att = (a && typeof a === "object" && (a.original_name || a.export_name)) || "unknown";
          lines.push(pyStrip(`> [attachment: ${escapeTag(att)}]`));
        }
      }
      if (!lines.length) lines.push("> [no text]");
      rows.push({ ms, who, isOwner, label: escapeTag(sender), lines });
    }
    if (!rows.length) {
      stats.empty++;
      continue;
    }
    rows.sort((a, b) => a.ms - b.ms);
    // a loose .json input's label is its file name minus the extension (a loose
    // messages.json arrives with its parent folder's name from the bin side)
    const label = folder || String(file).replace(/^.*[/\\]/, "").replace(/\.json$/i, "");
    convs.push({ folder, label, rows, placed });
  }
  if (!convs.length) {
    throw new Error(`the ${word(inputs.length, "input path")} given hold${inputs.length === 1 ? "s" : ""} no Google Chat messages`);
  }
  const files = [], taken = new Set();
  for (const c of convs) {
    const stem = `google-chat-${safeTitle(c.label)}`;
    let name = `${stem}.md`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${stem} (${k}).md`;
    taken.add(name.toLowerCase());
    files.push({ name, text: render(c, { title, timeZone }) });
    stats.files++;
    stats.messages += c.rows.length;
    stats.placed += c.placed;
    for (const r of c.rows) {
      if (r.isOwner) stats.fromOwner++;
      stats.senders[r.who] = (stats.senders[r.who] || 0) + 1;
    }
  }
  return { files, stats };
}
