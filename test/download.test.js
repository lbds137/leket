// src/lib/download.js: one download followed until it ends, with a stand-in for
// chrome.downloads that the test drives by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadState, trackDownload } from "../src/lib/download.js";

// a chrome.downloads stand-in: download() resolves when the test says, with the id the test
// picks; search() reports whatever state the test set; fire() sends an onChanged event
function fakeDownloads() {
  const listeners = new Set();
  const states = new Map();
  let answer;
  const api = {
    calls: [],
    onChanged: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    download(opts) {
      api.calls.push(opts);
      return new Promise((resolve, reject) => { answer = { resolve, reject }; });
    },
    search: async ({ id }) => (states.has(id) ? [{ id, state: states.get(id) }] : []),
    start: (id) => answer.resolve(id),
    refuse: () => answer.reject(new Error("refused")),
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
  assert.equal(await downloadState(broken, 4), null);
});
