// `leket convert aim`: AIM chat logs saved as HTML, one page per chat session, each
// starting "<h1>Chatlog between <span class="sender">you</span> and <span
// class="receiver">them</span> on <span title="…">Weekday, Month D, YYYY at HH:MM:SS</span>
// </h1>" → one Markdown transcript of every log given, in the shape `leket convert
// discord` writes:
//
//   # AIM with buddy123
//
//   Source: N AIM chat logs saved as HTML, from `buddy123`.
//   N messages, YYYY-MM-DD to YYYY-MM-DD. Times are as logged (…). …
//
//   ## YYYY-MM-DD (Day)
//
//   > -# buddy123 — Mon D YYYY H:MM PM
//   > the text, line by line
//   >
//
// After the heading, an entry starts at the start of a line, as
//   <span class='ImSend'>[HH:MM] name</span>: text      (sent by the log's owner)
//   <span class='ImReceive'>[HH:MM] name</span>: text   (received)
//   [HH:MM] name (auto-response from name) text         (an away message's reply)
// and runs to the next entry; its text is HTML (<br>, <b>, <a href>), ending in <br/>.
// A message carries only HH:MM: its date is the session's start, moved a day on each time
// the clock goes back (a session that runs past midnight). Times have no zone: shown as
// written, never converted.
//
// A port of a private converter, made generic: names and the zone's label are options,
// and all the logs given make one transcript, as that converter wrote (the logs of one
// person, under one screen name or several). The deliberate differences:
//   - a message runs to the next entry: the original read it to the first <br/> on its
//     own line, dropping a message that went on over more lines (the <br> ones)
//   - an auto-response is kept, marked "(auto-response)" (the original dropped it)
//   - the text is converted as HTML: line breaks stay, bold and links become Markdown, and
//     Markdown's own characters are escaped (the original took tags out, fusing lines)
//   - day headings and full stamps, as the other converters write (the original wrote one
//     heading per log, with the clock time alone on each message)
//   - a sent message is labelled by --me when given, else by name; a name's label is the
//     one --name gives it, matched as AIM matched screen names, ignoring case and spaces,
//     else the name as written (the original labelled one screen name and gave every
//     other the contact's label)
//
// Pure: no file access. bin/leket.js reads the files and writes what plan() returns.
import { clock } from "../modules/discord/convert.js";
import { codeSpan, decode, htmlToMarkdown } from "../lib/html-md.js";
import { escapeTag, safeTitle, span } from "./common.js";

