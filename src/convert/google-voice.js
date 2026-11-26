// `leket convert google-voice`: a Google Voice Takeout's `Voice/Calls/` folder (one .html
// per text-thread chunk, placed / received / missed call or voicemail, named
// "<Contact> - <Kind> - <time>.html" or "<Contact> - <time>.html") → one Markdown
// transcript per contact, texts, calls and voicemails together, in the shape `leket convert
// discord` writes:
//
//   # Google Voice with Sam
//
//   Source: 12 Google Voice Takeout files, from `Takeout/Voice/Calls`.
//   147 text messages and 23 calls/voicemails, 2010-06-01 to 2015-04-30. Times are America/New_York. Voicemail text is Google's machine transcript, unchecked; the audio stays in the Takeout.
//
//   ## YYYY-MM-DD (Day)
//
//   > -# Sam — Mon D YYYY H:MM PM
//   > the text, line by line
//   >
//   > -# (call) — Mon D YYYY H:MM PM
//   > voicemail (22s): machine transcript
//   >
//
// Long text threads roll over across more than one file, repeating boundary messages; a
// message or call that appears in more than one file of a contact is kept once. The owner's
// messages are those whose sender name is "Me" or "אני" (a Hebrew-locale export) after
// entity decoding and trimming. Timestamps carry offsets and are shown in --tz (default
// UTC); a dt or published value with no offset is read as this machine's local time, as
// the Python original's naive astimezone() read it. Every `Group Conversation - <time>.html`
// file joins one "Group Conversation" transcript (the original grouped them the same way).
// A file whose kind is known but which yields no row (undated call, message-less text file)
// still counts in `stats.files` and the Source line, as in the original.
//
// A port of a private converter, made generic: names and the time zone are options. The
// deliberate differences:
//   - contacts are discovered from the file names (splitting from the right on " - " before
//     the timestamp and any known kind word) rather than taking one contact prefix; a file
//     with an empty contact or no timestamp part is skipped and counted in stats.notExports
//   - both the bare English kind words and the long forms are recognised in file names, plus
//     the Hebrew words (neither English set is verified against a real English-locale export),
//     and a file whose middle word is none of these keeps that word in the contact name (the
//     kind can still come from the tag link)
//   - the port scans every `http://www.google.com/voice#<tag>` link in the file and prefers a
//     specific tag over `inbox`, where the original read the first link and mapped `inbox`
//     directly; a file with no known kind or tag is skipped and listed in stats.unknownKinds
//   - message and voicemail HTML goes through htmlToMarkdown (entities decoded, <br> as line
//     breaks, bold and links as Markdown, Markdown's own characters escaped) rather than
//     only unescaping entities and turning <br> into newlines
//   - a message whose dt doesn't parse as a date, or a call file with no published time, is
//     skipped and counted in stats.undated rather than crashing
//   - the owner's side is shown as --me (default "Me"); a sender or contact name is shown
//     as --name's label for that exact name, else as written; two contacts whose file names
//     would collide get " (2)" added
//   - rows use the house shape: day headings in --tz and minute-precision stamps, call rows
//     from "(call)" with "call placed by <me> (1h2m3s)", "call answered by <me> (…)",
//     "missed call" or "voicemail (…): <machine transcript>"
//
// Pure: no file access. bin/leket.js reads the files and writes what plan() returns.
import { clock } from "../modules/discord/convert.js";
import { codeSpan, decode, htmlToMarkdown } from "../lib/html-md.js";
import { escapeTag, safeTitle, span } from "./common.js";

const STAMP = /^\d{4}-\d{2}-\d{2}T[\d_]+(?:Z|[+-][\d_]+)?\.html$/i;
const KIND = {
  "שלח הודעת טקסט": "text",
  "בוצעה": "placed",
  "התקבלה": "received",
  "שלא נענתה": "missed",
  "דואר קולי": "voicemail",
  Text: "text",
  Placed: "placed",
  Received: "received",
  Missed: "missed",
  "Text conversation": "text",
  "Placed call": "placed",
  "Received call": "received",
  "Missed call": "missed",
  Voicemail: "voicemail",
};
const TAG = {
  sms: "text",
  placed: "placed",
  received: "received",
  missed: "missed",
  inbox: "voicemail",
  voicemail: "voicemail",
};
const CALL_TEXT = {
  placed: (me) => `call placed by ${me}`,
  received: (me) => `call answered by ${me}`,
  missed: () => "missed call",
  voicemail: () => "voicemail",
};
const MSG = /<div class="message">\s*<abbr class="dt" title="([^"]*)">[\s\S]*?<cite class="sender vcard">([\s\S]*?)<\/cite>:\s*<q>([\s\S]*?)<\/q>/g;
const FN = /<abbr class="fn" title="[^"]*">([\s\S]*?)<\/abbr>|<span class="fn">([\s\S]*?)<\/span>/;
const PUBLISHED = /<abbr class="published" title="([^"]*)"/;
const DURATION = /<abbr class="duration" title="PT([^"]+)"/;
const FULL_TEXT = /<span class="full-text">([\s\S]*?)<\/span>/;
const TAG_LINK = /href="https?:\/\/www\.google\.com\/voice#(\w+)"/g;

