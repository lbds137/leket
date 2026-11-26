// src/convert/common.js: shared converter helpers (escapeTag, safeTitle, badFolder, stamp, span).
import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeTag } from "../src/convert/common.js";

test("escapeTag: escapes < starting a tag/autolink and & starting a reference unless an odd backslash run already escapes it", () => {
  assert.equal(escapeTag("\\&lt;"), "\\&lt;");
  assert.equal(escapeTag("\\\\&lt;"), "\\\\\\&lt;");
  assert.equal(escapeTag("&#x1F600;"), "\\&#x1F600;");
  assert.equal(escapeTag("a & b"), "a & b");
  assert.equal(escapeTag("<<b"), "<\\<b");
  assert.equal(escapeTag("&&amp;"), "&\\&amp;");
});
