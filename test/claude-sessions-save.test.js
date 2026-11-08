// The claude-sessions export page's save seam (src/modules/claude-sessions/save.js):
// the part/marker Blobs, the download, and the revoke discipline, with a stand-in for
// chrome.downloads (the per-file copy of the pattern in test/download.test.js) and an
// object-URL registry so the page-global create/revoke half is observable under node.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createSaves, savePartOrStop } = await import("../src/modules/claude-sessions/save.js");

// node's URL has no object-URL half: a registry stand-in goes on the global once, so the
// tests can watch the factory's create/revoke discipline (revoke is page-global —
// exactly what the pins are about). create issues "blob:test-N" and remembers its blob;
// revoke records the url. Each pin reads urls.created/urls.revoked from its own start.
const urls = { created: [], revoked: [] };
let blobSeq = 0;
URL.createObjectURL = (blob) => { const u = `blob:test-${++blobSeq}`; urls.created.push({ url: u, blob }); return u; };
URL.revokeObjectURL = (u) => urls.revoked.push(u);

// a chrome.downloads stand-in: download() resolves when the test says, with the id the
// test picks; search() reports whatever state the test set; fire() sends an onChanged
// event; refuse() rejects the call outright
function fakeDownloads() {
  const listeners = new Set();
  const states = new Map();
  const answers = [];
  const api = {
    calls: [],
    cancelled: [],
    onChanged: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    download(opts) {
      api.calls.push(opts);
      return new Promise((resolve, reject) => { answers.push({ resolve, reject }); });
    },
    search: async ({ id }) => {
      return states.has(id) ? [{ id, state: states.get(id) }] : [];
    },
    start: (id) => answers.shift().resolve(id),
    refuse: () => answers.shift().reject(new Error("refused")),
    cancel: async (id) => { api.cancelled.push(id); },
    set: (id, state) => states.set(id, state),
    fire: (id, state) => { for (const f of [...listeners]) f({ id, state: { current: state } }); },
  };
  return api;
}

// lets the promise callbacks inside trackDownload run
const settle = () => new Promise((r) => setImmediate(r));

// one harness per pin: a fresh stand-in, the notes note() received, and the factory with
// a 60 s timeout so the in-time pins never race it (the no-word pin passes 5 ms itself).
// The URL registry resets too — tests in a file run sequentially, so each pin reads only
// its own creates and revokes.
const harness = (stillCurrent = () => true, timeout = 60000) => {
  urls.created.length = 0;
  urls.revoked.length = 0;
  const d = fakeDownloads();
  const notes = [];
  const saves = createSaves({ downloads: d, note: (ev) => notes.push(ev), stillCurrent }, { timeout });
  return { d, notes, saves };
};

test("a refused or interrupted save returns false and revokes the blob URL", async () => {
  const { d, notes, saves } = harness();
  const p = saves.savePart(['{"a":1}\n'], "part01.jsonl");
  d.refuse();
  const out = await p;
  assert.equal(out.saved, false);
  assert.equal(out.size, 8, "the size rides back for the page's MB math");
  assert.equal(urls.created.length, 1);
  assert.deepEqual(urls.revoked, [urls.created[0].url], "the false path revokes once the save settles");
  assert.deepEqual(notes, [], "a refused in-time save narrates nothing here — the page throws");

  const e = harness();
  const q = e.saves.savePart(['{"b":2}\n'], "part02.jsonl");
  e.d.start(3);
  await settle();
  e.d.fire(3, "interrupted");
  const out2 = await q;
  assert.equal(out2.saved, false);
  assert.deepEqual(urls.revoked, [urls.created[0].url], "an interrupted in-time save revokes too");
  assert.deepEqual(e.notes, []);
});

test("a completed save returns saved with the blob's size and revokes the URL", async () => {
  const { d, notes, saves } = harness();
  const p = saves.savePart(["x\n"], "part01.jsonl");
  assert.equal(urls.created[0].blob.type, "application/x-ndjson", "the part Blob is ndjson");
  d.start(7);
  await settle();
  d.fire(7, "complete");
  const out = await p;
  assert.equal(out.saved, true);
  assert.equal(out.size, 2);
  assert.deepEqual(urls.revoked, [urls.created[0].url]);
  assert.deepEqual(notes, [], "an in-time end is not narrated through note — the page says Saved itself");
});

test("a no-word save leaves the URL alive; its late end revokes, narrating only a current run", async () => {
  const run = { current: true };
  const { d, notes, saves } = harness(() => run.current, 5);
  const p = saves.savePart(["x\n"], "part01.jsonl");
  d.start(9);
  const out = await p;
  assert.equal(out.saved, null);
  assert.deepEqual(urls.revoked, [], "no word in time: the URL stays alive for the download");
  d.fire(9, "complete");
  assert.deepEqual(urls.revoked, [urls.created[0].url], "the late end frees the URL");
  assert.deepEqual(notes, [{ marker: false, ok: true, name: "part01.jsonl", size: out.size }],
    "a current run's late finish is narrated with the size for the MB line");

  // a run that has lost the line: its late end still revokes, but stays silent
  run.current = false;
  const q = saves.savePart(["y\n"], "part02.jsonl");
  d.start(10);
  await q;
  d.fire(10, "interrupted");
  assert.equal(urls.revoked.length, 2, "a stale run's late end still revokes");
  assert.equal(notes.length, 1, "a stale run's late end narrates nothing");
});

