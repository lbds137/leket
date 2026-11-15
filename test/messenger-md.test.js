// renderMarkdown (src/modules/messenger/read.js) against a real CommonMark parser
// (test/md-oracle.js): a message's text, quote and sender name come back as literal text,
// with no heading, list, code, HTML, link or emphasis made from them. Fixed cases pin each
// class a review found; a seeded fuzz over md-oracle's generator looks for new ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { loadCommonmark, prng, generate } from "./md-oracle.js";

const sandbox = {};
vm.runInNewContext(readFileSync(new URL("../src/modules/messenger/read.js", import.meta.url), "utf8"), sandbox);
const R = vm.runInContext("globalThis.LeketMessengerRead", sandbox);
const cm = loadCommonmark();
const NBSP = String.fromCharCode(0xa0);

const one = (fields) => R.renderMarkdown({
  title: "T", host: "www.messenger.com", thread_id: "1", time_zone: "UTC",
  messages: [{ id: "m1", time: "2026-11-15T10:00:00.000Z", sender: "S", outgoing: false,
    text: null, reply_to: null, unsent: false, kinds: [], link: null, media: [], ...fields }],
});

// What a reader sees for the input text: lines (any line ending) with leading spaces
// shown as no-break spaces and trailing whitespace gone, blank runs as one paragraph break.
function expected(text) {
  const paras = [];
  let cur = [];
  for (const l of String(text).split(/\r\n|\r|\n/)) {
    if (l.trim() === "") {
      if (cur.length) paras.push(cur);
      cur = [];
    } else {
      cur.push(l.replace(/^[ \t]+/, (w) => w.replace(/\t/g, "    ").replace(/ /g, NBSP)).replace(/[ \t]+$/, ""));
    }
  }
  if (cur.length) paras.push(cur);
  // commonmark.js trims a paragraph with JS trim(), which takes no-break spaces too, so a
  // paragraph's first-line indent is lost there (markdown-it keeps it); the text is not
  return paras.map((p) => p.join("\n").replace(/^\s+/, "")).join("\n\n");
}