function splitFileName(fileName) {
  const parts = String(fileName).split(" - ");
  if (parts.length < 2 || !STAMP.test(parts.at(-1))) return null;
  const head = parts.slice(0, -1);
  const word = head.at(-1);
  const known = Object.hasOwn(KIND, word);
  const contact = (known ? head.slice(0, -1) : head).join(" - ");
  return contact.trim() ? { contact, kind: known ? KIND[word] : null } : null;
}

function kindFromText(text) {
  let inbox = false;
  for (const [, tag] of String(text).matchAll(TAG_LINK)) {
    if (tag === "inbox") inbox = true;
    else if (Object.hasOwn(TAG, tag)) return TAG[tag];
  }
  return inbox ? TAG.inbox : null;
}

// The contact name in a Google Voice export file's name, or null when it isn't one
export const contactOf = (fileName) => splitFileName(fileName)?.contact ?? null;

// A file's kind ("text" | "placed" | "received" | "missed" | "voicemail"), from its name
// first and then its google.com/voice#<tag> link, or null
export function kindOf(fileName, text = "") {
  const s = splitFileName(fileName);
  if (!s) return null;
  return s.kind || kindFromText(text);
}

const word = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function render(c, { title, me = "Me", names = {}, timeZone = "UTC" }) {
  const local = clock(timeZone);
  const contactLabel = (Object.hasOwn(names, c.contact) && names[c.contact]) || c.contact;
  const rows = [];
  let texts = 0;
  for (const r of c.rows.values()) {
    if (r.type === "text") {
      texts++;
      const sender = r.isOwner ? me : (Object.hasOwn(names, r.who) && names[r.who]) || r.who || contactLabel;
      rows.push({ ms: r.ms, label: escapeTag(sender), body: htmlToMarkdown(r.rawBody).md });
    } else {
      const head = `${CALL_TEXT[r.kind](escapeTag(me))}${r.duration ? ` (${r.duration})` : ""}`;
      const vm = r.rawVm ? htmlToMarkdown(r.rawVm).md : "";
      rows.push({ ms: r.ms, label: "(call)", body: vm ? `${head}: ${vm}` : head });
    }
  }
  rows.sort((a, b) => a.ms - b.ms || (a.label < b.label ? -1 : a.label > b.label ? 1 : a.body < b.body ? -1 : a.body > b.body ? 1 : 0));
  const [first, last] = span(rows.map((r) => r.ms));
  const calls = rows.length - texts;
  const folders = [...new Set(c.folders.filter(Boolean))];
  const loose = c.folders.filter((f) => !f).length;
  const from = folders.length
    ? `, from ${folders.map((f) => codeSpan(f)).join(", ")}${loose ? `, ${word(loose, "loose file")}` : ""}`
    : "";
  const L = [
    `# ${title || `Google Voice with ${escapeTag(contactLabel)}`}`,
    "",
    `Source: ${word(c.files.length, "Google Voice Takeout file")}${from}.`,
    `${word(texts, "text message")} and ${word(calls, "call/voicemail", "calls/voicemails")}, `
      + `${local(first).date} to ${local(last).date}. Times are ${timeZone}. `
      + "Voicemail text is Google's machine transcript, unchecked; the audio stays in the Takeout.",
    "",
  ];
  let day = null;
  for (const r of rows) {
    const t = local(r.ms);
    if (t.date !== day) {
      day = t.date;
      if (L.at(-1) === ">") L[L.length - 1] = "";
      L.push(`## ${t.date} (${t.weekday})`, "");
    }
    L.push(`> -# ${r.label} — ${t.stamp}`);
    if (r.body) for (const line of r.body.split("\n")) L.push(line ? `> ${line}` : ">");
    L.push(">");
  }
  return `${L.join("\n")}\n`;
}

