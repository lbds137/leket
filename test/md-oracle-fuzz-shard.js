// The seeded fuzz's shared half: check/show (also the fixed cases' helpers in
// md-oracle.test.js, which imports them from here) and runShard, one shard's slice of the
// fuzz. This file must not match test/*.test.js — npm test's glob would collect it as a
// test file of its own.
import assert from "node:assert/strict";

import { safeBody, quoteBody } from "../src/modules/reddit/md.js";
import { loadCommonmark, rawHtml, reading, linesKept, prng, generate } from "./md-oracle.js";

// each shard process builds its own; the loader installs single-flight (test/md-oracle.js),
// so a cold cache shared by the four shard processes is safe too
export const cm = loadCommonmark();

// a body on its own (a post) and quoted one to three deep (comments, as comments() writes
// them; an odd depth shifts tabs, an even one doesn't): no raw HTML, every line kept, and
// each quoted parse, its quotes peeled off, the same as the body's own
export const check = (input, q = quoteBody) => {
  const out = safeBody(input);
  const quoted = [1, 2, 3].map((d) => [d, q(input, d)]);
  const html = [out, ...quoted.map(([, md]) => md)].flatMap((md) => rawHtml(cm, md));
  const kept = linesKept(input, out);
  const own = reading(cm, out);
  const moved = quoted.find(([d, md]) => reading(cm, md, d) !== own);
  return html.length || !kept || moved ? { input, out, html, kept, moved } : null;
};
export const show = (f) => `input ${JSON.stringify(f.input)}\n  safeBody ${JSON.stringify(f.out)}\n  `
  + (f.html.length ? `raw HTML ${JSON.stringify(f.html)}`
    : !f.kept ? "a line was lost or changed"
      : `quoting ${f.moved[0]} deep changed what the reader gets: ${JSON.stringify(f.moved[1])}`);

export const seedOf = (shard) => (Number(process.env.LEKET_FUZZ_SEED) || 0x1e4e7) + shard;
// a quarter each, rounded up: the four shards' n always sum to at least LEKET_FUZZ_N
// (Math.ceil arithmetic), never less than a single-process run of the same N
const nOf = () => Math.ceil((Number(process.env.LEKET_FUZZ_N) || 20000) / 4);

// shard i of 4: its own prng from its own seed (master seed + shard), its own n cases
export function runShard(shard) {
  const n = nOf();
  const seed = seedOf(shard);
  const rand = prng(seed);
  const fails = [];
  for (let i = 0; i < n; i++) {
    const f = check(generate(rand));
    if (f) fails.push(f);
  }
  fails.sort((a, b) => a.input.length - b.input.length);
  assert.equal(fails.length, 0, `shard ${shard} of 4: ${fails.length} of ${n} cases failed (seed ${seed}); the shortest:\n`
    + fails.slice(0, 5).map(show).join("\n"));
}
