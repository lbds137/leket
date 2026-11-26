// `leket convert signal`: a conversation that signalbackup-tools exported as text
// (`--exporttxt`: one "Name (_idN).txt" per conversation) → one Markdown transcript, in
// the shape `leket convert discord` writes:
//
//   # Signal with Sam
//
//   Source: `Sam Rivera (_id3).txt`, a conversation exported as text by signalbackup-tools.
//   N messages, YYYY-MM-DD to YYYY-MM-DD. Times are as exported (the exporting computer's local time). …
//
//   ## YYYY-MM-DD (Day)
//
//   > -# Sam — Mon D YYYY H:MM PM
//   > the text, line by line
//   >
//
// The export's lines: "[Mon DD, YYYY HH:MM:SS] <Name> text" starts a message, whose later
// lines follow it unmarked (a poll's options among them); "[…] *** <Name> sent file …"
// is a file (shown in brackets: the export holds only its name or type); "[…] *** text"
// is one of Signal's own events (a call, a safety number change, a member leaving).
// Reactions are already in the text, in parentheses. Times are the exporting computer's
// clock, with no zone: they are shown as written, never converted.
//
// A port of a private converter, as it was, made generic: names and the zone's label
// are options. The deliberate differences:
//   - a Signal event is its own entry, from "Signal", counted apart from the messages
//     (the original read it as more text of the message before, or dropped it when it
//     came first)
//   - a name is the label --name gives the export's display name, else its first word
//     (the original showed its owner's name as a fixed label); an empty name is shown
//     as "(no name)" (the original stopped)
//   - a header whose date can't be read (a month not in English, a day that doesn't
//     exist) stops the run with its line number, as the original did, saying which line
//   - a file with no message stops with a message (the original failed on it), and the
//     transcript ends in a line break
//
// Pure: no file access. bin/leket.js reads the files and writes what plan() returns.
import { clock } from "../modules/discord/convert.js";
import { PYSPACE, safeTitle } from "./common.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// the date as the export writes it (strftime "%b %d, %Y %H:%M:%S" in the exporter's locale;
// \p{L}: a month in another language is still seen as a header, and refused)
const DATE = String.raw`\[(\p{L}{3}) (\d{2}), (\d{4}) (\d{2}):(\d{2}):(\d{2})\] `;
// s: the text can hold line and paragraph separators, which a plain . skips
const MESSAGE = new RegExp(`^${DATE}(\\*\\*\\* )?<([^>]*)> ?(.*)$`, "su");
const EVENT = new RegExp(`^${DATE}\\*\\*\\* (.*)$`, "su");
const RSTRIP = new RegExp(`[${PYSPACE}]+$`);
const local = clock("UTC"); // the times have no zone: kept as UTC so they print as written

// "Sam Rivera (_id3).txt" → "Sam Rivera"
export const conversationName = (file) => String(file).replace(/\.txt$/i, "").replace(/ \(_id\d+\)$/, "");

// The text of one export → { entries: [{ ms, who, event, lines }], messages, events }.
// who is the display name (null for a Signal event). Throws on a header whose date
// can't be read, naming its line.
export function parse(text) {
  // as Python reads a text file: \r\n, \r and \n end a line, nothing else does
  const lines = String(text).split(/\r\n?|\n/);
  if (lines.at(-1) === "") lines.pop();
  const entries = [];
  let messages = 0, events = 0;
  for (const [i, line] of lines.entries()) {
    const m = MESSAGE.exec(line) || EVENT.exec(line);
    if (!m) {
      entries.at(-1)?.lines.push(line); // a line before the first header has no message to go in
      continue;
    }
    const [, mon, d, y, hh, mm, ss] = m;
    const month = MON.indexOf(mon);
    const ms = Date.UTC(+y, month, +d, +hh, +mm, +ss);
    const t = new Date(ms);
    if (month < 0 || t.getUTCDate() !== +d || t.getUTCHours() !== +hh || +mm > 59 || +ss > 59) {
      throw new Error(`line ${i + 1}: can't read the date "${mon} ${d}, ${y} ${hh}:${mm}:${ss}" (the export's months must be in English)`);
    }
    // groups 1-6 are the date; then EVENT has its text, MESSAGE its "*** ", name and text
    if (m.length === 8) {
      entries.push({ ms, who: null, event: true, lines: [`[${m[7]}]`] });
      events++;
    } else {
      const body = m[7] ? `[${m[9]}]` : m[9];
      entries.push({ ms, who: m[8], event: false, lines: [body] });
      messages++;
    }
  }
  return { entries, messages, events };
}

// A display name's label: the one names gives it (a plain object, own keys only), else
// its first word, as the original showed it
const labelOf = (names) => (who) =>
  (Object.hasOwn(names, who) && names[who]) || who.split(/\s+/).find(Boolean) || "(no name)";

// One conversation → Markdown.
export function render({ entries, messages, events }, { source, title, names = {}, timeZone = "" }) {
  const label = labelOf(names);
  const zone = timeZone ? `, in ${timeZone}` : " (the exporting computer's local time)";
  const L = [`# ${title}`, "",
    `Source: \`${source}\`, a conversation exported as text by signalbackup-tools.`,
    `${messages} messages, ${local(entries[0].ms).date} to ${local(entries.at(-1).ms).date}. `
    + `Times are as exported${zone}. Reactions appear in parentheses after the message they were added to; `
    + "files as [sent file …] (the files are not exported)."
    + (events ? ` ${events} of Signal's own events (calls, safety number changes, members joining or leaving) appear from "Signal".` : ""), ""];
  let day = null;
  for (const e of entries) {
    const t = local(e.ms);
    if (t.date !== day) {
      day = t.date;
      if (L.at(-1) === ">") L[L.length - 1] = "";
      L.push(`## ${t.date} (${t.weekday})`, "");
    }
    L.push(`> -# ${e.event ? "Signal" : label(e.who)} — ${t.stamp}`);
    for (const b of e.lines) L.push(`> ${b}`.replace(RSTRIP, ""));
    L.push(">");
  }
  return `${L.join("\n")}\n`;
}

// [{ file, text }] (file: the export's file name) → { files: [{ name, text }], stats }.
// Names: "base.md" when a base is given (one export only), else "signal-Name.md"; two that
// would share one (on a case-blind disk too) get a count added. title: the heading (one
// export only), default "Signal with Name". A file with no message throws, naming it.
export function plan(exports, { title, base, names = {}, timeZone = "" } = {}) {
  const files = [], taken = new Set();
  const stats = { conversations: 0, messages: 0, events: 0 };
  for (const { file, text } of exports) {
    let parsed;
    try {
      parsed = parse(text);
    } catch (e) {
      throw new Error(`${file}: ${e.message}`);
    }
    if (!parsed.entries.length) throw new Error(`${file} holds no message (is it a signalbackup-tools --exporttxt file?)`);
    const name = conversationName(file);
    const stem = base || `signal-${safeTitle(name)}`;
    let out = `${stem}.md`;
    for (let k = 2; taken.has(out.toLowerCase()); k++) out = `${stem} (${k}).md`;
    taken.add(out.toLowerCase());
    files.push({ name: out, text: render(parsed, { source: file, title: title || `Signal with ${name}`, names, timeZone }) });
    stats.conversations++;
    stats.messages += parsed.messages;
    stats.events += parsed.events;
  }
  return { files, stats };
}
