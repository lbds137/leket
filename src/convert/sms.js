// `leket convert sms`: an SMS Backup & Restore backup (the Android app's sms-*.xml) → one
// Markdown transcript per conversation, in the shape `leket convert discord` writes:
//
//   # Texts with Sam
//
//   Source: `sms-1.xml`, made with the SMS Backup & Restore app; only the conversation with the number ending 1234.
//   N messages (SMS and MMS), YYYY-MM-DD to YYYY-MM-DD. Times are ZONE. Attachments appear as `[attachment: filename]`.
//
//   ## YYYY-MM-DD (Day)
//
//   > -# Sam — Mon D YYYY H:MM PM
//   > the text, line by line
//   > [attachment: YYYY-MM-DD_<ms>_<part>_photo.jpg]
//   >
//
// A conversation is the other number's last 10 digits (an address with no digits, such as
// a sender's name, is its own). SMS type 1 is received, 2 sent; drafts, outbox and failed
// sends (3-6) are kept, marked " (not sent)", as are an MMS's (msg_box 3-5: drafts, outbox,
// failed; 1 is received, 2 sent). An MMS's text and attachments are its parts
// (the SMIL layout part is passed over); one dated in seconds is read as such.
// A group MMS (more than one other number) is left out and counted, or with groups kept:
// in the chosen number's conversation when there is one, else as its own conversation,
// each message marked "Sender (group: Name, Name)".
//
// A port of a private converter, as it was, made generic: the names, zone and output
// layout are options. The deliberate differences:
//   - every conversation in the backup gets its own file (the original wrote only the one
//     its number option chose, or the whole backup as one when no number was given)
//   - a number's name comes from the names given, else the backup's contact_name, else "…"
//     and its last 4 digits (the original took one name, for the chosen conversation)
//   - an attachment's file name keeps only characters safe in a file name (the original
//     used the name the sender's phone gave, which could hold "/" or ".."); a cl of "null"
//     falls through to the part's name (the original took the "null"); two that come out
//     alike are numbered, "x (2).jpg" (the original overwrote the first)
//   - with a number, an MMS kept because one of its <addr> lines names that number goes in
//     that conversation, as in the original's one file
//   - a message with no usable date is left out and counted (the original stopped)
//   - an MMS draft, or one in the outbox or failed, is marked " (not sent)" as an SMS is
//     (the original marked only SMS)
//   - the file ends in a line break; the media list is attachments.tsv inside the media
//     folder (the original wrote attachments-sms.tsv beside it)
//   - see src/lib/xml.js for the one way the XML reading differs from Python's
//
// Pure: no file access. Feed the backup's text to messages() a chunk at a time;
// bin/leket.js reads the file, saves the attachments onAttachment hands it, and writes
// what plan() returns.
import { clock } from "../modules/discord/convert.js";
import { reader } from "../lib/xml.js";
import { codeSpan } from "../lib/html-md.js";
import { PYSPACE, escapeTag, safeTitle } from "./common.js";

export const digits = (s) => String(s ?? "").replace(/\D/g, "").slice(-10);
// a conversation's key: the number's last 10 digits, else the address itself (trimmed)
export const keyOf = (address) => digits(address) || String(address ?? "").trim();
const UNKNOWN = new Set(["", "null", "(Unknown)"]);
const RSTRIP = new RegExp(`[${PYSPACE}]+$`);
const isNumber = (key) => /^\d+$/.test(key);
const last4 = (key) => (isNumber(key) ? `…${key.slice(-4)}` : key || "…");