// The literal text of a run of paragraph blocks, or why it isn't plain text.
function literal(blocks) {
  const paras = [];
  for (const b of blocks) {
    if (b.type !== "paragraph") return `block ${b.type}`;
    let s = "";
    for (let n = b.firstChild; n; n = n.next) {
      if (n.type === "text") s += n.literal;
      else if (n.type === "linebreak" || n.type === "softbreak") s += "\n";
      else return `inline ${n.type}`;
    }
    paras.push(s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n"));
  }
  return paras.join("\n\n");
}

const children = (node) => {
  const out = [];
  for (let n = node.firstChild; n; n = n.next) out.push(n);
  return out;
};

// [h1, meta, h2 day, header, ...rest]
function parsed(md) {
  const top = children(new cm.Parser().parse(md));
  assert.deepEqual(top.slice(0, 3).map((n) => n.type), ["heading", "paragraph", "heading"], md);
  return { header: top[3], rest: top.slice(4) };
}

function checkText(text) {
  const md = one({ text });
  const { rest } = parsed(md);
  assert.equal(literal(rest), expected(text), `text ${JSON.stringify(text)}\n${md}`);
}

function checkQuote(quoteText) {
  const md = one({ reply_to: { text: quoteText }, text: "after" });
  const { rest } = parsed(md);
  assert.equal(rest[0].type, "block_quote", md);
  assert.equal(literal(children(rest[0])), expected(quoteText), `quote ${JSON.stringify(quoteText)}\n${md}`);
  assert.equal(literal(rest.slice(1)), "after", `quote ${JSON.stringify(quoteText)} swallowed the text\n${md}`);
}

function checkSender(sender) {
  const md = one({ sender, text: "x" });
  const { header } = parsed(md);
  const strong = header.firstChild;
  assert.equal(strong?.type, "strong", `sender ${JSON.stringify(sender)}\n${md}`);
  const shown = sender.replace(/\s+/g, " ").trim() || "unknown";
  assert.equal(literal([{ type: "paragraph", firstChild: strong.firstChild }]), shown, md);
  assert.equal(strong.next?.literal, " 10:00", md);
}

const NASTY = [
  "```", "~~~\ncode", "===", "a\n===", "a\n---", "   - item", "    four", "\tx", "1. one", "2) two", "+ p", "* s",
  "# h", "#", "> q", "<b>x</b>", "<div>", "[l](u)", "[a]: /u", "![i](u)", "*em* _em_ **b**", "~~s~~", "a|b\n-|-",
  "&amp; &#65;", "C:\\dir\\x", "ends in \\", "\\", "a\rb", "a\r\r\nb", "a\r\rb", "line\r===\r# H1\r- list",
  "https://example.com/x", "<https://example.com>", "`code`", "a  \nb", "   ", "x\n\n\n\ny", ` ${NBSP}x`,
];

test("message text renders literally (fixed cases)", () => {
  for (const t of NASTY) checkText(t);
});

test("a reply quote is its own block and renders literally", () => {
  for (const t of NASTY) if (t.trim()) checkQuote(t);
});

test("a sender name renders literally on one line, inside the bold", () => {
  for (const s of ["A*b", "**", "Alice ", " Alice", "Alice\n# H\n- item", "a_b_", "<b>", "[x](y)", "\\", "1.", "#", "`"]) {
    checkSender(s);
  }
  assert.ok(one({ sender: "   ", sender_id: "7", text: "x" }).includes("**7** 10:00"));
});

test("message text, quotes and names render literally (seeded fuzz)", () => {
  const n = Number(process.env.LEKET_FUZZ_N || 300);
  const rand = prng(Number(process.env.LEKET_FUZZ_SEED || 1115));
  for (let i = 0; i < n; i++) {
    const s = generate(rand);
    if (s.trim()) {
      checkText(s);
      checkQuote(s);
    }
    checkSender(s.split(/\r\n|\r|\n/)[0]);
  }
});

test("the meta line is escaped once", () => {
  const md = R.renderMarkdown({ host: "a_b", thread_id: "t_1", messages: [] });
  const meta = children(new cm.Parser().parse(md))[1];
  assert.equal(literal([meta]).startsWith("a_b · thread t_1 · 0 messages"), true, md);
});

test("notes: unsent hides media, fallback without an entry, partial capture, link destination", () => {
  const notes = (fields, extra = {}) => {
    const md = R.renderMarkdown({ time_zone: "UTC", ...extra, messages: [{ id: "m1", time: "2026-11-15T10:00:00.000Z",
      sender: "S", text: null, kinds: [], link: null, media: [], ...fields }] });
    return md.slice(md.indexOf("**S** 10:00") + "**S** 10:00".length).trim();
  };
  assert.equal(notes({ unsent: true, kinds: ["media", "sticker", "link"], link: "https://e.x/u",
    media: [{ file: "u.jpg", kind: "photo" }] }, { media_not_captured: [{ message_id: "m1", kind: "video" }] }), "[unsent]");
  assert.equal(notes({ kinds: ["media"] }), "[photo, not captured]");
  assert.equal(notes({ kinds: ["media", "video"] }), "[video, not captured]");
  assert.equal(notes({ kinds: ["media"], media: [{ file: "p.jpg", kind: "photo" }] },
    { media_not_captured: [{ message_id: "m1", kind: "photo" }, { message_id: "m1", kind: "video" }] }),
  "![photo](messenger-media/p.jpg)\\\n[photo, not captured]\\\n[video, not captured]");
  assert.equal(notes({ kinds: ["media"], media: [{ file: "v.mp4", kind: "video", duration_s: 9.6 }] }),
    "[video, 10 s](messenger-media/v.mp4)");

  const link = "https://example.com/a b/<c>\\d(1)";
  const md = one({ kinds: ["link"], link });
  let dest = null;
  const w = new cm.Parser().parse(md).walker();
  for (let e; (e = w.next());) if (e.entering && e.node.type === "link") dest = e.node.destination;
  assert.equal(decodeURIComponent(dest), link, md);
});

test("mediaName ignores Object.prototype keys as MIME types", () => {
  for (const mime of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(R.mediaName("2026-11-15", "m1", 1, mime), "2026-11-15_m1_1.bin");
  }
});
