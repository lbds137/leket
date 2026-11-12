// One quarter of the seeded fuzz (the shared half lives in md-oracle-fuzz-shard.js): node
// --test runs each shard file as its own process, so the four run in parallel, each with
// its own prng and seed.
import { test } from "node:test";

import { runShard, seedOf } from "./md-oracle-fuzz-shard.js";

test(`seeded fuzz shard 1 (seed ${seedOf(1)}): no raw HTML, every line kept, quoting changes nothing the reader gets`, () => runShard(1));
