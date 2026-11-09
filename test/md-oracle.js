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
// its dependencies, pinned too (it asks for ~ ranges), so a later release of one can't
// move the oracle
const DEPS = ["entities@3.0.1", "mdurl@1.0.1", "minimist@1.2.8"];
const PINS = [COMMONMARK, ...DEPS];
// no install scripts run (the oracle needs none) and no lockfile is written
const INSTALL = ["install", "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund"];

// The pins the cache in dir doesn't satisfy: each package is resolved the way commonmark
// itself requires it (a nested copy under commonmark wins over a top-level one), so a
// cache filled by hand can't hand the oracle other versions.
function unmet(dir) {
  const pkg = join(dir, "node_modules", "commonmark", "package.json");
  if (!existsSync(pkg)) return PINS;
  const req = createRequire(pkg);
  return PINS.filter((pin) => {
    const name = pin.slice(0, pin.lastIndexOf("@"));
    // the lookup's own node_modules order; a package.json behind an exports map can't
    // be required, so it is read from the first directory that has the package
    const at = req.resolve.paths(name).map((p) => join(p, name, "package.json")).find((p) => existsSync(p));
    try {
      return !at || `${name}@${JSON.parse(readFileSync(at, "utf8")).version}` !== pin;
    } catch {
      return true;
    }
  });
}

export function loadCommonmark() {
  const dir = process.env.LEKET_ORACLE_CACHE || join(homedir(), ".cache", "leket-oracle", COMMONMARK);
  if (unmet(dir).length) {
    mkdirSync(dir, { recursive: true });
    try {
      execFileSync("npm", [...INSTALL, "--prefix", dir, ...PINS], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    } catch (e) {
      throw new Error(`the CommonMark oracle needs ${COMMONMARK} and npm couldn't install it into ${dir} `
        + `(network down?). Run: npm ${INSTALL.join(" ")} --prefix "${dir}" ${PINS.join(" ")} — `
        + `or set LEKET_ORACLE_CACHE to a directory that has it. npm said: ${e.stderr || e.message}`);
    }
    const left = unmet(dir);
    if (left.length) throw new Error(`npm reported success but ${dir} still doesn't resolve ${left.join(", ")}`);
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

// What the reader gets from md, quoted `depth` deep: every node (blocks and inlines, a
// soft or hard break included) with its literal, inside the depth outer quotes, which are
// peeled off; quoting (comments) should change none of it. The one accepted difference
// is a closer-shaped code line with a tab in its indent, whose indent quote() expands so
// it can't close the fence two columns over (see md.js scanBlocks): a code block's
// closer-shaped lines are compared without their indent.
export function reading(cm, md, depth = 0) {
  let root = new cm.Parser().parse(md);
  for (let d = 0; d < depth; d++) {
    const q = root.firstChild;
    if (!q || q.type !== "block_quote" || q.next) return `not ${depth} quotes deep`;
    root = q;
  }
  const walker = root.walker();
  const out = [];
  let e;
  while ((e = walker.next())) {
    const n = e.node;
    if (n === root || !e.entering) {
      if (n !== root && n.isContainer) out.push("/");
      continue;
    }
    let lit = n.literal;
    if (n.type === "code_block") {
      lit = lit.split("\n").map((l) => (/^[ \t]*(`{3,}|~{3,})/.test(l) ? l.trimStart() : l)).join("\n");
    }
    out.push([n.type, lit, n.info, n.level, n.listType, n.listTight, n.listStart, n.listDelimiter, n.destination, n.title]);
  }
  return JSON.stringify(out);
}

// safeBody's other promise: every input line comes back, `<` turned into `&lt;` at most
// (and a paragraph's opening `[` into `\[`), plus at most one appended fence closer. A fix
// that escaped everything everywhere (code included) would pass the HTML check; this
// keeps it honest the other way.
export function linesKept(input, output) {
  const inn = input.split(/\r\n|\r|\n/);
  const out = output.split(/\r\n|\r|\n/);
  if (out.length !== inn.length && !(out.length === inn.length + 1 && /^[ >]*(`{3,}|~{3,})$/.test(out[inn.length]))) return false;
  return inn.every((l, k) => {
    const back = out[k].replace(/&lt;/g, "<");
    return back === l || back.replace("\\[", "[") === l;
  });
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
  "    <b>", "- ```", "2. ```", "> ```", "> <b>", "[a]: <b>", "[a]: b", "[a]", "a\r<b>", "\t\t<b>",
  "[a](", "![a](", "[a][", "[`]: /u", "[a](`)", "[a](b \"`\")", "](", "`)<b>`", "\"`\")", ")", "\""];
export function generate(rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const n = 1 + Math.floor(rand() * 8);
  let s = "";
  for (let i = 0; i < n; i++) {
    if (i) s += rand() < 0.2 ? "\n\n" : "\n";
    s += pick(PREFIXES);
    if (rand() < 0.25) s += pick(PREFIXES);
    s += pick(CONTENTS);
    if (rand() < 0.15) s += pick(CONTENTS);
  }
  // a body may end in a line break, which is where a fence's closer goes
  return rand() < 0.1 ? s + pick(["\n", "\r", "\r\n"]) : s;
}