// The backup's messages, by conversation. Options: number (keep only the conversation with
// this number), groups (keep group MMS), timeZone (the day in an attachment's file name),
// media (true: hand each attachment's bytes to onAttachment(name, base64) as it is read).
// feed(chunk) each chunk of the file in order, then end() → { conversations: Map(key →
// { key, group, members, contact, messages: [{ ms, mine, from, group, text, files, note }],
// skippedGroups }), skippedGroups, undated, listed: Map(key → the first name a group MMS
// gave it) }. A group message's from is its sender's key (null for the backup's owner, ""
// when the MMS names none) and its group is { members, listed } (listed: a Map, key → the
// name contact_name gave, when it lines up); names are looked up when rendering.
export function messages({ number = "", groups = false, timeZone = "UTC", media = false, onAttachment = () => {} } = {}) {
  const want = digits(number);
  const conversations = new Map();
  const local = clock(timeZone);
  let undated = 0, skippedGroups = 0;
  const listedNames = new Map(); // key → the first name a group MMS's contact_name gave it
  const fileNames = new Set(); // attachment names given so far (lower case)
  const conv = (key, group = false, members = [key]) => {
    if (!conversations.has(key)) conversations.set(key, { key, group, members, contact: "", messages: [], skippedGroups: 0 });
    return conversations.get(key);
  };
  const dateOf = (v) => {
    const s = String(v ?? "").trim();
    if (!/^\d+$/.test(s)) return NaN;
    const ms = Number(s);
    return Number.isSafeInteger(ms) && ms > 0 && ms <= 8.64e15 ? ms : NaN;
  };
  const contact = (c, name) => { if (!UNKNOWN.has(name ?? "")) c.contact = name; };

  const onSms = (a) => {
    if (want && digits(a.address) !== want) return;
    const ms = dateOf(a.date);
    if (Number.isNaN(ms)) { undated++; return; }
    const c = conv(keyOf(a.address));
    contact(c, a.contact_name);
    const kind = a.type;
    c.messages.push({ ms, mine: kind !== "1", from: null, group: null, text: a.body || "", files: [], note: kind === "1" || kind === "2" ? "" : " (not sent)" });
  };

  const onMms = (a, children) => {
    const others = new Set(children.filter((e) => e.name === "addr").map((e) => digits(e.attrs.address)).filter(Boolean));
    const raw = String(a.address ?? "").split("~");
    const numbers = [...new Set(raw.map(keyOf).filter(Boolean))];
    if (want && !numbers.includes(want) && !others.has(want)) return;
    let ms = dateOf(a.date);
    if (Number.isNaN(ms)) { undated++; return; }
    if (ms < 1e11) ms *= 1000; // some MMS rows carry seconds
    let c, from = null, group = null;
    if (numbers.length > 1) {
      if (!groups) {
        // counted in each member's conversation (only the chosen one's with a number)
        skippedGroups++;
        for (const n of want ? [want] : numbers) conv(n).skippedGroups++;
        return;
      }
      const members = [...numbers].sort();
      c = want ? conv(want) : conv(members.join(","), true, members);
      // contact_name lists only saved contacts, so it lines up with the numbers only when none is unsaved
      const cn = String(a.contact_name ?? "").split(", ");
      const listed = new Map(cn.length === raw.length ? raw.map((n, i) => [keyOf(n), cn[i]]).filter(([, v]) => !UNKNOWN.has(v)) : []);
      for (const [k, v] of listed) if (!listedNames.has(k)) listedNames.set(k, v);
      if (a.msg_box === "1") from = keyOf(children.find((e) => e.name === "addr" && e.attrs.type === "137")?.attrs.address);
      group = { members, listed };
    } else if (want && numbers[0] !== want) {
      c = conv(want); // kept because an <addr> names the number: it belongs with that conversation
    } else {
      c = conv(numbers[0] ?? "");
      contact(c, a.contact_name);
    }
    const day = local(ms).date;
    const text = [], files = [];
    for (const [n, p] of children.filter((e) => e.name === "part").entries()) {
      const ct = p.attrs.ct || "";
      if (ct === "application/smil") continue;
      if (ct === "text/plain") { text.push(p.attrs.text || ""); continue; }
      // the app writes "null" for a field it has no value for
      const name = [p.attrs.cl, p.attrs.name].find((v) => v && v !== "null") || `part${n}.${ct.split("/").at(-1)}`;
      const first = safeTitle(`${day}_${ms}_${n}_${name}`);
      // two MMS from the same second can name a part alike: number the later ones
      const dot = first.lastIndexOf(".") > 0 ? first.lastIndexOf(".") : first.length;
      let fn = first;
      for (let k = 2; fileNames.has(fn.toLowerCase()); k++) fn = `${first.slice(0, dot)} (${k})${first.slice(dot)}`;
      fileNames.add(fn.toLowerCase());
      files.push(fn);
      if (media && p.attrs.data) onAttachment(fn, p.attrs.data);
    }
    const box = a.msg_box;
    c.messages.push({ ms, mine: box !== "1", from, group, text: text.join("\n"), files, note: box === "3" || box === "4" || box === "5" ? " (not sent)" : "" });
  };

  const xml = reader(["sms", "mms"], (el) => (el.name === "sms" ? onSms(el.attrs) : onMms(el.attrs, el.children)));
  const end = () => {
    xml.end();
    for (const c of conversations.values()) c.messages.sort((x, y) => x.ms - y.ms);
    return { conversations, skippedGroups, undated, listed: listedNames };
  };
  return { feed: xml.feed, end };
}

