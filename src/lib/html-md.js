// HTML → GitHub-flavoured Markdown, for the reply HTML in a Google Takeout export: the
// tags Gemini writes (p, h1–h6, ul, ol, li, blockquote, pre, code, hr, br, strong/b,
// em/i, a, table and its parts). The parser forgives what Takeout gets wrong (an unclosed
// <p>, tags inside <pre>); any other tag keeps its text and is counted in `unknown`.
// No dependencies: Leket runs where pandoc doesn't.

const VOID = new Set(["br", "hr", "img", "wbr", "input", "meta", "link", "area", "base", "col", "embed", "source", "track"]);
const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "div", "section", "article", "header", "footer"]);
const KNOWN = new Set([...BLOCK, "br", "strong", "b", "em", "i", "code", "a", "span"]);
// tags whose start closes an open <p> (HTML's rule, the block ones Takeout uses)
const CLOSES_P = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "pre", "hr", "table", "div", "section", "article", "header", "footer"]);
// named entities beyond the five XML ones, as code points (no invisible characters in source)
const NAMED = {
  amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0, copy: 0xa9, reg: 0xae,
  trade: 0x2122, hellip: 0x2026, mdash: 0x2014, ndash: 0x2013, lsquo: 0x2018, rsquo: 0x2019,
  ldquo: 0x201c, rdquo: 0x201d, laquo: 0xab, raquo: 0xbb, middot: 0xb7, bull: 0x2022,
  times: 0xd7, divide: 0xf7, deg: 0xb0, euro: 0x20ac, pound: 0xa3, shy: 0xad,
};

export function decode(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, e) => {
    if (e[0] !== "#") return Object.hasOwn(NAMED, e) ? String.fromCodePoint(NAMED[e]) : m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : String.fromCodePoint(0xfffd);
  });
}

// decoded text or attribute value, a NUL as U+FFFD (as a browser shows it): the converter
// marks breaks with NUL, so none may come from the page
const REPLACEMENT = String.fromCharCode(0xfffd);
const clean = (s) => decode(s).replace(/\u0000/g, REPLACEMENT);