// [{ folder, file, text }] → { files: [{ name, text }], stats }
export function plan(inputs, { title, base, me = "Me", names = {}, contact = "", timeZone = "UTC" } = {}) {
  const conversations = new Map();
  const stats = {
    files: 0, contacts: 0, texts: 0, calls: 0, voicemails: 0,
    undated: 0, unknownKinds: [], notExports: 0, senders: Object.create(null),
  };
  let matchedContact = false;
  const contactFiles = []; // every file matched to --contact, kinds aside (for the empty error)
  const conv = (c) => {
    if (!conversations.has(c)) conversations.set(c, { contact: c, files: [], folders: [], rows: new Map() });
    return conversations.get(c);
  };
  for (const { folder = "", file, text } of inputs) {
    const s = splitFileName(file);
    if (contact) {
      if (!s || s.contact !== contact) continue;
      matchedContact = true;
      contactFiles.push(file);
    } else if (!s) {
      stats.notExports++;
      continue;
    }
    const kind = s.kind || kindFromText(text);
    if (!kind) {
      stats.unknownKinds.push(file);
      continue;
    }
    // A file whose kind is known is counted in stats.files and the contact's file list before
    // row extraction, so files yielding no row (an undated call, a message-less text file)
    // still count as in the original's accounting
    stats.files++;
    const c = conv(s.contact);
    c.files.push(file);
    c.folders.push(folder);
    // Dedup pre-label: [ms, isOwner, rawBody] for texts and [ms, kind, duration, rawVm] for
    // calls produce the same groups on real data as the original's post-label tuple set; two
    // different non-owner senders posting the same text in the same second collapse into one
    // row (a group-thread edge), matching the original's key
    if (kind === "text") {
      for (const m of String(text).matchAll(MSG)) {
        const [, when, cite, q] = m;
        const ms = Date.parse(when);
        if (!Number.isFinite(ms)) { stats.undated++; continue; }
        const fn = FN.exec(cite);
        const who = decode(fn ? (fn[1] ?? fn[2]) : "").trim();
        const isOwner = who === "Me" || who === "אני";
        const rawBody = q.trim();
        const key = JSON.stringify(["t", ms, isOwner, rawBody]);
        if (!c.rows.has(key)) c.rows.set(key, { type: "text", ms, who, isOwner, rawBody });
      }
    } else {
      const pub = PUBLISHED.exec(String(text));
      const ms = pub ? Date.parse(pub[1]) : NaN;
      if (!Number.isFinite(ms)) { stats.undated++; continue; }
      const duration = DURATION.exec(String(text))?.[1].toLowerCase() || "";
      const rawVm = FULL_TEXT.exec(String(text))?.[1].trim() || "";
      const key = JSON.stringify(["c", ms, kind, duration, rawVm]);
      if (!c.rows.has(key)) c.rows.set(key, { type: "call", ms, kind, duration, rawVm });
    }
  }
  if (contact && !matchedContact) throw new Error(`no Google Voice files for the contact "${contact}"`);
  // a text file whose messages match nothing is skipped, as the original skipped it; an
  // empty input is an error only when no conversation holds a row at all
  const list = [...conversations.values()].filter((c) => c.rows.size);
  const totalRows = list.reduce((n, c) => n + c.rows.size, 0);
  if (!totalRows) {
    const kept = contact ? contactFiles : inputs.map((x) => x.file);
    throw new Error(kept.length === 1 ? `${kept[0]} holds no message`
      : contact ? `the ${kept.length} files for "${contact}" hold no message` : `the ${kept.length} files given hold no message`);
  }
  for (const c of list) {
    c.earliest = span([...c.rows.values()].map((r) => r.ms))[0]; // span: no spread over a long chat
  }
  list.sort((a, b) => a.earliest - b.earliest || (a.contact < b.contact ? -1 : a.contact > b.contact ? 1 : 0));
  const files = [], taken = new Set();
  for (const c of list) {
    const label = (Object.hasOwn(names, c.contact) && names[c.contact]) || c.contact;
    const stem = base && contact ? base : `google-voice-${safeTitle(label)}`;
    let name = `${stem}.md`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${stem} (${k}).md`;
    taken.add(name.toLowerCase());
    files.push({ name, text: render(c, { title: contact ? title : undefined, me, names, timeZone }) });
    stats.contacts++;
    for (const r of c.rows.values()) {
      if (r.type === "text") {
        stats.texts++;
        const who = r.who || "(unknown)";
        stats.senders[who] = (stats.senders[who] || 0) + 1;
      } else if (r.kind === "voicemail") stats.voicemails++;
      else stats.calls++;
    }
  }
  return { files, stats };
}
