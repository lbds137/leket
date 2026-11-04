// src/lib/download.js and src/lib/part.js: downloads followed until they end, and one
// part's tries across them, with a stand-in for chrome.downloads that the test drives by
// hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadState, trackDownload } from "../src/lib/download.js";
import { createPartDownload } from "../src/lib/part.js";

// a chrome.downloads stand-in: download() resolves when the test says, with the id the test
// picks (calls queue up, so an older held-up call can be resolved after a newer one);
// search() reports whatever state the test set; fire() sends an onChanged event
function fakeDownloads() {
  const listeners = new Set();
  const states = new Map();
  const answers = [];
  const api = {
    calls: [],
    searches: [],
    cancelled: [],
    onChanged: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    download(opts) {
      api.calls.push(opts);
      return new Promise((resolve, reject) => { answers.push({ resolve, reject }); });
    },
    search: async ({ id }) => {
      api.searches.push(id);
      return states.has(id) ? [{ id, state: states.get(id) }] : [];
    },
    // start(id) resolves the oldest held-up call; start(id, n) the n-th, for an id that
    // must arrive out of order
    start: (id, at) => (at === undefined ? answers.shift() : answers.splice(at, 1)[0]).resolve(id),
    refuse: () => answers.shift().reject(new Error("refused")),
    cancel: async (id) => { api.cancelled.push(id); },
    set: (id, state) => states.set(id, state),
    fire: (id, state) => { for (const f of [...listeners]) f({ id, state: { current: state } }); },
    listening: () => listeners.size,
  };
  return api;
}

// lets the promise callbacks inside trackDownload run
const settle = () => new Promise((r) => setImmediate(r));

test("a download settles on its own id's complete event, not on another download's", async () => {
  const d = fakeDownloads();
  let out = "pending";
  trackDownload(d, { url: "blob:x", filename: "a-part1.zip" }).then((v) => { out = v; });
  assert.deepEqual(d.calls, [{ url: "blob:x", filename: "a-part1.zip" }]);
  d.start(7);
  await settle();
  d.fire(8, "complete");
  await settle();
  assert.equal(out, "pending", "another download's event is ignored");
  d.fire(7, "complete");
  await settle();
  assert.equal(out, true);
  assert.equal(d.listening(), 0, "the listener is removed once it settles");
});

test("an interrupted download or a refused start settles false", async () => {
  const d = fakeDownloads();
  const p = trackDownload(d, { url: "blob:x", filename: "a.zip" });
  d.start(3);
  await settle();
  d.fire(3, "interrupted");
  assert.equal(await p, false);
  const e = fakeDownloads();
  const q = trackDownload(e, { url: "blob:x", filename: "a.zip" });
  e.refuse();
  assert.equal(await q, false);
  assert.equal(e.listening(), 0);
});

test("a download done before its id came back is read from the download record", async () => {
  const d = fakeDownloads();
  const p = trackDownload(d, { url: "blob:x", filename: "a.zip" });
  // its complete event came while the id was still unknown, so it was ignored
  d.fire(5, "complete");
  d.set(5, "complete");
  d.start(5);
  assert.equal(await p, true);
});

test("no word within the timeout settles null: it may still be downloading", async () => {
  const d = fakeDownloads();
  const p = trackDownload(d, { url: "blob:x", filename: "a.zip" }, { timeout: 5 });
  d.start(9);
  assert.equal(await p, null);
  assert.equal(d.listening(), 0);
  d.fire(9, "complete");   // a late event after the timeout changes nothing
});

test("with onLate, a download that settles in time stops being watched like any other", async () => {
  const d = fakeDownloads();
  const late = [];
  const p = trackDownload(d, { url: "blob:x", filename: "a.zip" }, { onLate: (ok) => late.push(ok) });
  d.start(2);
  await settle();
  d.fire(2, "complete");
  assert.equal(await p, true);
  assert.equal(d.listening(), 0);
  const e = fakeDownloads();
  const q = trackDownload(e, { url: "blob:x", filename: "a.zip" }, { onLate: (ok) => late.push(ok) });
  e.refuse();
  assert.equal(await q, false);
  assert.equal(e.listening(), 0);
  assert.deepEqual(late, [], "an in-time end is the promise's, not onLate's");
});

