// `leket convert discord`: one or more saves of the same Discord conversation (the JSON in
// Leket's Discord zip, or the console collector's JSON) → Markdown transcripts. Saves are
// merged by message id; the transcript can be one file, or one per year or month. A server
// channel also gets a participants table and an index of its files.
//
// Every message is a blockquote under its day's heading:
//   > -# Name — Mar 5 2024 3:07 PM (edited)
//   > [reply to Other: 'the first 80 characters…']
//   > the text, line by line
//   > [attachment: photo.png]
// Names are the account's display name unless --name maps its username to a label.
// --embeds adds each message's embeds as `[embed: title]` at the end of its last line, so
// line numbers stay the same as without it. A voice map ("<message id>_<n>", or
// "<message id>_f<k>_<n>" inside a forward → {duration: seconds, text}) puts machine
// transcripts under their attachment lines.
// Pure: no file access. bin/leket.js reads the saves and writes what render() returns.

// a snowflake id is past 2^53: compared as BigInt, never as a Number
const byId = (a, b) => {
  const x = BigInt(a.id), y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

// Python's " ".join(s.split()): every whitespace run becomes one space, ends trimmed
const squash = (s) => s.split(/\s+/).filter(Boolean).join(" ");

// Merges saves of one conversation. The first save holding a message keeps it, except
// that a save with a forward's content replaces one where the forward came out empty.
export function mergeSaves(saves) {
  if (!saves.length) throw new Error("no saves given");
  const channel = saves[0]?.channel_id;
  const messages = new Map();
  const people = new Map();
  const hidden = new Map();
  let reachedStart = false, guild = null, guildId = null, title = null;
  const since = [], extracted = [], spans = [];
  for (const [i, d] of saves.entries()) {
    if (!d || typeof d !== "object" || !Array.isArray(d.messages)) throw new Error(`save ${i + 1} has no messages list: not a Discord save`);
    if (d.channel_id !== channel) throw new Error(`save ${i + 1} is of channel ${d.channel_id}, not ${channel}: give saves of one conversation`);
    const bad = d.messages.find((m) => !m || typeof m.id !== "string" || !/^\d+$/.test(m.id));
    if (bad !== undefined) throw new Error(`save ${i + 1} has a message whose id (${JSON.stringify(bad && bad.id)}) isn't a Discord id`);
    // what this save covers: back to the start (or the day it was asked to stop at) or to
    // its oldest message, and forward to when it was saved (or its newest message)
    let lo = Infinity, hi = Date.parse(d.extracted_at) || -Infinity;
    for (const m of d.messages) {
      const t = Date.parse(m.datetime);
      if (Number.isFinite(t)) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
    }
    if (d.reached_start) lo = -Infinity;
    else if (d.reached_since && Number.isFinite(Date.parse(d.reached_since))) lo = Math.min(lo, Date.parse(d.reached_since));
    if (lo <= hi) spans.push([lo, hi]);
    title = title || d.channel || null;
    guild = guild || d.guild_name || null;
    guildId = guildId || d.guild_id || null;
    reachedStart = reachedStart || !!d.reached_start;
    if (d.reached_since) since.push(d.reached_since);
    extracted.push(String(d.extracted_at || "").slice(0, 10));
    for (const m of d.messages) {
      const had = messages.get(m.id);
      if (!had || (m.forwarded?.length && !had.forwarded?.length)) messages.set(m.id, m);
    }
    for (const p of d.participants || []) if (!people.has(p.id)) people.set(p.id, p);
    // every save counts the same hidden messages again: the largest count per kind is kept.
    // A bar that gave no number counts 0 and marks its kind as more than counted.
    const here = new Map();
    for (const g of d.hidden_groups?.groups || []) {
      if (g.opened === false) continue;
      const h = here.get(g.kind) || { count: 0, uncounted: false };
      if (typeof g.count === "number") h.count += g.count;
      else h.uncounted = true;
      here.set(g.kind, h);
    }
    for (const [k, h] of here) {
      const was = hidden.get(k) || { count: 0, uncounted: false };
      hidden.set(k, { count: Math.max(was.count, h.count), uncounted: was.uncounted || h.uncounted });
    }
  }
  // stretches no save covers, between saves that together reach further: messages sent
  // then may be missing even when the merged saves reached the start
  spans.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let reach = spans.length ? spans[0][1] : -Infinity;
  for (const [lo, hi] of spans.slice(1)) {
    if (lo > reach) gaps.push({ from: new Date(reach).toISOString(), to: new Date(lo).toISOString() });
    reach = Math.max(reach, hi);
  }
  return {
    channel, title, guild, gaps,
    // a server channel or thread has a server; a DM (or group DM) has none
    isDm: !guildId && !guild,
    reachedStart,
    reachedSince: since.length ? since.sort()[0] : null,
    saves: saves.length,
    extracted: extracted.filter(Boolean).sort(),
    messages: [...messages.values()].sort(byId),
    people, hidden,
  };
}

// a time zone's local parts for an ISO instant
function clock(timeZone) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (iso) => {
    const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    const hour = Number(p.hour) % 24;
    return {
      year: p.year, month: p.month, day: p.day, weekday: p.weekday,
      date: `${p.year}-${p.month}-${p.day}`,
      // "Mar 5 2024 3:07 PM"
      stamp: `${MON[Number(p.month) - 1]} ${Number(p.day)} ${p.year} ${hour % 12 || 12}:${p.minute} ${hour < 12 ? "AM" : "PM"}`,
    };
  };
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const voiceLine = (v) =>
  `[voice message, ${mmss(v.duration)}, machine transcript, not checked against the audio: ${v.text || "(no speech heard)"}]`;
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");
const utc = (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

// The files for one merged conversation: [{name, text}], names relative to the output
// folder, each starting with `base`. by: "none" (one file), "year" or "month".
export function render(conv, { base, by = conv.isDm ? "none" : "month", title = conv.title || conv.channel,
  timeZone, names = {}, embeds = false, voice = {} }) {
  const msgs = conv.messages;
  if (!msgs.length) throw new Error("the save(s) hold no messages");
  const local = clock(timeZone);
  const at = new Map(msgs.map((m) => [m.id, local(m.datetime)]));
  const named = new Map(Object.entries(names));
  const name = (m) => (m.author_username != null && named.has(m.author_username) ? named.get(m.author_username) : m.author || "?");
  const index = new Map(msgs.map((m) => [m.id, m]));
  const what = conv.isDm ? "DM" : "channel";
  const ex = conv.extracted;
  const start = conv.reachedStart ? `the collector reached the start of the ${what}`
    : conv.reachedSince ? `the save began at ${conv.reachedSince}, as asked, so messages before that day were not collected`
      : `PARTIAL: the start of the ${what} was not reached, so older messages are missing`;
  const source = `${conv.saves} save(s) of channel ${conv.channel}${conv.isDm ? "" : ` in ${conv.guild || "the server"}`}`
    + (ex.length ? `, exported ${ex[0]}${ex[ex.length - 1] !== ex[0] ? ` to ${ex[ex.length - 1]}` : ""}` : "")
    + `; ${start}`
    + conv.gaps.map((g) => `; GAP: no save covers ${utc(g.from)} to ${utc(g.to)}, so messages from then may be missing`).join("");
  const span = (part) => `${at.get(part[0].id).date} to ${at.get(part[part.length - 1].id).date}`;

  const body = (m) => {
    const out = [];
    if (m.forward_of && !m.forwarded?.length) out.push("[forwarded message; the export has no copy of it]");
    for (const [k, f] of (m.forwarded || []).entries()) {
      out.push("[forwarded message]");
      if (f.text) out.push(...f.text.split("\n"));
      for (const [n, a] of (f.attachments || []).entries()) {
        out.push(`[forwarded attachment: ${a.filename}]`);
        const v = voice[`${m.id}_f${k}_${n}`];
        if (v) out.push(voiceLine(v));
      }
    }
    if (m.reply_to) {
      const r = index.get(m.reply_to);
      if (r) {
        let q = squash(r.text || "");
        // 80 characters, not UTF-16 units: an emoji is never cut in half
        if ([...q].length > 80) q = `${[...q].slice(0, 80).join("")}…`;
        out.push(q ? `[reply to ${name(r)}: '${q}']` : `[reply to ${name(r)}'s attachment]`);
      } else out.push("[reply to a message not in this export]");
    }
    if (m.text) out.push(...m.text.split("\n"));
    for (const [n, a] of (m.attachments || []).entries()) {
      out.push(`[attachment: ${a.filename}]`);
      const v = voice[`${m.id}_${n}`];
      if (v) out.push(voiceLine(v));
    }
    const tags = embeds ? (m.embeds || []).map((e) => `[embed: ${e.title || e.type || "no title"}]`) : [];
    if (!out.length) return [tags.length ? tags.join(" ") : `[no text; message type ${m.type ?? "unknown"}]`];
    if (tags.length) out[out.length - 1] = `${out[out.length - 1]} ${tags.join(" ")}`.trim();
    return out;
  };

  const page = (part, heading) => {
    const L = [`# ${heading}`, "", `Source: ${source}.`,
      conv.isDm
        ? `${part.length} messages in this file, ${span(part)}`
          + (part.length !== msgs.length ? ` (whole DM so far: ${msgs.length} messages, ${span(msgs)})` : "")
          + `. Times are ${timeZone} (the export's own timestamps are UTC). Attachments appear as \`[attachment: filename]\`; the files are fetched separately.`
        : `${part.length} messages in this file. Times are ${timeZone}. Names are each account's display name at the save `
          + "(server nicknames and roles are in the participants file); every deleted account shows as \"Deleted User\". "
          + "Attachments appear as `[attachment: filename]`; the files are fetched separately.",
      ""];
    let day = null;
    for (const m of part) {
      const t = at.get(m.id);
      if (t.date !== day) {
        day = t.date;
        if (L[L.length - 1] === ">") L[L.length - 1] = "";
        L.push(`## ${t.date} (${t.weekday})`, "");
      }
      L.push(`> -# ${name(m)} — ${t.stamp}${m.edited ? " (edited)" : ""}${m.hand_added ? " (added by hand; missed by the save)" : ""}`);
      for (const b of body(m)) L.push(`> ${b}`.trimEnd());
      L.push(">");
    }
    return `${L.join("\n")}\n`;
  };

  const groups = new Map();
  for (const m of msgs) {
    const t = at.get(m.id);
    const k = by === "year" ? t.year : by === "month" ? `${t.year}-${t.month}` : "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const fileOf = (k) => (k ? `${base}-${k}.md` : `${base}.md`);
  const files = [...groups].map(([k, part]) => ({ name: fileOf(k), text: page(part, k ? `${title}, ${k}` : title), messages: part.length }));
  if (conv.isDm) return files;

  // a server channel: participants and an index
  const count = new Map();
  for (const m of msgs) {
    // a webhook (proxy bot) posts many names under one id: each name is its own row
    const key = JSON.stringify([m.author_id, m.author]);
    if (!count.has(key)) count.set(key, { aid: m.author_id, who: m.author, mine: [] });
    count.get(key).mine.push(m);
  }
  const rows = [...count.values()].sort((a, b) => b.mine.length - a.mine.length);
  const hid = [...conv.hidden].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const P = [`# ${title}: participants`, "", `Source: ${source}.`,
    `${rows.length} author names (${new Set(rows.map((r) => r.aid)).size} ids). Nickname and roles are as Discord held them at the save, not when the messages were sent. `
    + "\"Deleted User\" is one placeholder id shared by every deleted account, so its count is many people. "
    + (hid.length ? `The saver had some authors blocked or ignored; the collector opened their hidden messages (${hid.map(([k, h]) => `${h.count}${h.uncounted ? "+" : ""} ${k}`).join(", ")}). ` : "")
    + "A proxy bot (webhook) posts many names under one id; each name is its own row, its roles column says webhook.", "",
    "| messages | name | username | nickname | roles | first | last | id |", "|---|---|---|---|---|---|---|---|"];
  for (const { aid, who, mine } of rows) {
    const p = conv.people.get(aid);
    const hook = !!p?.webhook;
    const q = hook ? {} : p || {};
    const roles = hook ? "webhook" : (q.roles || []).filter((r) => r.name).map((r) => r.name).join(", ");
    P.push(`| ${mine.length} | ${cell(hook ? who : q.shown_as || who)} | ${cell(q.username || mine[0].author_username)} `
      + `| ${cell(q.nick)} | ${cell(roles)} | ${at.get(mine[0].id).date} | ${at.get(mine[mine.length - 1].id).date} | ${aid ?? ""} |`);
  }
  files.push({ name: `${base}-participants.md`, text: `${P.join("\n")}\n` });
  const R = [`# ${title}`, "", `Source: ${source}.`, "",
    `${msgs.length} messages, ${span(msgs)}, ${files.length - 1 === 1 ? "in one file" : `one file per ${by}`}; `
    + `\`${base}-participants.md\` lists every author. Rebuild with \`leket convert discord\`.`, "",
    `| ${by === "none" ? "file" : by} | messages |`, "|---|---|",
    // the --by none row's label is the title: free text, so a | or ] in it can't end the cell or the link
    ...[...groups].map(([k, part]) => `| [${cell(k || title).replace(/[[\]]/g, "\\$&")}](${encodeURI(fileOf(k))}) | ${part.length} |`)];
  files.push({ name: `${base}-index.md`, text: `${R.join("\n")}\n` });
  return files;
}