test("saveMarker stringifies the payload with a trailing newline, same revoke discipline", async () => {
  const { d, notes, saves } = harness();
  const p = saves.saveMarker({ parts: 1 }, "claude-sessions-R-done.json");
  assert.equal(urls.created[0].blob.type, "application/json", "the marker Blob is json");
  d.start(3);
  await settle();
  d.fire(3, "complete");
  const out = await p;
  assert.equal(out.saved, true);
  assert.equal(await urls.created[0].blob.text(), JSON.stringify({ parts: 1 }) + "\n");
  assert.deepEqual(urls.revoked, [urls.created[0].url]);

  // the marker's no-word path: the late end narrates the marker line, through note
  const e = harness(() => true, 5);
  const q = e.saves.saveMarker({ parts: 2 }, "done.json");
  e.d.start(4);
  await q;
  e.d.fire(4, "interrupted");
  assert.deepEqual(urls.revoked, [urls.created[0].url]);
  assert.deepEqual(e.notes, [{ marker: true, ok: false, name: "done.json", size: 12 }]);
});

test("saveAs false and conflictAction overwrite ride on both download requests", async () => {
  const { d, saves } = harness();
  const p = saves.savePart(["x\n"], "part01.jsonl");
  d.start(1);
  await settle();
  d.fire(1, "complete");
  await p;
  const q = saves.saveMarker({ parts: 1 }, "done.json");
  d.start(2);
  await settle();
  d.fire(2, "complete");
  await q;
  assert.deepEqual(d.calls, [
    { url: urls.created[0].url, filename: "part01.jsonl", saveAs: false, conflictAction: "overwrite" },
    { url: urls.created[1].url, filename: "done.json", saveAs: false, conflictAction: "overwrite" },
  ]);
});

test("a downloads.download that throws propagates out of the save", async () => {
  // the harness's 60 s timer would hold the process open if the throw left it live
  // (lib/download.js clears it on this path; test/download.test.js pins that)
  const { d, saves } = harness();
  d.download = () => { throw new Error("refused"); };
  await assert.rejects(saves.savePart(["x\n"], "part01.jsonl"), /refused/);
  await assert.rejects(saves.saveMarker({ parts: 1 }, "done.json"), /refused/);
});

test("a sync-throwing download revokes the blob URL once, rejection untouched, and nothing narrates", async () => {
  // the throw rejects trackDownload's promise with its timer and listener already
  // dropped, so onLate never fires: the factory's own revoke is the only one. (This pins
  // the factory's side; the timer and listener release is test/download.test.js's pin.)
  const { d, notes, saves } = harness(() => true, 5);
  d.download = () => { throw new Error("refused"); };
  await assert.rejects(saves.savePart(["x\n"], "part01.jsonl"), /refused/);
  await new Promise((r) => setTimeout(r, 20)); // past the 5 ms timeout
  assert.deepEqual(urls.revoked, [urls.created[0].url], "one revoke, from the throw path");
  assert.deepEqual(notes, [], "no late end is narrated for a save that never started");
});

// --- savePartOrStop: the page's onFlush glue (a silent part save stops the run,
// owner-approved)

// a savePart stand-in answering with a fixed result, or throwing
const answering = (out) => async () => out;
const recordStops = () => {
  const stops = [];
  return { stops, onStop: (kind, err) => { stops.push([kind, err]); return `stop:${kind}`; } };
};

test("savePartOrStop returns a saved part's size and never calls onStop", async () => {
  const { stops, onStop } = recordStops();
  assert.equal(await savePartOrStop(answering({ saved: true, size: 42 }), ["x\n"], "p01.jsonl", onStop), 42);
  assert.deepEqual(stops, []);
});

test("savePartOrStop stops a refused part with onStop's message", async () => {
  const { stops, onStop } = recordStops();
  await assert.rejects(savePartOrStop(answering({ saved: false, size: 1 }), [], "p01.jsonl", onStop),
    (err) => err.message === "stop:refused");
  assert.deepEqual(stops, [["refused", undefined]]);
});

test("savePartOrStop stops a silent part with onStop's message", async () => {
  const { stops, onStop } = recordStops();
  await assert.rejects(savePartOrStop(answering({ saved: null, size: 1 }), [], "p01.jsonl", onStop),
    (err) => err.message === "stop:silent");
  assert.deepEqual(stops, [["silent", undefined]]);
});

test("savePartOrStop converts a thrown save into a stop that hands onStop the throw", async () => {
  const { stops, onStop } = recordStops();
  const boom = new Error("Invalid filename");
  await assert.rejects(savePartOrStop(async () => { throw boom; }, [], "p01.jsonl", onStop),
    (err) => err.message === "stop:error");
  assert.equal(stops.length, 1);
  assert.equal(stops[0][0], "error");
  assert.equal(stops[0][1], boom, "onStop sees the original throw, to name it");
});

test("savePartOrStop passes the part's lines and name to the save and nothing of them to onStop", async () => {
  const seen = [];
  const lines = ["a\n", "b\n"];
  const { stops, onStop } = recordStops();
  await assert.rejects(savePartOrStop(async (l, n) => { seen.push([l, n]); return { saved: null }; }, lines, "p02.jsonl", onStop));
  assert.deepEqual(seen, [[lines, "p02.jsonl"]]);
  assert.equal(stops[0].length, 2, "onStop's arguments are the kind and the throw only");
});