const local = clock("UTC"); // the times have no zone: kept as UTC so they print as written
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HEADING = /<h1>Chatlog between <span class="sender">([^<]*)<\/span> and <span class="receiver">([^<]*)<\/span> on <span[^>]*>[A-Za-z]+, ([A-Za-z]+) +(\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}):(\d{2})<\/span><\/h1>/;
const ENTRY = /^(?:<span class=(['"])Im(Send|Receive)\1>\[(\d{1,2}):(\d{2})\] ([^<]*)<\/span>: |\[(\d{1,2}):(\d{2})\] ([^<\n]*?) \([Aa]uto-response from [^<\n)]*\) ?)/gm;

// A screen name as AIM compared them: case and spaces don't count
export const screenKey = (name) => String(name).toLowerCase().replace(/\s+/g, "");

// A date from its parts, or null when it doesn't exist (Date.UTC reads years 0-99 as 1900-1999)
function utc(y, mo, d, hh, mm, ss = 0) {
  const t = new Date(Date.UTC(2000, mo, d, hh, mm, ss));
  t.setUTCFullYear(y, mo, d);
  const ok = y >= 1000 && t.getUTCMonth() === mo && t.getUTCDate() === d && hh < 24 && mm < 60 && ss < 60;
  return ok ? t.getTime() : null;
}

// One log's HTML → { owner, contact, start, entries: [{ ms, who, sent, auto, html }], unknown }.
// owner and contact: the heading's two names; start: the session's start (ms, as written);
// html: the entry's text, its closing <br/> taken off. Throws when the heading is missing
// or its date or a message's time doesn't exist.
export function parse(html) {
  const text = String(html);
  const h = HEADING.exec(text);
  if (!h) throw new Error(`no "Chatlog between … and …" heading (is it an AIM chat log saved as HTML?)`);
  const [, owner, contact, month, d, y, hh, mm, ss] = h;
  const start = utc(+y, MONTHS.indexOf(month), +d, +hh, +mm, +ss);
  if (start === null || MONTHS.indexOf(month) < 0) throw new Error(`can't read the heading's date "${month} ${d}, ${y} at ${hh}:${mm}:${ss}"`);
  const body = text.slice(h.index + h[0].length);
  const starts = [...body.matchAll(ENTRY)];
  const entries = [];
  let prev = ((start % 86400000) + 86400000) % 86400000, day = start - prev; // before 1970 too
  for (const [i, m] of starts.entries()) {
    const [, , side, sh, sm, sname, ah, am, aname] = m;
    const [eh, em] = side ? [+sh, +sm] : [+ah, +am];
    if (eh > 23 || em > 59) throw new Error(`can't read the time "${eh}:${String(em).padStart(2, "0")}"`);
    let t = (eh * 60 + em) * 60000;
    // the clock went back: past midnight. A message logged in the session's first minute
    // reads earlier than its start's seconds, so the minute counts, not the seconds
    if (t < prev - (prev % 60000)) day += 86400000;
    prev = t;
    t += day;
    const end = i + 1 < starts.length ? starts[i + 1].index : body.length;
    const raw = body.slice(m.index + m[0].length, end).replace(/\s*(?:<br\s*\/?>\s*)?$/i, "");
    const who = decode(side ? sname : aname).trim();
    // an auto-response carries no side: it is the owner's when it is under the owner's name
    const sent = side ? side === "Send" : screenKey(who) === screenKey(decode(owner));
    entries.push({ ms: t, who, sent, auto: !side, html: raw });
  }
  const before = body.slice(0, starts.length ? starts[0].index : body.length);
  return { owner: decode(owner).trim(), contact: decode(contact).trim(), start, entries, stray: before.trim() ? 1 : 0 };
}

// A sender's label: --me for the owner's side when given; else --name's, by screen name;
// else the name as written
const labelOf = (me, names) => (e) => escapeTag(
  (e.sent && me) || (Object.hasOwn(names, screenKey(e.who)) && names[screenKey(e.who)]) || e.who);

// [{ owner, contact, entries }] (the parsed logs, any order) → Markdown
export function render(logs, { title, sources = [], me = "", names = {}, timeZone = "" }) {
  const label = labelOf(me, names);
  const entries = logs.flatMap((l) => l.entries).sort((a, b) => a.ms - b.ms); // stable: a log's own order kept
  const unknown = Object.create(null);
  const [first, last] = span(entries.map((e) => e.ms));
  const autos = entries.filter((e) => e.auto).length;
  const zone = timeZone ? `, in ${timeZone}` : " (the logging computer's local time, with no zone)";
  const from = sources.map((s) => codeSpan(s)).join(", ");
  const L = [`# ${title}`, "",
    `Source: ${logs.length} AIM chat logs saved as HTML${from ? `, from ${from}` : ""}.`,
    `${entries.length} messages, ${local(first).date} to ${local(last).date}. `
    + `Times are as logged${zone}.`
    + (autos ? ` ${autos === 1 ? "One away-message reply is" : `${autos} away-message replies are`} marked (auto-response).` : ""), ""];
  let day = null;
  for (const e of entries) {
    const t = local(e.ms);
    if (t.date !== day) {
      day = t.date;
      if (L.at(-1) === ">") L[L.length - 1] = "";
      L.push(`## ${t.date} (${t.weekday})`, "");
    }
    L.push(`> -# ${label(e)} — ${t.stamp}${e.auto ? " (auto-response)" : ""}`);
    const { md, unknown: u } = htmlToMarkdown(e.html);
    for (const [k, n] of Object.entries(u)) unknown[k] = (unknown[k] || 0) + n;
    if (md) for (const line of md.split("\n")) L.push(line ? `> ${line}` : ">");
    L.push(">");
  }
  return { text: `${L.join("\n")}\n`, unknown };
}

// [{ folder, file, text }] (folder: the name of the folder the log was in, file: its own
// name) → { files: [{ name, text }], stats }: one transcript of them all. Name: "base.md",
// default "aim-" and the contacts' screen names joined by "+"; title default "AIM with"
// and them. stats.senders: { name as written: messages }; stats.unknown: { tag: count }
// for tags shown as their text; stats.stray: logs with text before their first entry.
// A log that can't be read, or no message in them all, throws, naming it.
export function plan(inputs, { title, base, me = "", names = {}, timeZone = "" } = {}) {
  const logs = [];
  for (const { folder, file, text } of inputs) {
    try {
      logs.push({ ...parse(text), folder });
    } catch (e) {
      throw new Error(`${folder ? `${folder}/` : ""}${file}: ${e.message}`);
    }
  }
  const messages = logs.reduce((n, l) => n + l.entries.length, 0);
  if (!messages) throw new Error(inputs.length === 1 ? `${inputs[0].file} holds no message` : `the ${inputs.length} logs given hold no message`);
  logs.sort((a, b) => a.start - b.start); // contacts and folders are named in the order they first log
  const contacts = [...new Map(logs.map((l) => [screenKey(l.contact), l.contact])).values()];
  const sources = [...new Set(logs.map((l) => l.folder).filter(Boolean))];
  const { text, unknown } = render(logs, { title: title || `AIM with ${contacts.join(", ")}`, sources, me, names, timeZone });
  const senders = Object.create(null);
  for (const l of logs) for (const e of l.entries) senders[e.who] = (senders[e.who] || 0) + 1;
  return {
    files: [{ name: `${base || `aim-${safeTitle(contacts.join("+"))}`}.md`, text }],
    stats: { logs: logs.length, messages, autos: logs.reduce((n, l) => n + l.entries.filter((e) => e.auto).length, 0), senders, unknown, stray: logs.reduce((n, l) => n + l.stray, 0) },
  };
}
