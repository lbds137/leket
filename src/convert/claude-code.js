// `leket convert claude-code`: Claude Code session transcripts (one JSONL file per session,
// as Claude Code keeps them under ~/.claude/projects/<folder>/) → one Markdown file per
// session holding what the person typed and what they were shown:
//
//   - their prompts (records with turnOrigin "human"; other prompts, such as a scheduled
//     task's, a headless run's or a background task's notice, end the reply before them but
//     aren't shown), with <system-reminder> blocks taken out
//   - each reply's text, except text written before a tool call, which was never shown as
//     a reply (the next text replaces it)
//   - each AskUserQuestion: the question and its options, then their answers
//   - not tool calls, their output, or subagents' records (isSidechain)
//
//   # Title
//
//   Claude Code session `id`, YYYY-MM-DD HH:MM to …; N messages. Source: `file.jsonl`.
//
//   ## User · YYYY-MM-DD HH:MM
//
//   the text
//
// A port of a private converter's turns(), as it was; the deliberate differences:
//   - every line is parsed (the original skipped lines on raw-text tests that assume
//     compact JSON), and a record of an unexpected shape is passed over, not fatal
//   - an answer recorded as a list of blocks is its text blocks joined (the original
//     printed Python's repr of the list); a string assistant content counts as one text block
//   - a question answered with several choices (multiSelect) lists them joined by ", "
//     (the original printed Python's repr of the list)
//
// Pure: no file access. Feed a session's lines to turns() one at a time (a transcript can
// be larger than one string can hold); bin/leket.js reads the files and writes what plan()
// returns.
import { codeSpan, oneLineText } from "../lib/html-md.js";
import { PYSPACE, pyStrip, safeTitle } from "./common.js";

const REMINDER = new RegExp(`<system-reminder>[^]*?</system-reminder>[${PYSPACE}]*`, "g");
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
const str = (x) => (typeof x === "string" ? x : "");

// A session's turns, from its lines in order: feed(line) each, then end() →
// { turns: [{ at, role: "user" | "assistant", text }], title, sessionId, unparsed,
// origins }. at is the record's own timestamp, as written (UTC ISO 8601); text is Markdown
// as the original wrote it. title: the session's last custom-title record (its name in
// Claude Code), "" if none. unparsed: lines that aren't JSON (a live transcript's last line
// can be half-written). origins: how many prompt records had a turnOrigin field at all (an
// older transcript has none, so none of its prompts can be told to be the person's).
export function turns() {
  const out = [];
  let pending = []; // [at, text]: reply text not yet followed by a tool call
  const asked = new Set(); // AskUserQuestion call ids
  let title = "", sessionId = "", unparsed = 0, origins = 0;
  const flush = () => {
    if (pending.length) out.push({ at: pending[0][0], role: "assistant", text: pending.map(([, t]) => t).join("\n\n") });
    pending = [];
  };
  const feed = (line) => {
    if (!pyStrip(line)) return;
    let d;
    try { d = JSON.parse(line); } catch { unparsed++; return; }
    if (!obj(d)) return;
    if (d.type === "custom-title" && typeof d.customTitle === "string") title = d.customTitle;
    if (!sessionId && typeof d.sessionId === "string") sessionId = d.sessionId;
    if (d.isSidechain || (d.type !== "user" && d.type !== "assistant")) return;
    const when = str(d.timestamp);
    let content = obj(d.message)?.content;
    if (d.type === "assistant") {
      if (typeof content === "string") content = [{ type: "text", text: content }];
      if (!Array.isArray(content)) return;
      for (const b of content.filter(obj)) {
        if (b.type === "text" && pyStrip(str(b.text))) pending.push([when, pyStrip(b.text)]);
        else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
          const qs = Array.isArray(obj(b.input)?.questions) ? b.input.questions.filter(obj) : [];
          for (const q of qs) {
            const opts = (Array.isArray(q.options) ? q.options.filter(obj) : [])
              .map((o) => `- ${str(o.label)}: ${str(o.description)}`).join("\n");
            pending.push([when, `**Question:** ${str(q.question)}\n\n${opts}`]);
          }
          flush();
          if (typeof b.id === "string") asked.add(b.id);
        } else if (b.type === "tool_use") pending = [];
      }
      return;
    }
    if (Array.isArray(content) && content.some((b) => obj(b)?.type === "tool_result")) {
      for (const b of content.filter(obj)) {
        if (!asked.has(b.tool_use_id)) continue;
        const answers = obj(obj(d.toolUseResult)?.answers);
        const text = answers && Object.keys(answers).length
          ? Object.entries(answers).map(([q, a]) => `${q} → **${Array.isArray(a) ? a.map(String).join(", ") : String(a)}**`).join("\n")
          : typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.filter((x) => obj(x)?.type === "text").map((x) => str(x.text)).join("\n\n")
              : String(b.content ?? "None");
        out.push({ at: when, role: "user", text: `*(answering the question)*\n\n${text}` });
      }
      return; // a tool's output neither ends the reply nor is shown
    }
    flush(); // a new prompt, theirs or not, ends the reply before it
    if ("turnOrigin" in d) origins++;
    if (d.turnOrigin !== "human") return;
    if (Array.isArray(content)) content = content.filter((b) => obj(b)?.type === "text").map((b) => str(b.text)).join("\n\n");
    const text = pyStrip(str(content).replace(REMINDER, ""));
    if (text) out.push({ at: when, role: "user", text });
  };
  const end = () => { flush(); return { turns: out, title, sessionId, unparsed, origins }; };
  return { feed, end };
}

