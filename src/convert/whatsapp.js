// `leket convert whatsapp`: a chat WhatsApp exported as text (Export chat → Without
// media, or the .txt inside the "With media" zip) → one Markdown transcript, in the shape
// `leket convert discord` writes:
//
//   # WhatsApp with Sam
//
//   Source: `WhatsApp Chat with Sam.txt`, a chat exported with WhatsApp's Export chat.
//   N messages, YYYY-MM-DD to YYYY-MM-DD. Times are as the phone showed them (…). …
//
//   ## YYYY-MM-DD (Day)
//
//   > -# Sam — Mon D YYYY H:MM PM
//   > the text, line by line
//   >
//   > [WhatsApp, Mon D YYYY H:MM PM: one of WhatsApp's own notices]
//   >
//
// The one header shape read: "d.m.yyyy, H:MM - " (day first, 24-hour clock), which some
// phone languages write, with any bidi marks before it. "Name: text" after it starts a
// message; anything else is one of WhatsApp's own notices (encryption, a member added, a
// subject changed). Lines without a header continue the entry above. An attached file is
// a line of the message, under the name the export gave it ("<Media omitted>" without
// media). Times are the phone's clock, with no zone: shown as written, never converted.
//
// A port of a private converter, as it was, made generic: names and the zone's label
// are options. The deliberate differences:
//   - a sender is whatever comes before the line's first ": " (the original took only the
//     names it was given, reading anyone else's line as a notice); a notice holding ": "
//     (a group subject with one) is read as a message from its first part: the summary on
//     stderr lists each sender, so one shows
//   - a sender's label is the one --name gives, else the name as written (a phone number,
//     for a contact not saved), bidi marks taken out
//   - bidi marks are taken out of names and text, the isolates and overrides too (the
//     original took out LRM, RLM, LRE, RLE and PDF only)
//   - a blank line inside a message is kept, so paragraphs stay apart (the original dropped
//     it); a notice's later lines are still joined with spaces
//   - a "<" that would start an HTML tag is escaped, so "<Media omitted>" shows
//   - a byte order mark before the first line is passed over (the original lost that line)
//   - a date that doesn't exist stops the run with its line number (the original stopped
//     without one); a file with no message stops with a message (the original failed on
//     it); the transcript ends in a line break
//
// Pure: no file access. bin/leket.js reads the files and writes what plan() returns.
import { clock } from "../modules/discord/convert.js";
import { WIDE } from "../lib/shown.js";
import { codeSpan } from "../lib/html-md.js";
import { PYSPACE, blank, escapeTag, safeTitle, span } from "./common.js";

// the bidi controls (not the line and paragraph separators WIDE also lists)
const BIDI = String.fromCharCode(...WIDE.filter((c) => c !== 0x2028 && c !== 0x2029));
const UNBIDI = new RegExp(`[${BIDI}]`, "g");
const unbidi = (s) => s.replace(UNBIDI, "");
// s: the text can hold line and paragraph separators, which a plain . skips
const HEAD = new RegExp(String.raw`^[${BIDI}]*(?<d>\d{1,2})\.(?<mo>\d{1,2})\.(?<y>\d{4}), (?<hh>\d{1,2}):(?<mm>\d{2}) - (?<rest>.*)$`, "su");
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const RSTRIP = new RegExp(`[${PYSPACE}]+$`);
const local = clock("UTC"); // the times have no zone: kept as UTC so they print as written

// "WhatsApp Chat with Sam.txt" → "Sam"; another name loses only its .txt
export const conversationName = (file) => String(file).replace(/\.txt$/i, "").replace(/^WhatsApp Chat with /i, "");

