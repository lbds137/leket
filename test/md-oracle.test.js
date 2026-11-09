// safeBody against a real CommonMark parser (test/md-oracle.js): no raw HTML survives,
// every input line is kept, and quoting changes nothing the reader gets. Fixed cases pin
// each leak class a review found; the seeded fuzz looks for new ones. LEKET_FUZZ_N and
// LEKET_FUZZ_SEED widen or move it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { safeBody, quote, quoteBody, render } from "../src/modules/reddit/md.js";
import { loadCommonmark, rawHtml, reading, linesKept, prng, generate } from "./md-oracle.js";
import { postPage } from "./fixtures/reddit.js";

const cm = loadCommonmark();
const F = "```";

// a body on its own (a post) and quoted one to three deep (comments, as comments() writes
// them; an odd depth shifts tabs, an even one doesn't): no raw HTML, every line kept, and
// each quoted parse, its quotes peeled off, the same as the body's own
const check = (input, q = quoteBody) => {
  const out = safeBody(input);
  const quoted = [1, 2, 3].map((d) => [d, q(input, d)]);
  const html = [out, ...quoted.map(([, md]) => md)].flatMap((md) => rawHtml(cm, md));
  const kept = linesKept(input, out);
  const own = reading(cm, out);
  const moved = quoted.find(([d, md]) => reading(cm, md, d) !== own);
  return html.length || !kept || moved ? { input, out, html, kept, moved } : null;
};
const show = (f) => `input ${JSON.stringify(f.input)}\n  safeBody ${JSON.stringify(f.out)}\n  `
  + (f.html.length ? `raw HTML ${JSON.stringify(f.html)}`
    : !f.kept ? "a line was lost or changed"
      : `quoting ${f.moved[0]} deep changed what the reader gets: ${JSON.stringify(f.moved[1])}`);

test("quoting changes nothing the reader gets, and the oracle sees it when it does", () => {
  // whole-lead expansion (quote() without content starts) changes what the reader gets
  const moves = [
    `${F}\n\tx\n${F}`, // fence content keeps its tab
    "\t\tx", // indented code
    "```x`\n\t- \t\n  [a]", // a trailing tab ends a text line: still a soft break
    "  x\n1.  \t\n2. \t\t<b>",
    "> 2. > <b>```\n\t>  \t2. ```", // a tab inside a code span on a continuation line
    // a fence run with an info-like tail can't close a fence: compared with its indent
    `${F}\n\t${F}x\n${F}`,
    // a fence's indent is spaces and tabs only: after an NBSP the line isn't closer-shaped
    `${F}\n\t${String.fromCharCode(0xa0)}${F}\n${F}`,
    // a run shorter than the opener, or of the other char, can't close it either
    "````\n \t```\n````",
    `${F}\n\t~~~\n${F}`,
  ];
  // whole-lead expansion is right for these, or changes nothing
  const holds = [
    `  ${F}\n\tx\n  ${F}`, // a tab the fence's indent half uses: expanded, as it must be
    "a  \nb", // a hard break
    // a setext underline or a break with a tab in its lead or body: the whole lead expands
    "- a\n \t---",
    "- b\n \t- -\t-",
  ];
  // a failure says what check() found (which depth moved, and to what), not just the input
  const why = (f, input) => (f ? show(f) : `input ${JSON.stringify(input)}: nothing moved`);
  for (const input of [...moves, ...holds]) { const f = check(input); assert.equal(f, null, why(f, input)); }
  const whole = (s, d) => quote(safeBody(s), d);
  for (const input of moves) { const f = check(input, whole); assert.ok(f?.moved, why(f, input)); }
  for (const input of holds) { const f = check(input, whole); assert.equal(f, null, why(f, input)); }
});

test("the oracle sees a raw tag that safeBody's input would leak", () => {
  assert.deepEqual(rawHtml(cm, "a <b> c"), ["<b>"]);
  assert.deepEqual(rawHtml(cm, "<div>\nx"), ["<div>\nx"]);
  assert.deepEqual(rawHtml(cm, "a &lt;b> c\n\n    <b>\n\n`<b>`"), []);
});