test("with onLate, a download still going at the timeout is watched to its end", async () => {
  const d = fakeDownloads();
  const late = [];
  const p = trackDownload(d, { url: "blob:x", filename: "a.zip" }, { timeout: 5, onLate: (ok, id) => late.push([ok, id]) });
  d.start(9);
  assert.equal(await p, null);
  assert.equal(d.listening(), 1, "still watching after the timeout");
  d.fire(3, "complete");   // another download's end is not this one's
  assert.deepEqual(late, []);
  d.fire(9, "complete");
  assert.deepEqual(late, [[true, 9]]);
  assert.equal(d.listening(), 0);
  d.fire(9, "interrupted");   // told once
  assert.deepEqual(late, [[true, 9]]);

  const e = fakeDownloads();
  const lateE = [];
  const q = trackDownload(e, { url: "blob:x", filename: "a.zip" }, { timeout: 5, onLate: (ok, id) => lateE.push([ok, id]) });
  e.start(4);
  assert.equal(await q, null);
  e.fire(4, "interrupted");
  assert.deepEqual(lateE, [[false, 4]]);
});

test("with onLate, an id or a refusal arriving after the timeout is still handled", async () => {
  // the id comes back after the timeout, its download already done: read from the record
  const d = fakeDownloads();
  const late = [];
  const p = trackDownload(d, { url: "blob:x", filename: "a.zip" }, { timeout: 5, onLate: (ok, id) => late.push([ok, id]) });
  assert.equal(await p, null);
  d.set(6, "complete");
  d.start(6);
  await settle();
  assert.deepEqual(late, [[true, 6]]);
  assert.equal(d.listening(), 0);
  // refused after the timeout: it didn't finish, and there is nothing left to watch
  const e = fakeDownloads();
  const lateE = [];
  const q = trackDownload(e, { url: "blob:x", filename: "a.zip" }, { timeout: 5, onLate: (ok) => lateE.push(ok) });
  assert.equal(await q, null);
  e.refuse();
  await settle();
  assert.equal(e.listening(), 0);
  assert.deepEqual(lateE, [false]);
});

test("each try is its own download: a retry after a failure can succeed", async () => {
  const d = fakeDownloads();
  const first = trackDownload(d, { url: "blob:x", filename: "a.zip" });
  d.start(1);
  await settle();
  d.fire(1, "interrupted");
  assert.equal(await first, false);
  const again = trackDownload(d, { url: "blob:x", filename: "a.zip" });
  d.start(2);
  await settle();
  d.fire(2, "complete");
  assert.equal(await again, true);
  assert.equal(d.calls.length, 2);
});

test("onStart gets the id, so a later click can ask Chrome where that download stands", async () => {
  const d = fakeDownloads();
  let started = null;
  const p = trackDownload(d, { url: "blob:x", filename: "a.zip" }, { timeout: 5, onStart: (id) => { started = id; } });
  d.set(4, "in_progress");
  d.start(4);
  assert.equal(await p, null, "no word in time");
  assert.equal(started, 4);
  assert.equal(await downloadState(d, 4), "in_progress");
  d.set(4, "complete");
  assert.equal(await downloadState(d, 4), "complete", "a late finish is still found");
  assert.equal(await downloadState(d, 99), null, "a download Chrome no longer lists");
  const broken = { search: async () => { throw new Error("no"); } };
  assert.equal(await downloadState(broken, 4), "unavailable");
});

test("Chrome failing to answer is not the same as the download being erased", async () => {
  // erased: Chrome answered and no longer lists it — null, and a click downloads again
  const d = fakeDownloads();
  assert.equal(await downloadState(d, 99), null);
  // a failed search says so: nothing is known about the download's state
  const broken = { search: async () => { throw new Error("no"); } };
  assert.equal(await downloadState(broken, 4), "unavailable");
});

