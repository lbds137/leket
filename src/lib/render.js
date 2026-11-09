// The readable page in the zip: index.html, the conversation as Discord showed it, with
// the saved attachments inline. It opens offline; nothing on it is fetched from the web.
import { FOLDER } from "./files.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO = /\.(ogg|oga|mp3|wav|m4a|flac|opus)$/i;

// Discord's own markup in a message: inline code, links, mentions, custom emoji, timestamps, escapes.
const TOKEN = /`([^`\n]+)`|(https?:\/\/[^\s<>"`]+)|<@!?(\d+)>|<@&(\d+)>|<#(\d+)>|<a?:([\w~-]+):\d+>|<t:(-?\d+)(?::[tTdDfFR])?>|\\([^0-9A-Za-z\s])/g;

export function render(exp, records, { timeZone = "UTC", streamed = false } = {}) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const clock = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const stamp = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" });
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? null : d; };

  const messages = exp.messages || [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const people = new Map();
  for (const p of exp.participants || []) if (p.id && !p.webhook) people.set(p.id, p);
  const nameOf = (m) => m.nick || m.author || m.author_username || "unknown";
  const personName = (id) => {
    const p = people.get(id);
    return p ? p.nick || p.global_name || p.username : null;
  };
  const files = new Map();
  for (const r of records || []) {
    const k = `${r.message_id}|${r.forwarded ?? ""}`;
    if (!files.has(k)) files.set(k, []);
    files.get(k).push(r);
  }

  const inline = (raw) => {
    const holds = [];
    const put = (html) => `\x01${holds.push(html) - 1}\x02`;
    // U+0001/U+0002 mark the token placeholders restored below; strip them from the text itself
    raw = String(raw).replace(/[\x01\x02]/g, "");
    let out = "", at = 0;
    for (const t of raw.matchAll(TOKEN)) {
      out += esc(raw.slice(at, t.index));
      at = t.index + t[0].length;
      const [whole, code, url, user, role, channel, emoji, unix, escaped] = t;
      if (code !== undefined) {
        out += put(`<code>${esc(code)}</code>`);
      } else if (url) {
        // closing punctuation or markdown markers after a link belong to the surrounding text;
        // a ")" stays while the link has an unclosed "(" (a wiki address)
        let link = url;
        for (;;) {
          const c = link.slice(-1);
          const open = (link.match(/\(/g) || []).length, close = (link.match(/\)/g) || []).length;
          if (!(/[.,!?:;'"*_~|]/.test(c) || (c === ")" && close > open))) break;
          link = link.slice(0, -1);
        }
        out += put(`<a href="${esc(link)}">${esc(link)}</a>`) + esc(url.slice(link.length));
      } else if (user) out += put(`<span class="mention">@${esc(personName(user) || user)}</span>`);
      else if (role) out += put(`<span class="mention">@role</span>`);
      else if (channel) out += put(`<span class="mention">#channel</span>`);
      else if (emoji) out += put(`<span class="emoji">:${esc(emoji)}:</span>`);
      else if (unix) {
        const d = new Date(Number(unix) * 1000);
        out += Number.isNaN(+d) ? esc(whole) : put(`<span class="mention">${esc(stamp.format(d))}</span>`);
      } else if (escaped !== undefined) {
        out += put(esc(escaped));
      }
    }
    out += esc(raw.slice(at));
    out = out
      .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" onclick="this.classList.add(\'open\')">$1</span>')
      .replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, "<strong>$1</strong>")
      .replace(/__(?!\s)(.+?)(?<!\s)__/g, "<u>$1</u>")
      .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, "<s>$1</s>")
      .replace(/(?<!\*)\*(?!\*|\s)(.+?)(?<!\s|\*)\*(?!\*)/g, "<em>$1</em>")
      .replace(/(?<!\w)_(?!\s|_)(.+?)(?<!\s|_)_(?!\w)/g, "<em>$1</em>");
    return out.replace(/\x01(\d+)\x02/g, (_, i) => holds[Number(i)]);
  };
  const blocks = (chunk) => {
    if (!chunk) return "";
    const lines = chunk.split(/\r?\n/);
    let out = "", plain = [];
    const flush = () => {
      if (plain.length) { out += plain.join("<br>"); plain = []; }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^(#{1,3}) (.*)$/))) {
        flush();
        const lvl = m[1].length;
        out += `<h${lvl + 2} class="md-h${lvl}">${inline(m[2])}</h${lvl + 2}>`;
      } else if ((m = line.match(/^-# (.*)$/))) {
        flush();
        out += `<div class="md-sub">${inline(m[1])}</div>`;
      } else if ((m = line.match(/^>>>(?: (.*)|$)$/))) {
        flush();
        const rest = lines.slice(i + 1);
        const q = m[1] ? [m[1], ...rest] : (rest.length ? rest : [""]);
        out += `<blockquote class="md-quote">${q.map(inline).join("<br>")}</blockquote>`;
        break;
      } else if (/^> (.*)$/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && (m = lines[i].match(/^> (.*)$/))) {
          q.push(inline(m[1]));
          i++;
        }
        i--;
        out += `<blockquote class="md-quote">${q.join("<br>")}</blockquote>`;
      } else if (/^([ \t]*)(?:[-*]|(\d{1,9})\.) /.test(line)) {
        flush();
        const stack = [];
        const open = (type, num) => type === "ol" && Number(num) !== 1 ? `<ol start="${Number(num)}">` : `<${type}>`;
        while (i < lines.length && (m = lines[i].match(/^([ \t]*)(?:[-*]|(\d{1,9})\.) (.*)$/))) {
          const type = m[2] ? "ol" : "ul";
          const target = Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
          if (!stack.length) {
            stack.push(type);
            out += `${open(type, m[2])}<li>${inline(m[3])}`;
          } else if (target > stack.length - 1) {
            while (stack.length - 1 < target) {
              stack.push(type);
              out += `${open(type, m[2])}<li>`;
            }
            out += inline(m[3]);
          } else {
            while (stack.length - 1 > target) out += `</li></${stack.pop()}>`;
            out += `</li>`;
            if (stack[stack.length - 1] !== type) {
              out += `</${stack.pop()}>${open(type, m[2])}`;
              stack.push(type);
            }
            out += `<li>${inline(m[3])}`;
          }
          i++;
        }
        i--;
        while (stack.length) out += `</li></${stack.pop()}>`;
      } else {
        plain.push(inline(line));
      }
    }
    flush();
    return out;
  };
  // ``` blocks are block-inert; the rest gets line and inline markdown
  const text = (raw) => {
    if (!raw) return "";
    // an unclosed fence is closed as Discord closes it, so the tail stays code instead of
    // turning into headings and lists it was never meant to be
    let src = String(raw);
    if ((src.match(/```/g) || []).length % 2) src += "```";
    const parts = src.split(/(```[\s\S]*?```)/);
    return parts.map((part, i) => {
      if (i % 2) return `<pre>${esc(part.slice(3, -3).replace(/^[\w+-]*\n(?=[\s\S])/, ""))}</pre>`;
      let s = part;
      if (i > 0) s = s.replace(/^\n/, "");
      if (i + 1 < parts.length) s = s.replace(/\n$/, "");
      return blocks(s);
    }).join("");
  };

  const attachment = (r) => {
    if (r.error) return `<div class="file missing">${esc(r.filename)} <em>(not saved: ${esc(r.error)})</em></div>`;
    const href = `${FOLDER}/${encodeURIComponent(r.file)}`;
    if (IMAGE.test(r.file)) return `<a class="img" href="${href}"><img loading="lazy" src="${href}" alt="${esc(r.filename)}"></a>`;
    if (VIDEO.test(r.file)) return `<video controls preload="metadata" src="${href}"></video>`;
    if (AUDIO.test(r.file)) return `<div class="file"><audio controls preload="metadata" src="${href}"></audio> ${esc(r.filename)}</div>`;
    return `<div class="file"><a href="${href}">${esc(r.filename)}</a></div>`;
  };
  // attachments listed in the export but not in the records: saved without them
  const listed = (atts, k) => (files.get(k) || (atts || []).map((a) => ({ filename: a.filename, error: "saving attachments was turned off" })))
    .map(attachment).join("");

  // only web addresses become links: anything else (javascript:, data:) is shown as text
  const web = (u) => /^https?:\/\//i.test(String(u || ""));
  const embed = (e) => {
    const title = e.title ? (web(e.url) ? `<a href="${esc(e.url)}">${esc(e.title)}</a>` : esc(e.title)) : "";
    return `<div class="embed">` +
      (e.author ? `<div class="e-author">${esc(e.author)}</div>` : "") +
      (title ? `<div class="e-title">${title}</div>` : "") +
      (e.description ? `<div>${text(e.description)}</div>` : "") +
      (e.fields || []).map((f) => `<div class="e-field"><b>${esc(f.name)}</b><div>${text(f.value)}</div></div>`).join("") +
      (e.image ? `<div class="e-img">image: ${web(e.image) ? `<a href="${esc(e.image)}">${esc(e.image)}</a>` : esc(e.image)} (not saved)</div>` : "") +
      (e.footer ? `<div class="e-footer">${esc(e.footer)}</div>` : "") +
      `</div>`;
  };

  const notes = [];
  if (!exp.reached_start) {
    notes.push(exp.reached_since ? `Saved from ${esc(exp.reached_since)} on, as asked.`
      : "The start of the conversation was not reached: older messages may be missing.");
  }
  const hg = exp.hidden_groups || {};
  if (hg.not_opened) notes.push(`${esc(hg.not_opened)} group(s) of blocked or ignored messages would not open: their messages are missing.`);
  const dom = messages.filter((m) => m.from_dom).length;
  if (dom) notes.push(`${dom} message(s) were saved from the page's text only (no author, no attachments).`);
  if (exp.forwards_without_snapshot) notes.push(`${esc(exp.forwards_without_snapshot)} forwarded message(s) were saved without what was forwarded.`);
  const failed = (records || []).filter((r) => r.error).length;
  if (failed) notes.push(`${failed} attachment(s) could not be saved.`);
  // a streamed save renders before its attachments are fetched, so it cannot know which
  // failed; the manifest part is the failure list
  if (streamed) notes.push("This page was written before its attachments were fetched: files missing here are listed in discord-attachments.json, in the save's final part.");

  let body = "", lastDay = null, last = null;
  for (const m of messages) {
    const d = when(m.datetime);
    const dayText = d ? day.format(d) : "unknown date";
    if (dayText !== lastDay) {
      body += `<h2 class="day">${esc(dayText)}</h2>`;
      lastDay = dayText;
      last = null;
    }
    let reply = "";
    if (m.reply_to) {
      const r = byId.get(m.reply_to);
      reply = r ? `<a class="reply" href="#m${esc(r.id)}">↪ ${esc(nameOf(r))}: ${esc((r.text || "").replace(/\s+/g, " ").slice(0, 100)) || "<em>attachment</em>"}</a>`
        : `<div class="reply">↪ a message not in this save</div>`;
    }
    const sameAuthor = last && last.author_id && last.author_id === m.author_id && !reply
      && d && when(last.datetime) && d - when(last.datetime) < 7 * 60 * 1000;
    const head = sameAuthor ? "" : `<div class="head"><span class="name">${esc(nameOf(m))}</span>` +
      `<span class="time">${d ? esc(clock.format(d)) : ""}</span></div>`;
    const fwd = (m.forwarded || []).map((f, k) => `<div class="forward"><div class="f-label">Forwarded</div>${text(f.text)}` +
      listed(f.attachments, `${m.id}|${k}`) + (f.embeds || []).map(embed).join("") + `</div>`).join("") +
      (m.forward_of && !(m.forwarded || []).length ? `<div class="forward"><em>forwarded message: its content was not found</em></div>` : "");
    // a join, pin, call or boost notice carries no text of its own: say what it is rather
    // than leave a name over an empty bubble (0 is a plain message, 19 a reply)
    const bare = !m.text && !(m.attachments || []).length && !(m.embeds || []).length && !fwd;
    const notice = bare && Number.isInteger(m.type) && m.type !== 0 && m.type !== 19
      ? `<em>a Discord notice (type ${m.type}): its wording isn't saved</em>` : "";
    body += `<div class="msg${sameAuthor ? " cont" : ""}" id="m${esc(m.id)}">${reply}${head}` +
      `<div class="text">${notice}${text(m.text)}${m.edited ? ' <span class="edited">(edited)</span>' : ""}</div>` +
      fwd + listed(m.attachments, `${m.id}|`) + (m.embeds || []).map(embed).join("") + `</div>`;
    last = m;
  }

  const title = [exp.channel, exp.guild_name].filter(Boolean).join(" · ") || "Discord conversation";
  const saved = when(exp.extracted_at);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#1e1f22;--muted:#4e5058;--line:#e3e5e8;--card:#f2f3f5;--accent:#3945d1;--warn:#7d4600}
@media (prefers-color-scheme: dark){:root{--bg:#313338;--fg:#dbdee1;--muted:#bec5cd;--line:#3f4147;--card:#2b2d31;--accent:#b6beff;--warn:#f5bc36}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:16px}
header h1{font-size:20px;margin:0 0 4px}header p{margin:2px 0;color:var(--muted)}
.notes{border-left:3px solid var(--warn);padding:4px 10px;margin:10px 0;color:var(--warn)}
h2.day{font-size:13px;color:var(--muted);text-align:center;border-bottom:1px solid var(--line);padding-bottom:4px;margin:24px 0 8px}
.msg{padding:2px 0 2px 0;margin-top:10px}.msg.cont{margin-top:0}
.head .name{font-weight:600;margin-right:8px}.head .time,.edited{font-size:12px;color:var(--muted)}
.text{white-space:normal;overflow-wrap:anywhere}
.md-h1,.md-h2,.md-h3{font-weight:700;margin:4px 0 2px}.md-h1{font-size:1.5em}.md-h2{font-size:1.3em}.md-h3{font-size:1.15em}
.md-sub{font-size:0.8em;color:var(--muted)}
.md-quote{border-left:4px solid var(--line);margin:4px 0;padding:2px 10px;color:var(--muted)}
ul,ol{margin:4px 0;padding-left:22px}ul ul,ul ol,ol ul,ol ol{margin:2px 0;padding-left:20px}
.spoiler{background:var(--card);border-radius:4px;padding:0 3px;filter:blur(4px);cursor:pointer}.spoiler.open{filter:none;cursor:inherit}
a{color:var(--accent)}.mention{color:var(--accent);font-weight:500}
.reply{display:block;font-size:13px;color:var(--muted);text-decoration:none;margin-bottom:2px}
pre,code{background:var(--card);border-radius:4px;font:13px ui-monospace,monospace}pre{padding:8px;white-space:pre-wrap}code{padding:1px 4px}
.img img{max-width:min(100%,520px);max-height:420px;border-radius:6px;margin-top:4px;display:block}
video{max-width:min(100%,520px);margin-top:4px;display:block}
.file{margin-top:4px}.missing{color:var(--warn)}
.embed,.forward{border-left:4px solid var(--line);background:var(--card);border-radius:4px;padding:6px 10px;margin-top:4px;max-width:560px}
.e-title{font-weight:600}.e-author,.e-footer,.f-label{font-size:12px;color:var(--muted)}.e-field{margin-top:4px}
</style></head><body><main>
<header><h1>${esc(title)}</h1>
<p>${messages.length} messages${saved ? `, saved ${esc(stamp.format(saved))}` : ""} · times in ${esc(timeZone)}</p></header>
${notes.length ? `<div class="notes">${notes.map((n) => `<div>${n}</div>`).join("")}</div>` : ""}
${body}
</main></body></html>
`;
}
