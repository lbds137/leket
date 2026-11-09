// safeBody against a real CommonMark parser (test/md-oracle.js): no raw HTML survives,
// and every input line is kept. Fixed cases pin each leak class a review found; the
// seeded fuzz looks for new ones. LEKET_FUZZ_N and LEKET_FUZZ_SEED widen or move it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { safeBody, quote } from "../src/modules/reddit/md.js";
import { loadCommonmark, rawHtml, linesKept, prng, generate } from "./md-oracle.js";

const cm = loadCommonmark();
const F = "```";

// a body on its own (a post) and quoted one and two deep (comments, as comments() writes them)
const check = (input) => {
  const out = safeBody(input);
  const html = [out, quote(out, 1), quote(out, 2)].flatMap((md) => rawHtml(cm, md));
  const kept = linesKept(input, out);
  return html.length || !kept ? { input, out, html, kept } : null;
};
const show = (f) => `input ${JSON.stringify(f.input)}\n  safeBody ${JSON.stringify(f.out)}\n  `
  + (f.html.length ? `raw HTML ${JSON.stringify(f.html)}` : "a line was lost or changed");

test("the oracle sees a raw tag that safeBody's input would leak", () => {
  assert.deepEqual(rawHtml(cm, "a <b> c"), ["<b>"]);
  assert.deepEqual(rawHtml(cm, "<div>\nx"), ["<div>\nx"]);
  assert.deepEqual(rawHtml(cm, "a &lt;b> c\n\n    <b>\n\n`<b>`"), []);
});

test("each leak class a review found leaves no raw HTML", () => {
  const cases = [
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
  ];
  const fails = cases.map(check).filter(Boolean);
  assert.equal(fails.length, 0, fails.map(show).join("\n"));
});

test("seeded fuzz: no raw HTML, every line kept", () => {
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
