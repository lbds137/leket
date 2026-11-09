// The raw-HTML oracle for safeBody: a real CommonMark parser (commonmark.js, the spec's
// reference implementation, pinned) reads safeBody's output, and any html_inline or
// html_block node in it is a leak: safeBody adds no `<` of its own, so every HTML node
// came from the input. The repo keeps no dependencies, so the parser is installed once
// into a cache outside the tree, the way CI fetches the smoke's pinned Playwright.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export const COMMONMARK = "commonmark@0.31.2";

export function loadCommonmark() {
  const version = COMMONMARK.split("@")[1];
  const dir = process.env.LEKET_ORACLE_CACHE || join(homedir(), ".cache", "leket-oracle", COMMONMARK);
  const pkg = join(dir, "node_modules", "commonmark", "package.json");
  const installed = () => existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).version === version;
  if (!installed()) {
    mkdirSync(dir, { recursive: true });
    try {
      execFileSync("npm", ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", COMMONMARK],
        { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    } catch (e) {
      throw new Error(`the CommonMark oracle needs ${COMMONMARK} and npm couldn't install it into ${dir} `
        + `(network down?). Run: npm install --prefix "${dir}" --no-save ${COMMONMARK} — `
        + `or set LEKET_ORACLE_CACHE to a directory that has it. npm said: ${e.stderr || e.message}`);
    }
    if (!installed()) throw new Error(`npm reported success but ${pkg} isn't ${COMMONMARK}`);
  }
  return createRequire(join(dir, "/"))("commonmark");
}

// the literal of every raw HTML node CommonMark finds in md
export function rawHtml(cm, md) {
  const walker = new cm.Parser().parse(md).walker();
  const hits = [];
  let e;
  while ((e = walker.next())) {
    if (e.entering && (e.node.type === "html_inline" || e.node.type === "html_block")) hits.push(e.node.literal);
  }
  return hits;
}

// safeBody's other promise: every input line comes back, `<` turned into `&lt;` at most,
// plus at most one appended fence closer. A fix that escaped everything everywhere (code
// included) would pass the HTML check; this keeps it honest the other way.
export function linesKept(input, output) {
  const inn = input.split("\n");
  const out = output.split("\n");
  if (out.length !== inn.length && out.length !== inn.length + 1) return false;
  return inn.every((l, k) => out[k].replace(/&lt;/g, "<") === l);
}

// mulberry32: a seeded PRNG, so a failing case reproduces from its seed
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Inputs built line by line: a container prefix (or two) then a content atom, so the
// block structures safeBody tracks (fences in quotes and list items, ordered markers
// other than 1, indented code, setext underlines, lazy continuations) turn up often.
const PREFIXES = ["", "", "", "> ", ">", "> > ", "- ", "* ", "1. ", "2. ", "10. ", "1) ", "-      ", " ", "  ", "   ",
  "    ", "     ", "\t", " \t", "-\t", "1.\t", "- \t", "> - ", "> 1. ", "> 2. ", "- > ", "1. > ", "  - ", "   > "];
const CONTENTS = ["```", "````", "~~~", "``` js", "```x`", "<b>", "<div>", "<!-- c", "<x> y", "a <b> c", "`", "``", "a `b",
  "`<b>`", "a ` <b>", "\\`", "\\<b>", "---", "===", "***", "--", "=", "-", "1.", "# h", "#", "text", "x", "", "\t<b>",
  "    <b>", "- ```", "2. ```", "> ```", "> <b>"];
export function generate(rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const n = 1 + Math.floor(rand() * 8);
  let s = "";
  for (let i = 0; i < n; i++) {
    if (i) s += rand() < 0.2 ? "\n\n" : "\n";
    s += pick(PREFIXES);
    if (rand() < 0.25) s += pick(PREFIXES);
    s += pick(CONTENTS);
  }
  return s;
}
