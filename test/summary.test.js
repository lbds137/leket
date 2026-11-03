// src/lib/summary.js: the export tab's click decisions and its summary, as plain data.
// These are the scenarios once checked by hand in Chrome: a retry, a click while
// downloading, a click before Chrome gave an id, a click before the build returned, and a
// click after the part was saved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clickStep, stateStep, summarize } from "../src/lib/summary.js";

const idle = { busy: false, saved: false, inFlight: false };

test("a click after the part was saved, or while a click is answered, does nothing", () => {
  assert.equal(clickStep({ ...idle, saved: true, lastId: 3 }), "ignore");
  assert.equal(clickStep({ ...idle, busy: true, lastId: 3 }), "ignore");
  assert.equal(clickStep({ ...idle, saved: true, inFlight: true, lastId: 3 }), "ignore");
});

test("a click while a download is under way never starts another", () => {
  assert.equal(clickStep({ ...idle, inFlight: true, lastId: null }), "starting", "before Chrome gave an id");
  assert.equal(clickStep({ ...idle, inFlight: true, lastId: 3 }), "downloading");
});

test("a retry asks Chrome about the last download first, and downloads again only when it is over or gone", () => {
  assert.equal(clickStep({ ...idle, lastId: 3 }), "ask");
  assert.equal(stateStep("complete"), "saved", "it finished after all");
  assert.equal(stateStep("in_progress"), "downloading");
  assert.equal(stateStep("interrupted"), "retry");
  assert.equal(stateStep(null), "retry", "erased from Chrome's list");
  // the start was refused, so there is no id to ask about
  assert.equal(clickStep({ ...idle, lastId: null }), "retry");
});

// a streamed save whose part 2 failed: two files in it, one dead link, one left behind
const rec = (filename, extra = {}) => ({ filename, error: "x", ...extra });
const streamedFailure = () => ({
  failed: [rec("a.png", { failedPart: 2 }), rec("b.png", { failedPart: 2 }), rec("dead.png")],
  messages: 40, attachments: 10, streamed: true,
});

test("a failed part: the save is held, its files are lost, the status says to click it", () => {
  const s = summarize({ ...streamedFailure(), leftBehind: 0, first: true,
    results: [{ index: 1, ok: true }, { index: 2, ok: false }, { index: 3, ok: true }] });
  assert.equal(s.release, false);
  assert.equal(s.close, false);
  assert.equal(s.lost.length, 3);
  assert.match(s.detail, /^The save is in 3 parts: .*1 part\(s\) above didn't finish/);
  assert.match(s.status, /^Saved 40 messages and 7 of 10 attachments\. 1 part\(s\) didn't finish/);
  assert.match(s.status, /If your disk is full/);
  assert.doesNotMatch(s.status, /discord-attachments\.json was written before/);
  assert.equal(s.warn, true);
});

test("a click saves the failed part after the build: its files count as saved, the manifest note shows", () => {
  const s = summarize({ ...streamedFailure(), leftBehind: 0, first: false,
    results: [{ index: 1, ok: true }, { index: 2, ok: true }, { index: 3, ok: true }] });
  assert.deepEqual(s.lost.map((r) => r.filename), ["dead.png"]);
  assert.equal(s.release, true);
  assert.match(s.status, /9 of 10 attachments/);
  assert.match(s.status, /discord-attachments\.json was written before part 2 was saved/);
});

test("a click saves the part before the build returned: the first draw keeps the tab open to say so", () => {
  const f = streamedFailure();
  f.failed = f.failed.slice(0, 2);   // no dead link: everything ends up saved
  const s = summarize({ ...f, leftBehind: 0, first: true,
    results: [{ index: 1, ok: true }, { index: 2, ok: true }, { index: 3, ok: true }] });
  assert.equal(s.lost.length, 0);
  assert.equal(s.close, false, "the manifest no longer tells the truth, so the tab says so");
  assert.match(s.status, /Every part is downloaded\. discord-attachments\.json was written before part 2/);
  assert.equal(s.warn, true);
});

test("a clean save closes on its first draw; saved by a click later, it stays with an answer", () => {
  const clean = { failed: [], messages: 5, attachments: 2, streamed: false, results: [{ ok: true }] };
  const first = summarize({ ...clean, first: true });
  assert.equal(first.close, true);
  assert.equal(first.release, true);
  assert.equal(first.detail, "Unzip it and open index.html to read it. ");
  const later = summarize({ ...clean, first: false });
  assert.equal(later.close, false);
  assert.equal(later.status, "Saved 5 messages and 2 of 2 attachments. Every part is downloaded.");
  assert.equal(later.warn, false);
});

test("files left out of every part keep the save held, whatever the parts do", () => {
  const s = summarize({ ...streamedFailure(), leftBehind: 4, first: false,
    results: [{ index: 1, ok: true }, { index: 2, ok: true }, { index: 3, ok: true }] });
  assert.equal(s.release, false);
  assert.match(s.status, /This tab stays open because 1 attachment\(s\) could not be saved\. The save stopped early, so 4 of them/);
});

test("a save without attachments counts only messages", () => {
  const s = summarize({ failed: [], messages: 3, attachments: 0, streamed: false, results: [{ ok: false }], first: true });
  assert.match(s.status, /^Saved 3 messages\. 1 part\(s\) didn't finish/);
});
