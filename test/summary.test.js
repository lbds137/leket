// src/lib/summary.js: the export tab's click decisions and its summary, as plain data.
// These are the scenarios once checked by hand in Chrome: a retry, a click while
// downloading, a click before Chrome gave an id, a click before the build returned, and a
// click after the part was saved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clickStep, endStep, stateStep, summarize } from "../src/lib/summary.js";

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
  assert.equal(stateStep("unavailable"), "unavailable", "Chrome couldn't be asked: nothing is known");
  // the start was refused, so there is no id to ask about
  assert.equal(clickStep({ ...idle, lastId: null }), "retry");
});

test("a try's end: a finish saves whichever try it was; a failure speaks only for the latest", () => {
  const latest = { saved: false, latest: true, inFlight: false };
  assert.equal(endStep({ ...latest, ok: true }), "save");
  assert.equal(endStep({ ...latest, ok: false }), "didnt-finish");
  assert.equal(endStep({ ...latest, ok: null }), "no-word");
  // an older try held up past the wait, finishing while a retry runs: still saves
  assert.equal(endStep({ ok: true, saved: false, latest: false, inFlight: true }), "save");
  // ...but its failure must not relabel the retry, nor the latest's own after it
  assert.equal(endStep({ ok: false, saved: false, latest: false, inFlight: true }), "ignore");
  assert.equal(endStep({ ok: false, saved: false, latest: false, inFlight: false }), "ignore");
  // the latest try's late failure while a newer click is starting one is not said either
  assert.equal(endStep({ ok: false, saved: false, latest: true, inFlight: true }), "ignore");
  // once saved, a cancelled or late try leaves the label be
  assert.equal(endStep({ ok: false, saved: true, latest: true, inFlight: false }), "keep");
  assert.equal(endStep({ ok: null, saved: true, latest: true, inFlight: false }), "keep");
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
  const clean = { failed: [], messages: 5, attachments: 2, streamed: false, results: [{ index: 1, ok: true }],
    records: [{ filename: "a", part: 1 }, { filename: "b", part: 1 }] };
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
  assert.match(s.status, /discord-attachments\.json was written before part 2 was saved/);
  // while a part is still failing, the stop's own advice shows
  const failing = summarize({ ...streamedFailure(), leftBehind: 4, first: true,
    results: [{ index: 1, ok: true }, { index: 2, ok: false }, { index: 3, ok: true }] });
  assert.match(failing.status, /The save stopped there — 4 attachment\(s\) never got into a part/);
});

test("a save without attachments counts only messages, and only once their zip is saved", () => {
  const s = summarize({ failed: [], messages: 3, attachments: 0, streamed: false, results: [{ index: 1, ok: false }], first: true });
  assert.match(s.status, /^The 3 messages are in the zip, which isn't saved yet\. 1 part\(s\) didn't finish/);
  const saved = summarize({ failed: [], messages: 3, attachments: 0, streamed: false, results: [{ index: 1, ok: true }], first: true });
  assert.match(saved.status, /^Saved 3 messages\. Every part is downloaded\./);
});

// a small save in 3 parts: 10 files, one dead link, four of them in part 2
const smallSave = () => {
  const records = Array.from({ length: 10 }, (_, k) => ({ filename: `f${k}`, part: k < 3 ? 1 : k < 7 ? 2 : 3 }));
  records[9] = { filename: "dead.png", error: "x" };   // never fetched: in no part
  return { records, failed: [records[9]], messages: 40, attachments: 10, streamed: false };
};

test("a small save's failed part: its files aren't counted as saved until a click saves it", () => {
  const s = summarize({ ...smallSave(), first: true,
    results: [{ index: 1, ok: true }, { index: 2, ok: false }, { index: 3, ok: true }] });
  assert.match(s.status, /^Saved 40 messages and 5 of 10 attachments\. 1 part\(s\) didn't finish/);
  assert.equal(s.lost.length, 1, "the part's files are waiting on a click, not lost");
  const later = summarize({ ...smallSave(), first: false,
    results: [{ index: 1, ok: true }, { index: 2, ok: true }, { index: 3, ok: true }] });
  assert.match(later.status, /^Saved 40 messages and 9 of 10 attachments\./);
});

test("part 1 not saved: the messages aren't counted as saved, in either kind of save", () => {
  const small = summarize({ ...smallSave(), first: true,
    results: [{ index: 1, ok: false }, { index: 2, ok: true }, { index: 3, ok: true }] });
  assert.match(small.status, /^The 40 messages are in part 1, which isn't saved yet; saved 6 of 10 attachments\. 1 part\(s\) didn't finish/);
  // a streamed save stops at its failed first part: every file is left behind, and only
  // the manifest's own part goes out after it
  const left = Array.from({ length: 10 }, (_, k) => rec(`f${k}`, { error: "not saved — the save stopped early" }));
  const streamed = summarize({ failed: left, leftBehind: 10, messages: 40, attachments: 10, streamed: true, first: true,
    results: [{ index: 1, ok: false }, { index: 2, ok: true }] });
  assert.match(streamed.status, /^The 40 messages are in part 1, which isn't saved yet; saved 0 of 10 attachments\. 1 part\(s\) didn't finish/);
  // build.js's drain names every streamed part `${base}-part${index}.zip`, so even with
  // only the first handed over, "part 1" is its name
  const alone = summarize({ failed: left, leftBehind: 10, messages: 40, attachments: 10, streamed: true, first: true,
    results: [{ index: 1, ok: false }] });
  assert.match(alone.status, /^The 40 messages are in part 1, which isn't saved yet/);
});