test("each leak class a review found leaves no raw HTML", () => {
  const cases = [
    // a closer-shaped code line with a tab in its indent: kept as written, quoting would
    // make the tab 2 wide and the line a closer, leaving the next line as text
    `${F}\n\t${F}\n<b>\n${F}`,
    `${F}\n \t${F}\n<b>\n${F}`,
    `- ${F}\n  \t${F}\n  <b>`,
    // a sibling item's fence: "2." can't interrupt a paragraph, but it can start an item of an open list
    `1. step\n2. ${F}\n   code\n   ${F}\n   then <b>`,
    // a lone "--" or "===" with no paragraph above is text, so a 4-space line after it continues it
    "--\n    <x>",
    "===\n    <x>",
    // under a quote's paragraph a bare "===" is a lazy continuation, not an underline
    "> foo\n===\n    <x>",
    // a quoted fence inside a list item ends when a line leaves the item
    `- > ${F}\n> <b>`,
    // a gap of 5+ after a marker makes the item's content indented code, not a fence
    `-      ${F}\n  <x>`,
    // "2." behind quote markers can't interrupt the quote's paragraph either
    `> foo\n> 2. ${F}\n>    <x>`,
    // a tab's width moves with the "> " a comment adds: "\t" code on its own, text when quoted
    "\t<b>",
    // a lone \r ends a line for the renderer too
    "    code\r<b>",
    // a link reference definition can't make a setext heading of the paragraph it opens
    "[a]: b\n===\n    <x>",
    // a link's destination, title or reference label is read off the text: a backtick there opens no span
    "[a](`)<x>`",
    "![a](`)<x>`",
    "[a](b \"`\") <x> `",
    "[a](\n`)<x>`",
    "[a](b\n\"`\")<x>`",
    "[`]: /u\n\n[a][`]<x>`",
    // a fence closer after a final lone \r keeps the empty last line
    "```\r",
    "~~~\n\r",
  ];
  const fails = cases.map((c) => check(c)).filter(Boolean);
  assert.equal(fails.length, 0, fails.map(show).join("\n"));
});

test("render: no JSON field written into the file carries raw HTML", () => {
  const evil = "a\n```\n<x> `<y>` [l](`)<z>`";
  const comment = { kind: "t1", data: { author: evil, score: evil, created_utc: 1699000000, body: "```\n<ok>" } };
  const more = { kind: "more", data: { count: 0, parent_id: `t1_${evil}` } };
  const md = render(postPage({
    title: evil, subreddit: evil, author: evil, score: evil, num_comments: evil, permalink: `/r/${evil}/`,
    is_self: false, url: `https://e.com/${evil}`, selftext: "```\n<ok>",
    is_gallery: true, gallery_data: { items: [{ media_id: "m1", caption: evil }, { media_id: "m2", caption: evil }] },
    media_metadata: { m1: { status: evil }, m2: { status: "valid", m: "image/png", s: { u: `https://i.redd.it/${evil}.png` } } },
  }, [comment, more]), { 2: "image-2.png" }, "images");
  // a link post (no gallery) prints its URL as "Links to:"
  const link = render(postPage({ is_self: false, url: `https://e.com/${evil}` }));
  // an unsaved image's URL sits inside <...>: a line break there would end the image
  const image = render(postPage({ is_self: false, post_hint: "image", url: `https://e.com/a.png\n${evil}\\`, selftext: "```\n<ok>" }));
  const lone = render(postPage({ is_self: false, post_hint: "image", url: "https://e.com/a.png\r```\r<x>", selftext: "```\n<ok>" }));
  for (const out of [image, lone]) assert.deepEqual(rawHtml(cm, out), [], out);
  assert.match(image, /^!\[image 1\]\(<https:\/\/e\.com\/a\.png%0A[^\n]*%5C>\)$/m);
  for (const out of [md, link]) {
    assert.deepEqual(rawHtml(cm, out), [], out);
    // the fixture's fields did reach the file: the guard isn't passing on an empty render
    assert.match(out, /&lt;x>/);
  }
  assert.match(md, /Image 2 source: .*&lt;x>/);
  assert.match(link, /Links to: .*&lt;x>/);
});

test("seeded fuzz: no raw HTML, every line kept, quoting changes nothing the reader gets", () => {
  const n = Number(process.env.LEKET_FUZZ_N) || 20000;
  const seed = Number(process.env.LEKET_FUZZ_SEED) || 0x1e4e7;
  const rand = prng(seed);
  const fails = [];
  for (let i = 0; i < n; i++) {
    const f = check(generate(rand));
    if (f) fails.push(f);
  }
  fails.sort((a, b) => a.input.length - b.input.length);
  assert.equal(fails.length, 0, `${fails.length} of ${n} cases failed (seed ${seed}); the shortest:\n`
    + fails.slice(0, 5).map(show).join("\n"));
});