// the part factory (src/lib/part.js) with hooks standing in for the page: notes collects
// the label kinds it asks for, saved and freed count the part-level callbacks
function partHarness() {
  const seen = { notes: [], saved: 0, freed: 0 };
  return {
    seen,
    hooks: {
      label: (kind) => seen.notes.push(kind),
      saved: () => { seen.saved++; },
      free: () => { seen.freed++; },
    },
  };
}

test("a part: a finish in time saves it, a failure says so, and the result answers ok", async () => {
  const d = fakeDownloads();
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  const p = part.start();
  d.start(3);
  await settle();
  d.fire(3, "complete");
  await p;
  assert.equal(part.result.ok, true, "the finish lands in the result the page reads");
  assert.equal(seen.saved, 1);
  // the page may be told more than once (the save's own free, then the end's): revoking
  // a blob URL twice is harmless
  assert.ok(seen.freed >= 1, "nothing else reads the blob: the page may revoke the URL");
  assert.deepEqual(seen.notes, [], "a clean finish needs no label");
  assert.deepEqual(part.result, { name: "a.zip", index: 1, ok: true });

  const e = fakeDownloads();
  const fail = partHarness();
  const bad = createPartDownload(e, { url: "blob:x", name: "b.zip", index: 2 }, fail.hooks, { timeout: 5 });
  const q = bad.start();
  e.refuse();
  await q;
  assert.equal(bad.result.ok, false, "a refused start lands in the result too");
  assert.deepEqual(fail.seen.notes, ["didnt-finish"]);
  assert.deepEqual(bad.result, { name: "b.zip", index: 2, ok: false });
});

test("a click while a try is under way never starts another", async () => {
  const d = fakeDownloads();
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  const p = part.start();
  await part.click();   // the call is out but Chrome has given no id yet
  assert.deepEqual(seen.notes, ["starting"]);
  assert.equal(d.calls.length, 1, "no second download");
  d.start(3);
  await settle();       // id 3 is in; the download itself is still going
  await part.click();
  assert.deepEqual(seen.notes, ["starting", "downloading"]);
  assert.equal(d.calls.length, 1);
  d.fire(3, "complete");
  await p;
  assert.equal(part.result.ok, true);
  assert.equal(seen.saved, 1);
  assert.deepEqual(seen.notes, ["starting", "downloading"]);
});

test("an id held up past the wait must not take lastId from the latest try", async () => {
  const d = fakeDownloads();
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  await part.start();   // try 1: its download() call is held up, no id ever came in time
  assert.deepEqual(seen.notes, ["no-word"]);
  await part.click();   // no id to ask Chrome about: download again (try 2; the click's
                        // own wait for try 2 then adds its no-word note)
  assert.deepEqual(seen.notes, ["no-word", "saving-again", "no-word"]);
  d.start(9);           // try 1's held-up call lands at last, after try 2 began
  await settle();
  assert.deepEqual(d.cancelled, [], "the part is not saved: the late id is only bookkept");
  const searches = d.searches.length;
  await part.click();
  assert.equal(d.searches.length, searches, "the late id did not become lastId: no ask, straight to a retry");
  assert.equal(d.calls.length, 3, "it downloads again, as try 3");
  assert.deepEqual(seen.notes, ["no-word", "saving-again", "no-word", "saving-again", "no-word"]);
});

test("a late end after the no-word timeout saves the part and stops a try still running", async () => {
  const d = fakeDownloads();
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  await part.start();   // try 1: no word in time (it is download 7 once started)
  d.start(7);
  await settle();
  d.set(7, "interrupted");
  await part.click();   // Chrome says interrupted: save again (try 2; the click's own
                        // wait for try 2 then adds its no-word note)
  assert.deepEqual(d.searches.slice(-1), [7], "the click asked Chrome about try 1's download");
  assert.deepEqual(seen.notes, ["no-word", "saving-again", "no-word"]);
  d.start(8);           // try 2 is download 8, still going
  await settle();
  assert.deepEqual(d.cancelled, []);
  d.fire(7, "complete");   // try 1's late end: it finished after all
  assert.equal(seen.saved, 1, "the late finish saves the part");
  assert.deepEqual(d.cancelled, [8], "try 2 is stopped: it would only land a second copy");
  d.fire(8, "interrupted");   // try 2 dies of the cancel
  assert.equal(seen.freed, 1, "with no try left reading the blob, the page may revoke the URL");
  assert.deepEqual(seen.notes, ["no-word", "saving-again", "no-word"]);
});