// An ISO 8601 time → "YYYY-MM-DD HH:MM" in timeZone; "" for none
export function minute(at, timeZone = "UTC") {
  const t = Date.parse(str(at));
  if (Number.isNaN(t)) return "";
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// one line, at most 60 characters, cut at a word where it can be
function firstLine(text) {
  const s = pyStrip(text.replace(/\s+/g, " "));
  if (s.length <= 60) return s;
  const cut = s.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

// A session's title: its name in Claude Code, else the start of the first prompt
export function titleOf(session) {
  const named = pyStrip(session.title.replace(/[\r\n]+/g, " "));
  if (named) return named;
  const first = session.turns.find((t) => t.role === "user" && !t.text.startsWith("*(answering"));
  return first ? firstLine(first.text) : "Untitled session";
}

// One session ({ id, source, ...end()'s result }) → Markdown
export function render(session, { user = "User", assistant = "Claude", timeZone = "UTC" } = {}) {
  const ts = session.turns;
  const first = minute(ts[0]?.at, timeZone), last = minute(ts.at(-1)?.at, timeZone);
  const span = first || last ? `${first || "undated"} to ${last || "undated"}` : "undated";
  const lines = [
    `# ${oneLineText(titleOf(session))}`,
    "",
    `Claude Code session ${codeSpan(session.id) || "(no id)"}, ${span}; ${ts.length} messages. Source: ${codeSpan(session.source) || "(unnamed)"}.`,
    "",
  ];
  for (const t of ts) lines.push(`## ${oneLineText(t.role === "user" ? user : assistant)} · ${minute(t.at, timeZone) || "undated"}`, "", t.text, "");
  return lines.join("\n");
}

// Sessions → { files: [{ name, text, id }], stats }. Sessions with no turn are left out
// (counted apart: no prompt typed by a person, or a transcript too old to tell). File names:
// "YYYY-MM-DD Title.md" (the first turn's day); two that would share one (on a case-blind
// disk too) are told apart by the first 8 characters of the session id, then a number.
// Sessions are taken oldest first (then by id), so which one gets the suffix doesn't depend
// on the order given. json: write each session's turns as JSON instead (for a script that
// picks stretches out of a session or rewrites names before rendering).
export function plan(sessions, { json = false, ...opts } = {}) {
  const files = [], taken = new Set();
  const stats = { sessions: 0, turns: 0, noPrompt: 0, noOrigin: 0, unparsed: 0 };
  const at = (s) => { const t = Date.parse(str(s.turns[0]?.at)); return Number.isNaN(t) ? Infinity : t; };
  const ordered = sessions.filter((s) => {
    stats.unparsed += s.unparsed;
    if (s.turns.length) return true;
    if (s.origins) stats.noPrompt++; else stats.noOrigin++;
    return false;
  }).sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ext = json ? ".json" : ".md";
  for (const s of ordered) {
    const day = minute(s.turns[0].at, opts.timeZone).slice(0, 10) || "undated";
    const base = `${day} ${safeTitle(titleOf(s))}`;
    const tag = safeTitle(s.id.slice(0, 8));
    let name = `${base}${ext}`;
    if (taken.has(name.toLowerCase())) name = `${base} (${tag})${ext}`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base} (${tag} ${k})${ext}`;
    taken.add(name.toLowerCase());
    const text = json
      ? `${JSON.stringify({ id: s.id, source: s.source, title: titleOf(s), turns: s.turns }, null, 1)}\n`
      : render(s, opts);
    files.push({ name, text, id: s.id });
    stats.sessions++;
    stats.turns += s.turns.length;
  }
  return { files, stats };
}