// A number's label: the names given, else what the message's contact_name listed, else
// its conversation's contact name, else the name any group MMS listed for it, else "…1234".
// names is a plain object (own keys only: an address can be "constructor"); the rest are Maps.
const labeler = (conversations, names, groupListed = new Map()) => (key, listed = new Map()) =>
  (Object.hasOwn(names, key) && names[key]) || listed.get(key) || conversations.get(key)?.contact
  || groupListed.get(key) || last4(key);

// One conversation → Markdown. label: labeler()'s function for this backup.
export function render(c, { source, title, me = "Me", label, timeZone = "UTC" }) {
  const local = clock(timeZone);
  const other = c.group ? c.members.map((n) => label(n)).join(", ") : label(c.key);
  const msgs = c.messages;
  const with_ = c.group ? `the group of ${c.members.map(last4).join(", ")}`
    : isNumber(c.key) ? `the number ending ${c.key.slice(-4)}` : c.key ? codeSpan(c.key) : "no address";
  const L = [`# ${title || `Texts with ${other}`}`, "",
    `Source: ${codeSpan(source) || "(unnamed)"}, made with the SMS Backup & Restore app; only the conversation with ${with_}.`,
    `${msgs.length} messages (SMS and MMS), ${local(msgs[0].ms).date} to ${local(msgs.at(-1).ms).date}. `
    + `Times are ${timeZone}. Attachments appear as \`[attachment: filename]\`.`
    + (c.skippedGroups ? ` ${c.skippedGroups} group messages were left out.` : ""), ""];
  let day = null;
  for (const m of msgs) {
    const t = local(m.ms);
    if (t.date !== day) {
      day = t.date;
      if (L.at(-1) === ">") L[L.length - 1] = "";
      L.push(`## ${t.date} (${t.weekday})`, "");
    }
    const who = m.group
      ? `${m.from !== null ? label(m.from, m.group.listed) : me} (group: ${m.group.members.map((n) => label(n, m.group.listed)).join(", ")})`
      : m.mine ? me : other;
    L.push(`> -# ${who} — ${t.stamp}${m.note}`);
    const body = [...(m.text ? m.text.split("\n").map(escapeTag) : []), ...m.files.map((f) => `[attachment: ${f}]`)];
    for (const b of body.length ? body : ["[no text]"]) L.push(`> ${b}`.replace(RSTRIP, ""));
    L.push(">");
  }
  return `${L.join("\n")}\n`;
}

// messages()'s result → { files: [{ name, text }], stats }. Names: "base.md" for the
// chosen number's conversation when a base is given, else "sms-Name.md"; two that would
// share one (on a case-blind disk too) get the number's last 4 digits, then a count, added.
// Conversations go oldest first. title is the chosen conversation's heading.
export function plan({ conversations, skippedGroups, undated, listed = new Map() }, { source, number = "", title, base, me = "Me", names = {}, timeZone = "UTC" } = {}) {
  const want = digits(number);
  const label = labeler(conversations, names, listed);
  const list = [...conversations.values()].filter((c) => c.messages.length)
    .sort((a, b) => a.messages[0].ms - b.messages[0].ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const files = [], taken = new Set();
  const stats = { conversations: 0, messages: 0, mine: 0, skippedGroups, undated };
  for (const c of list) {
    const stem = base && want ? base : `sms-${safeTitle(c.group ? c.members.map((n) => label(n)).join(", ") : label(c.key))}`;
    let name = `${stem}.md`;
    if (taken.has(name.toLowerCase())) name = `${stem} (${safeTitle(last4(c.key))}).md`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${stem} (${k}).md`;
    taken.add(name.toLowerCase());
    files.push({ name, text: render(c, { source, title: want ? title : undefined, me, label, timeZone }) });
    stats.conversations++;
    stats.messages += c.messages.length;
    stats.mine += c.messages.filter((m) => m.mine && !m.note).length; // sent: not a draft or a failed send
  }
  return { files, stats };
}