test("a try whose id arrives after another try saved the part is cancelled", async () => {
  const d = fakeDownloads();
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  await part.start();   // try 1: held-up call, no word
  await part.click();   // try 2 begins
  d.start(10, 1);       // try 2 (the second call) gets id 10 and saves
  await settle();
  d.fire(10, "complete");
  assert.equal(seen.saved, 1);
  d.start(11);          // try 1's call lands at last: id 11, after the part was saved
  await settle();
  assert.deepEqual(d.cancelled, [11], "it would only land a second copy");
  assert.equal(seen.saved, 1, "the cancelled try does not save twice");
});

test("a click whose Chrome answer fails says so, and the retry stays with the next click", async () => {
  const d = fakeDownloads();
  const realSearch = d.search;
  d.search = async () => { throw new Error("no"); };
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  const p = part.start();
  d.start(3);
  await settle();
  d.fire(3, "interrupted");
  await p;
  assert.equal(part.result.ok, false);
  await part.click();   // asks Chrome; Chrome can't be asked
  assert.deepEqual(seen.notes, ["didnt-finish", "unavailable"]);
  assert.equal(d.calls.length, 1, "no new download starts on a guess");
  d.search = realSearch;
  d.set(3, "interrupted");
  const again = part.click();   // the affordance remains: a further click tries again
  await settle();               // Chrome answers interrupted: the label goes up, try 2 starts
  assert.deepEqual(seen.notes, ["didnt-finish", "unavailable", "saving-again"]);
  assert.equal(d.calls.length, 2);
  d.start(4);
  await settle();
  d.fire(4, "complete");
  await again;
  assert.equal(seen.saved, 1, "the retried try saves the part");
});

test("a click whose Chrome answer says complete saves the part", async () => {
  // the click can be the one that discovers the save: the start got no word in time and
  // no late word ever comes — the click itself asks Chrome
  const d = fakeDownloads();
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  const p = part.start();
  d.start(3);
  await settle();
  await p;
  assert.deepEqual(seen.notes, ["no-word"]);
  d.set(3, "complete");
  await part.click();   // Chrome says complete: the click saves it and closes the try out
  assert.deepEqual(d.searches.slice(-1), [3], "the click asked Chrome about the tracked download");
  assert.equal(seen.saved, 1);
  assert.equal(part.result.ok, true);
  assert.ok(seen.freed >= 1, "no try left reading the blob: the page may revoke the URL");
  d.fire(3, "interrupted");   // a late word now lands: the label stands, nothing changes
  assert.equal(seen.saved, 1, "saved stays saved");
  assert.deepEqual(seen.notes, ["no-word"]);
});

test("a click whose Chrome answer says still downloading says so", async () => {
  const d = fakeDownloads();
  const { seen, hooks } = partHarness();
  const part = createPartDownload(d, { url: "blob:x", name: "a.zip", index: 1 }, hooks, { timeout: 5 });
  const p = part.start();
  d.start(3);
  await settle();
  await p;
  d.set(3, "in_progress");
  await part.click();   // Chrome says it is still going: say that, start nothing
  assert.deepEqual(seen.notes, ["no-word", "downloading"]);
  assert.equal(d.calls.length, 1);
  d.fire(3, "complete");
  await p;
  assert.equal(seen.saved, 1, "the download finishing on its own still saves the part");
  assert.ok(seen.freed >= 1, "the URL may go once nothing reads it");
});
