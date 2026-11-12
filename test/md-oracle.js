// The raw-HTML oracle for safeBody: a real CommonMark parser (commonmark.js, the spec's
// reference implementation, pinned) reads safeBody's output, and any html_inline or
// html_block node in it is a leak: safeBody adds no `<` of its own, so every HTML node
// came from the input. The repo keeps no dependencies, so the parser is installed once
// into a cache outside the tree, the way CI fetches the smoke's pinned Playwright.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
  // resolve() also normalizes a trailing slash on LEKET_ORACLE_CACHE once, so a tmp
  // sibling can't land inside dir (a rename onto its own ancestor's path fails)
  const dir = resolve(process.env.LEKET_ORACLE_CACHE || join(homedir(), ".cache", "leket-oracle", COMMONMARK));
  if (unmet(dir).length) {
    // npm is not same-prefix safe: with the fuzz shards up to five test processes reach
    // this install on a cold cache at once, and two npm's in one prefix corrupt it. Each
    // loader builds its own tmp prefix and the first rename wins; a rename within a
    // parent directory is atomic, so the cache is never seen half-written. A dir that
    // exists but doesn't meet the pins (a DEPS pin bump — the cache path is keyed on
    // COMMONMARK only — a half-written cache, a hand-filled LEKET_ORACLE_CACHE) is
    // stale, not a winner's cache: it is moved aside and the loader's rename retried.
    // Two loaders can race that repair: the first's aside-rename wins and its rename
    // lands; the second's aside-rename fails ENOENT and its retry hits ENOTEMPTY
    // against the winner's cache — the unmet re-check inside takes the benign path.
    const parent = dirname(dir);
    // a loader killed mid-install leaves its tmp prefix behind forever (its finally
    // never runs): sweep any older than an hour — the floor keeps a concurrently-running
    // loader's live tmp safe, since its npm install can outlast it
    try {
      for (const entry of readdirSync(parent)) {
        if (!entry.startsWith(`${basename(dir)}.tmp-`)) continue;
        try {
          const at = join(parent, entry);
          if (Date.now() - statSync(at).mtimeMs > 60 * 60 * 1000) rmSync(at, { recursive: true, force: true });
        } catch { /* a racing loader's finally removed it mid-sweep */ }
      }
    } catch (e) {
      if (e.code !== "ENOENT") { // a parent yet to be created is mkdirSync's job below
        throw new Error(`the CommonMark oracle needs ${COMMONMARK} but its cache parent ${parent} can't be `
          + `read (${e.message}); fix it, or set LEKET_ORACLE_CACHE to a writable directory`);
      }
    }
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    try {
      try {
        execFileSync("npm", [...INSTALL, "--prefix", tmp, ...PINS], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
      } catch (e) {
        throw new Error(`the CommonMark oracle needs ${COMMONMARK} and npm couldn't install it into ${dir} `
          + `(network down?). Run: npm ${INSTALL.join(" ")} --prefix "${dir}" ${PINS.join(" ")} — `
          + `or set LEKET_ORACLE_CACHE to a directory that has it. npm said: ${e.stderr || e.message}`);
      }
      try {
        renameSync(tmp, dir);
      } catch {
        // a rename onto a non-empty dir fails: either another loader's fresh cache
        // landed first (its pins are theirs, nothing to repair) or the dir is stale
        if (unmet(dir).length) {
          const stale = `${dir}.stale-${process.pid}-${Date.now()}`;
          let aside = false;
          try {
            renameSync(dir, stale);
            aside = true;
          } catch { /* a racing loader moved the stale dir aside first */ }
          try {
            renameSync(tmp, dir);
          } catch (e2) {
            const still = unmet(dir);
            if (still.length) {
              throw new Error(`${dir} doesn't resolve ${still.join(", ")} and replacing it failed (${e2.message}); `
                + `delete ${dir} by hand and rerun — Run: rm -rf "${dir}" — or set LEKET_ORACLE_CACHE to a `
                + `directory that has ${COMMONMARK}`);
            }
            // else a racing loader's cache landed between the two renames; benign
          } finally {
            if (aside) rmSync(stale, { recursive: true, force: true });
          }
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const left = unmet(dir);
    if (left.length) throw new Error(`npm reported success but ${dir} still doesn't resolve ${left.join(", ")}`);
  }
  const cm = createRequire(join(dir, "/"))("commonmark");
  // reading() reads a fenced block's opener through private fields; if a commonmark
  // version renames them, say so here rather than as a confusing reading diff
  const fence = new cm.Parser().parse("~~~~\nx\n~~~~").firstChild;
  if (fence?._fenceChar !== "~" || fence?._fenceLength !== 4) {
    throw new Error(`${dir}'s commonmark no longer exposes a fenced block's _fenceChar/_fenceLength, `
      + "which reading() needs: update reading() for this version, or reinstall " + COMMONMARK);
  }
  return cm;
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
// it can't close the fence two columns over (see md.js scanBlocks): a fenced block's
// closer-shaped lines (the opener's char, a run at least the opener's length, then
// trailing spaces or tabs only) are compared without their indent.
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
    if (n.type === "code_block" && n.info !== null) { // fenced: indented code has no info
      // the opener's char and length have no public getter in the pinned commonmark 0.31.2
      const closes = (l) => {
        const m = l.replace(/^[ \t]+/, "").match(/^(`{3,}|~{3,})[ \t]*$/);
        return m && m[1][0] === n._fenceChar && m[1].length >= n._fenceLength;
      };
      lit = lit.split("\n").map((l) => (closes(l) ? l.replace(/^[ \t]+/, "") : l)).join("\n");
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