function attrsOf(s) {
  const out = Object.create(null);
  // an unquoted value runs to a space or the tag's end, as browsers read it: "=" and "/"
  // inside it are its own ("href=http://x.com/watch?v=1&b=2", "href=/")
  for (const m of s.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>][^\s>]*)))?/g)) {
    out[m[1].toLowerCase()] = clean(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

// a tag's attributes end in "/" that closes it ("<span/>", "<a href=x />"), not a slash
// that ends an unquoted value ("<a href=http://x.com/>" opens a link to http://x.com/,
// "<a href=/>" one to /)
function selfClosing(attrs) {
  const s = attrs.trimEnd();
  return s.endsWith("/") && !/=\s*(?:[^\s"'>][^\s"'>]*)?$/.test(s.slice(0, -1));
}

// HTML → a tree of { tag, attrs, children } and strings (text, entities decoded)

export function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const open = (tag) => stack.findLastIndex((n) => n.tag === tag);
  const closeTo = (i) => { if (i > 0) stack.length = i; };
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>?|<\?[^>]*>?|<\/([a-zA-Z][a-zA-Z0-9-]*)[^>]*>?|<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let at = 0;
  const text = (s) => { if (s) top().children.push(clean(s)); };
  for (let m; (m = re.exec(html));) {
    text(html.slice(at, m.index));
    at = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = open(tag);
      // a stray end tag closes nothing; </p> with no <p> open is dropped as browsers… almost do
      if (i > 0) closeTo(i);
      continue;
    }
    if (!m[2]) continue; // comment, doctype, CDATA
    const tag = m[2].toLowerCase();
    const node = { tag, attrs: attrsOf(m[3] || ""), children: [] };
    if (tag === "pre") {
      // a <pre> is text to its end: tags inside it (Takeout puts <p> there) are dropped
      const end = html.slice(at).search(/<\/pre\s*>/i);
      const body = end < 0 ? html.slice(at) : html.slice(at, at + end);
      at = end < 0 ? html.length : at + end + html.slice(at + end).indexOf(">") + 1;
      re.lastIndex = at;
      const p = open("p"); if (p > 0) closeTo(p);
      node.children.push(clean(body.replace(/<[^>]*>/g, "")));
      top().children.push(node);
      continue;
    }
    if (CLOSES_P.has(tag)) { const p = open("p"); if (p > 0 && p > open("li") && p > open("td") && p > open("th") && p > open("blockquote")) closeTo(p); }
    if (tag === "li") { const li = open("li"); if (li > 0 && li > Math.max(open("ul"), open("ol"))) closeTo(li); }
    if (tag === "td" || tag === "th") { const c = Math.max(open("td"), open("th")); if (c > 0 && c > open("tr")) closeTo(c); }
    if (tag === "tr") { const r = open("tr"); if (r > 0 && r > open("table")) closeTo(r); }
    top().children.push(node);
    if (!VOID.has(tag) && !selfClosing(m[3] || "")) stack.push(node);
  }
  text(html.slice(at));
  return root;
}

// --- Markdown

const ALNUM = /[\p{L}\p{N}]/u;

// Text as Markdown that shows it as written: every character that could start markup is escaped
export function escapeText(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // $ too: GitHub renders $…$ as math
    if ("\\*`[]<>|~$".includes(c)) out += `\\${c}`;
    // _ inside a word is never emphasis in GFM (snake_case stays readable)
    else if (c === "_" && !(ALNUM.test(s[i - 1] || "") && ALNUM.test(s[i + 1] || ""))) out += "\\_";
    else if (c === "&" && /^&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.test(s.slice(i))) out += "\\&";
    else out += c;
  }
  return out;
}

// What a Markdown renderer would read as HTML in plain text, escaped with "\" so the text
// shows as typed: a "<" starting a tag or an autolink ("<Media omitted>", "<Sam>", "<b>"),
// which would vanish, and an "&" starting a character reference ("&lt;", "&amp;"), which
// would show as the character. One a backslash already escapes is left alone: after an odd
// run of backslashes ("\<"), not an even one ("\\<" is a backslash, then the tag). Inside
// a code span or code block the escape shows as a backslash; that costs one character,
// where a tag left raw loses its text.
export const escapeTag = (s) =>
  s.replace(/(?<!\\)((?:\\\\)*)(<(?=[A-Za-z/!?])|&(?=(?:#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);))/g, "$1\\$2");

const TRAILING_HASH = /(^|[ \t])(#+)([ \t]*)$/;

// Text for one line of a heading or a header paragraph: escaped, line breaks as spaces (one
// would end the heading or start a new block), and a run of # at the end kept (CommonMark
// reads " #…" at a heading's end as a closing sequence and drops it)
export function oneLineText(s) {
  return escapeText(s.replace(/[\r\n]+/g, " ")).replace(TRAILING_HASH, "$1\\$2$3");
}

// A title written into a "# …" heading: escapes only the break-class (< starting a tag or
// autolink and & starting a character reference via escapeTag, all backticks when the
// title has an odd number of them, and a trailing " #…" sequence that CommonMark would
// strip as a closing heading marker), leaving emphasis, links, leading/mid #s and even
// code spans raw. Unlike oneLineText, escapeHeading drops the trailing whitespace
// TRAILING_HASH matched after the # run ("$1\\$2" vs "$1\\$2$3") — nothing renders
// differently where the title ends the heading line (every converter but Discord, whose
// suffix headings append to the escaped title: "x # " → "x \#, 2025", one missing space).
// Order is canonical: escapeTag first (its lookbehind counts raw
// backslashes, so "`<b>" becomes "\`\<b>"), odd-backtick sweep second, trailing-# last.
// (The three steps happen to commute — the sweep's inserted backslash lands before a
// backtick, never before a "<"; fuzz-verified over all six orderings on 66,104 adversarial
// strings, zero divergence — but this order reads escapeTag's input as typed.)
export const escapeHeading = (s) => {
  let out = escapeTag(String(s));
  if ((out.match(/`/g) || []).length % 2 === 1) out = out.replace(/`/g, "\\`");
  return out.replace(TRAILING_HASH, "$1\\$2");
};

// what would make a line start a block: a heading, list, quote, rule or setext underline
function escapeLineStart(line) {
  return line
    .replace(/^(#{1,6})(?=\s|$)/, "\\$1")
    .replace(/^([-+=])/, "\\$1")
    .replace(/^(\d{1,9})([.)])/, "$1\\$2");
}

export function codeSpan(s) {
  s = String(s ?? "").replace(/[\r\n]+/g, " "); // nothing given is "": the caller's fallback shows
  if (!s) return "";
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") || (s.startsWith(" ") && s.endsWith(" ") && s.trim()) ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

function textOf(n) {
  return typeof n === "string" ? n : n.children.map(textOf).join("");
}

// http, https, mailto, or no scheme at all (a relative path, #fragment or ?query)
const LINKABLE = /^(?:https?:|mailto:|[^:/?#]*(?:[/?#]|$))/i;
// schemes that run or embed content: such a link keeps only its label. Browsers drop tabs,
// newlines and leading controls inside a scheme ("java\nscript:"), so those go before the test.
const SCRIPTED = /^(?:javascript|vbscript|data|file|blob):/i;

function linkDest(href) {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>\n]/g, (c) => encodeURIComponent(c))}>` : href;
}

// Inline content → one string. Hard breaks come out as BR marks for the caller to turn
// into a backslash line break (a paragraph) or a space (a heading or a table cell).
// KEEP marks a code line whose trailing spaces htmlToMarkdown keeps. They share NUL, which
// parse() never lets into text or attributes (it becomes U+FFFD there), and never meet: paragraph() and
// oneLine() consume every BR before htmlToMarkdown looks for KEEP.
const BR = "\u0000";
const KEEP = "\u0000";
function inline(nodes, ctx) {
  let out = "";
  // collapsed whitespace stays one space where two pieces meet (" " + " *em*")
  const add = (s) => { out += out.endsWith(" ") ? s.replace(/^ +/, "") : s; };
  for (const n of nodes) {
    if (typeof n === "string") { add(escapeText(n.replace(/[\t\n\r\f ]+/g, " "))); continue; }
    if (!KNOWN.has(n.tag)) ctx.unknown[n.tag] = (ctx.unknown[n.tag] || 0) + 1;
    switch (n.tag) {
      case "br": add(BR); break;
      case "strong": case "b": case "em": case "i": {
        const inner = inline(n.children, ctx);
        const mark = n.tag === "strong" || n.tag === "b" ? "**" : "*";
        const lead = inner.match(/^[ \u0000]*/)[0], trail = inner.slice(lead.length).match(/[ \u0000]*$/)[0];
        const core = inner.slice(lead.length, inner.length - trail.length);
        add(core ? `${lead}${mark}${core}${mark}${trail}` : inner);
        break;
      }
      case "code": add(codeSpan(textOf(n))); break;
      case "a": {
        const href = n.attrs.href || "";
        const label = inline(n.children, ctx);
        // a link only to the web, mail or a relative path; a scripted scheme (javascript:,
        // data:, vbscript:…) keeps just its label, and any other (tel:, ftp:, sms:…) its
        // label with the address after it as text
        if (!href) { add(label); break; }
        // spaces and breaks at the label's ends go outside the brackets, as for **…**
        const lead = label.match(/^[ \u0000]*/)[0], trail = label.slice(lead.length).match(/[ \u0000]*$/)[0];
        const core = label.slice(lead.length, label.length - trail.length);
        if (!LINKABLE.test(href.trim())) {
          // the address as text, unless scripted or already the label
          // control characters (C0, DEL and C1) go from the address as shown: a browser's URL
          // parser drops tabs and line breaks (a line break would end the paragraph, heading or
          // table row) and percent-encodes the rest, which as raw text would only garble the line
          const shown = href.trim().replace(/[\x00-\x1f\x7f-\x9f]/g, "");
          const addr = SCRIPTED.test(shown.replace(/[\x00-\x20]/g, "")) || textOf(n).trim() === shown ? "" : escapeText(shown);
          add(!addr ? label : `${lead}${core ? `${core} (${addr})` : addr}${trail}`);
          break;
        }
        if (textOf(n) === href && /^https?:\/\/[^\s<>]+$/.test(href)) { add(`<${href}>`); break; }
        add(`${lead}[${core || escapeText(href)}](${linkDest(href)})${trail}`);
        break;
      }
      case "pre": add(codeSpan(textOf(n))); break;
      default: add(inline(n.children, ctx));
    }
  }
  return out;
}

const isInline = (n) => typeof n === "string" || !BLOCK.has(n.tag);

function paragraph(nodes, ctx) {
  const s = inline(nodes, ctx).replace(/ *\u0000 */g, "\u0000").replace(/^[ \u0000]+|[ \u0000]+$/g, "");
  if (!s) return "";
  return s.split("\u0000").map((l) => escapeLineStart(l.trim())).join("\\\n");
}

function oneLine(nodes, ctx) {
  return inline(nodes, ctx).replace(/[ \u0000]+/g, " ").trim();
}

const indent = (s, pad) => s.split("\n").map((l, i) => (i && l ? pad + l : l)).join("\n");

function list(n, ctx) {
  const ordered = n.tag === "ol";
  let k = ordered && /^\d{1,9}$/.test(n.attrs.start || "") ? Number(n.attrs.start) : 1;
  const items = n.children.filter((c) => typeof c !== "string" || c.trim());
  const loose = items.some((c) => typeof c !== "string" && c.children.some((d) => typeof d !== "string" && d.tag === "p"));
  const out = [];
  for (const it of items) {
    const marker = ordered ? `${k++}. ` : "- ";
    const body = typeof it !== "string" && it.tag === "li" ? blocks(it.children, ctx, loose ? "\n\n" : "\n") : blocks([it], ctx);
    out.push(body ? marker + indent(body, " ".repeat(marker.length)) : marker.trimEnd());
  }
  return out.join(loose ? "\n\n" : "\n");
}

function table(n, ctx) {
  const rows = [];
  const walk = (x) => { for (const c of x.children) if (typeof c !== "string") { if (c.tag === "tr") rows.push(c); else if (c.tag !== "table") walk(c); } };
  walk(n);
  const cells = rows.map((r) => r.children.filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th")));
  if (!cells.length) return "";
  const width = Math.max(...cells.map((r) => r.length));
  if (!width) return "";
  // every pipe gets one more backslash, code spans included: GFM splits the row at bare
  // pipes, then drops one backslash before each pipe, so an escaped one (\| in text, or a
  // code span's own \|) needs \\| to come through as written
  const cell = (c) => (c ? blocks(c.children, ctx, " ", true).replace(/\n/g, " ") : "").replace(/\|/g, "\\|");
  const row = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  const align = (c) => ({ left: ":---", center: ":---:", right: "---:" })[(c?.attrs.align || "").toLowerCase()] || "---";
  return [row(cells[0]), `|${Array.from({ length: width }, (_, i) => align(cells[0][i])).join("|")}|`, ...cells.slice(1).map(row)].join("\n");
}

function block(n, ctx) {
  if (!KNOWN.has(n.tag)) ctx.unknown[n.tag] = (ctx.unknown[n.tag] || 0) + 1;
  switch (n.tag) {
    case "p": return paragraph(n.children, ctx);
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const s = oneLine(n.children, ctx);
      return s ? `${"#".repeat(Number(n.tag[1]))} ${s}` : "";
    }
    case "ul": case "ol": return list(n, ctx);
    case "li": return list({ tag: "ul", attrs: {}, children: [n] }, ctx);
    case "blockquote": {
      const s = blocks(n.children, ctx);
      return s ? s.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") : "";
    }
    case "pre": {
      const s = textOf(n).replace(/^\n/, "").replace(/\n+$/, "");
      if (!s.trim()) return ""; // only final newlines go: the last line keeps its trailing spaces too
      const fence = "`".repeat(Math.max(3, ...[...s.matchAll(/^ {0,3}(`{3,})/gm)].map((m) => m[1].length + 1)));
      // code keeps its trailing spaces: KEEP shields them from htmlToMarkdown's strip
      return `${fence}\n${s.split("\n").map((l) => (/[ \t]$/.test(l) ? l + KEEP : l)).join("\n")}\n${fence}`;
    }
    case "hr": return "---";
    case "table": return table(n, ctx);
    default: return blocks(n.children, ctx); // div and other containers, tr outside a table
  }
}

// A node list → Markdown blocks joined by sep; runs of inline nodes become paragraphs.
// Two lists of the same kind in a row get "<!-- -->" between them, or they would merge.
function blocks(nodes, ctx, sep = "\n\n", flat = false) {
  const out = [];
  let run = [], last = null;
  // in a tight list item (sep "\n"), a line after a quote, a table or a nested list would
  // join it, and a rule under a line would make it a heading: those get a blank line between
  const apart = (tag) => sep === "\n" && out.length && (["blockquote", "table"].includes(last) || ["hr", "table"].includes(tag) ||
    (tag === "p" && (last === "ul" || last === "ol")));
  const flush = () => {
    const p = flat ? oneLine(run, ctx) : paragraph(run, ctx);
    if (p) { if (apart("p")) out.push(""); out.push(p); last = "p"; }
    run = [];
  };
  for (const n of nodes) {
    if (isInline(n)) { run.push(n); continue; }
    flush();
    // flat (a table cell): one line, a <pre> as a code span, a container's parts spaced
    const s = !flat ? block(n, ctx) : n.tag === "pre" ? codeSpan(textOf(n)) : blocks(n.children, ctx, " ", true);
    if (!s) continue;
    if (!flat && (n.tag === "ul" || n.tag === "ol") && last === n.tag) out.push("<!-- -->");
    else if (apart(n.tag)) out.push("");
    out.push(s);
    last = n.tag;
  }
  flush();
  return out.join(sep);
}

// html → { md, unknown: { tag: count } }. Trailing spaces go from every line but a code
// block's (marked KEEP).
export function htmlToMarkdown(html) {
  const ctx = { unknown: Object.create(null) };
  const md = blocks(parse(html).children, ctx).split("\n")
    .map((l) => (l.endsWith(KEEP) ? l.slice(0, -1) : l.replace(/[ \t]+$/, ""))).join("\n").trim();
  return { md, unknown: ctx.unknown };
}