// The text of one export → { entries: [{ ms, who, lines }], messages, notices }. who is
// the sender as written, bidi marks out (null for a notice). Throws on a header whose date
// doesn't exist, naming its line.
export function parse(text) {
  // as Python reads a text file: \r\n, \r and \n end a line, nothing else does
  const lines = String(text).replace(BOM, "").split(/\r\n?|\n/);
  if (lines.at(-1) === "") lines.pop();
  const entries = [];
  let messages = 0, notices = 0;
  for (const [i, line] of lines.entries()) {
    const m = HEAD.exec(line);
    if (!m) {
      const e = entries.at(-1); // a line before the first header has no entry to go in
      if (e && (e.who !== null || !blank(unbidi(line)))) e.lines.push(line);
      continue;
    }
    const { d, mo, y, hh, mm, rest } = m.groups;
    const t = new Date(Date.UTC(2000, +mo - 1, +d, +hh, +mm));
    t.setUTCFullYear(+y, +mo - 1, +d); // Date.UTC reads years 0-99 as 1900-1999
    if (+y < 1000 || t.getUTCMonth() !== +mo - 1 || t.getUTCDate() !== +d || t.getUTCHours() !== +hh || +mm > 59) {
      throw new Error(`line ${i + 1}: can't read the date "${d}.${mo}.${y}, ${hh}:${mm}"`);
    }
    const ms = t.getTime();
    const sep = rest.indexOf(": ");
    const who = sep > 0 ? unbidi(rest.slice(0, sep)) : "";
    if (!blank(who)) { // a name of bidi marks or spaces alone is no name: the line is a notice
      entries.push({ ms, who, lines: [rest.slice(sep + 2)] });
      messages++;
    } else {
      entries.push({ ms, who: null, lines: [rest] });
      notices++;
    }
  }
  return { entries, messages, notices };
}

// A sender's label: the one names gives it (a plain object, own keys only), else the name
const labelOf = (names) => (who) => escapeTag((Object.hasOwn(names, who) && names[who]) || who.trim());
const shownLine = (s) => escapeTag(unbidi(s));

// One conversation → Markdown.
export function render({ entries, messages, notices }, { source, title, names = {}, timeZone = "" }) {
  const label = labelOf(names);
  const [first, last] = span(entries.filter((e) => e.who !== null).map((e) => e.ms));
  const zone = timeZone ? `, in ${timeZone}` : " (the phone's local time, with no zone)";
  const L = [`# ${title}`, "",
    `Source: ${codeSpan(source) || "(unnamed)"}, a chat exported with WhatsApp's Export chat.`,
    `${messages} messages, ${local(first).date} to ${local(last).date}. `
    + `Times are as the phone showed them${zone}. Attached files appear under the names the export gave them.`
    + (notices ? ` ${notices} of WhatsApp's own notices appear as [WhatsApp, time: notice].` : ""), ""];
  let day = null;
  for (const e of entries) {
    const t = local(e.ms);
    if (t.date !== day) {
      day = t.date;
      if (L.at(-1) === ">") L[L.length - 1] = "";
      L.push(`## ${t.date} (${t.weekday})`, "");
    }
    if (e.who === null) L.push(`> [WhatsApp, ${t.stamp}: ${shownLine(e.lines.join(" ")).replace(RSTRIP, "")}]`);
    else {
      L.push(`> -# ${label(e.who)} — ${t.stamp}`);
      let end = e.lines.length; // blank lines closing a message would only double the ">" after it
      while (end > 1 && blank(unbidi(e.lines[end - 1]))) end--;
      for (const b of e.lines.slice(0, end)) L.push(`> ${shownLine(b)}`.replace(RSTRIP, ""));
    }
    L.push(">");
  }
  return `${L.join("\n")}\n`;
}

// [{ file, text }] (file: the export's file name) → { files: [{ name, text }], stats }.
// Names: "base.md" when a base is given (one export only), else "whatsapp-Name.md"; two
// that would share one (on a case-blind disk too) get a count added. title: the heading
// (one export only), default "WhatsApp with Name". stats.senders: { name: messages }
// across them all. A file with no message throws, naming it.
export function plan(exports, { title, base, names = {}, timeZone = "" } = {}) {
  const files = [], taken = new Set();
  const stats = { conversations: 0, messages: 0, notices: 0, senders: Object.create(null) };
  for (const { file, text } of exports) {
    let parsed;
    try {
      parsed = parse(text);
    } catch (e) {
      throw new Error(`${file}: ${e.message}`);
    }
    if (!parsed.messages) throw new Error(`${file} holds no message (is it a WhatsApp chat export, with dates written d.m.yyyy, H:MM?)`);
    const name = conversationName(file);
    const stem = base || `whatsapp-${safeTitle(name)}`;
    let out = `${stem}.md`;
    for (let k = 2; taken.has(out.toLowerCase()); k++) out = `${stem} (${k}).md`;
    taken.add(out.toLowerCase());
    files.push({ name: out, text: render(parsed, { source: file, title: title || `WhatsApp with ${name}`, names, timeZone }) });
    stats.conversations++;
    stats.messages += parsed.messages;
    stats.notices += parsed.notices;
    for (const e of parsed.entries) if (e.who !== null) stats.senders[e.who] = (stats.senders[e.who] || 0) + 1;
  }
  return { files, stats };
}
