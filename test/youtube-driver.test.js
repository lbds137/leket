// src/modules/youtube/driver.js: the driver is injected into the YouTube tab through
// chrome.scripting.executeScript({ func: driveYouTube }), which serializes it with
// toString() — so it must stand entirely on its own, with none of this module's (or
// this file's) context around it. The smoke's youtube scenario runs it for real against
// a synthetic watch page; the stub-DOM runs below pin timing edges a real page can't
// hit on cue, on a fake clock.
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

// Runs the driver against a page with no comments, no transcript segments and, unless
// `button` is set, no transcript button either, on a fake clock that a sleep advances
// at once. `now(clock)` may move the clock (a hook for the deadline race);
// `href(clock)` is the address bar at each read.
async function stubRun(opts, { now = () => {}, href, button = false }) {
  let clock = 0;
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, replaceChildren() {}, textContent: "" });
  const document = {
    title: "Fake - YouTube",
    documentElement: { appendChild() {}, lang: "en", scrollHeight: 0 },
    getElementById: () => null,
    createElement: el,
    querySelector: (sel) => (button && /transcript-section-renderer button$/.test(sel) ? { click() {} } : null),
    querySelectorAll: () => [],
  };
  const location = { get href() { return href(clock); } };
  const FakeDate = { now() { const t = clock; clock = now(t) ?? clock; return t; } };
  const fakeTimeout = (fn, ms) => { clock += ms; setImmediate(fn); };
  const drive = new Function("document", "window", "location", "Date", "setTimeout",
    `return ${driver.driveYouTube.toString()}`)(document, {}, location, FakeDate, fakeTimeout);
  return drive(opts);
}

const WATCH = "https://www.youtube.com/watch?v=vid";

test("a stop that comes after the transcript wait ended on its own doesn't mark the transcript unread", async () => {
  // the button wait runs to its own end at 1000; the tab moves to another video right
  // after the wait's last check, so the comments phase stops on it, not the transcript
  let readsAtEnd = 0;
  const r = await stubRun({ stepMs: 200, transcriptWaitMs: 1000 }, {
    href: (clock) => (clock >= 1000 && readsAtEnd++ >= 1 ? "https://www.youtube.com/watch?v=other" : WATCH),
  });
  assert.equal(r.aborted, "video-changed");
  assert.equal(r.metadata.transcript_note, "YouTube shows no transcript for this video.");
});

test("a transcript wait whose end was the run's deadline is a stop, even when the clock crossed it after the wait's last check", async () => {
  // the wait's bound is the deadline (1000). The wait's check at 999 passes, and the
  // clock reaches 1000 before the loop's own time test: the wait ended on the deadline
  const r = await stubRun({ stepMs: 666, transcriptWaitMs: 1000, maxMs: 1000 }, {
    now: (t) => (t === 999 ? 1000 : undefined),
    href: () => WATCH,
  });
  assert.equal(r.aborted, "time");
  assert.equal(r.metadata.transcript_note, "Not read: the save stopped before the transcript loaded.");
});

test("the segments wait, too, is a stop when its end was the deadline the clock crossed after its last check", async () => {
  // the button is there at once, so the segments wait starts at 0 with the deadline
  // (1000) as its bound, well inside transcriptWaitMs
  const r = await stubRun({ stepMs: 666, transcriptWaitMs: 5000, maxMs: 1000 }, {
    now: (t) => (t === 999 ? 1000 : undefined),
    href: () => WATCH,
    button: true,
  });
  assert.equal(r.aborted, "time");
  assert.equal(r.metadata.transcript_note, "Not read: the save stopped before the transcript loaded.");
});
