// src/modules/youtube/driver.js: the driver is injected into the YouTube tab through
// chrome.scripting.executeScript({ func: driveYouTube }), which serializes it with
// toString() — so it must stand entirely on its own, with none of this module's (or
// this file's) context around it. No DOM test here: the smoke's youtube scenario runs
// it for real against a synthetic watch page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as driver from "../src/modules/youtube/driver.js";

test("the driver module exports only driveYouTube", () => {
  assert.deepEqual(Object.keys(driver).sort(), ["driveYouTube"]);
  assert.equal(typeof driver.driveYouTube, "function");
});

test("driveYouTube parses alone, outside its module", () => {
  // a fresh Function scope has no module bindings around it: if the source leaned on
  // any, this parse-and-eval would throw
  const alone = new Function(`return ${driver.driveYouTube.toString()}`)();
  assert.equal(typeof alone, "function");
});

test("driveYouTube's source references none of its module's other top-level names", () => {
  const moduleSource = readFileSync(new URL("../src/modules/youtube/driver.js", import.meta.url), "utf8");
  // an import could never ride along through toString()
  assert.doesNotMatch(moduleSource, /^\s*import\s/m, "driver.js imports something the injected copy can't have");
  // the names driver.js declares at its top level (the function itself aside): one of
  // them appearing in the serialized source would be a free reference in the injected
  // tab, where no such binding exists
  const names = new Set();
  for (const m of moduleSource.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|class|function\*?)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  const src = driver.driveYouTube.toString();
  for (const name of names) {
    if (name === "driveYouTube") continue;
    assert.doesNotMatch(src, new RegExp(`\\b${name}\\b`), `the driver references ${name}`);
  }
});
