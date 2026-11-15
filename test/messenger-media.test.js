// src/modules/messenger/media.js: the export tab's media listing, per-file read and
// settling, run against a stub bridge (synthetic data only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { crc32 } from "../src/lib/zip.js";
import { listMedia, readMediaFile, settleMedia, foldName } from "../src/modules/messenger/media.js";

const sandbox = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL("../src/modules/messenger/read.js", import.meta.url), "utf8"), sandbox);
const { validMediaName } = sandbox.module.exports;

const STEP = 6 * 1024 * 1024;

// a stub of the bridge's leket:file answers for one list of files; `fail(index, offset)`
// may return a reply (or "throw") to stand in for the real one
function bridge(files, fail = () => null) {
  const calls = [];
  const ask = async (msg) => {
    calls.push([msg.index, msg.offset]);
    const f = fail(msg.index, msg.offset);
    if (f === "throw") throw new Error("Could not establish connection. Receiving end does not exist.");
    if (f) return f;
    const entry = files[msg.index];
    if (!entry) return { error: `no file ${msg.index}` };
    const slice = entry.bytes.subarray(msg.offset, msg.offset + STEP);
    return { name: entry.name, size: entry.bytes.length, data: Buffer.from(slice).toString("base64") };
  };
  return { ask, calls };
}

const bytes = (n, seed = 7) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const accept = (...names) => (name) => names.includes(name);

test("a file over 6 MiB is read in three slices into a Blob whose running crc32 is the whole file's", async () => {
  const raw = bytes(2 * STEP + 123);
  const b = bridge([{ name: "v.mp4", bytes: raw }]);
  const got = await readMediaFile(b.ask, 0, accept("v.mp4"));
  assert.equal(got.status, "saved");
  assert.deepEqual(b.calls, [[0, 0], [0, STEP], [0, 2 * STEP]]);
  assert.ok(got.data instanceof Blob);
  const back = new Uint8Array(await got.data.arrayBuffer());
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(raw)), 0);
  assert.equal(got.crc, crc32(raw));
});

test("a file of one slice comes back as its bytes, the crc left to the zip writer", async () => {
  const raw = bytes(10);
  const got = await readMediaFile(bridge([{ name: "p.jpg", bytes: raw }]).ask, 0, accept("p.jpg"));
  assert.equal(got.status, "saved");
  assert.ok(got.data instanceof Uint8Array);
  assert.deepEqual([...got.data], [...raw]);
  assert.equal(got.crc, undefined);
});

test("a read that fails after slice 0 is a failed file with the bridge's reason, holding no bytes", async () => {
  const b = bridge([{ name: "v.mp4", bytes: bytes(STEP + 5) }], (i, off) => (off > 0 ? { error: "NotReadableError: blob gone" } : null));
  const got = await readMediaFile(b.ask, 0, accept("v.mp4"));
  assert.deepEqual(got, { status: "failed", name: "v.mp4", reason: "NotReadableError: blob gone" });
});

test("a slice that comes back empty, or names another file, fails the file instead of looping", async () => {
  const empty = await readMediaFile(
    bridge([{ name: "v.mp4", bytes: bytes(STEP + 5) }], (i, off) => (off > 0 ? { name: "v.mp4", size: STEP + 5, data: "" } : null)).ask,
    0, accept("v.mp4"));
  assert.equal(empty.status, "failed");
  assert.match(empty.reason, /0 bytes at offset/);
  const swapped = await readMediaFile(
    bridge([{ name: "v.mp4", bytes: bytes(STEP + 5) }], (i, off) => (off > 0 ? { name: "w.mp4", size: STEP + 5, data: "AA==" } : null)).ask,
    0, accept("v.mp4"));
  assert.equal(swapped.status, "failed");
  assert.match(swapped.reason, /turned into "w.mp4"/);
});

test("a tab that stops answering is tab-gone, first slice or mid-file", async () => {
  const atStart = await readMediaFile(bridge([], () => "throw").ask, 0, accept());
  assert.equal(atStart.status, "tab-gone");
  assert.equal(atStart.name, null);
  assert.match(atStart.reason, /stopped answering \(Could not establish connection/);
  const mid = await readMediaFile(bridge([{ name: "v.mp4", bytes: bytes(STEP + 1) }], (i, off) => (off > 0 ? "throw" : null)).ask, 0, accept("v.mp4"));
  assert.equal(mid.status, "tab-gone");
  assert.equal(mid.name, "v.mp4");
});

test("a save the bridge no longer holds is gone, first slice or mid-file", async () => {
  const gone = { error: "This save is gone", gone: true };
  assert.deepEqual(await readMediaFile(bridge([], () => gone).ask, 0, accept()), { status: "gone", reason: "This save is gone" });
  const mid = await readMediaFile(bridge([{ name: "v.mp4", bytes: bytes(STEP + 1) }], (i, off) => (off > 0 ? gone : null)).ask, 0, accept("v.mp4"));
  assert.equal(mid.status, "gone");
});

test("an unlisted name, an error before naming, or more bytes than the size are refused", async () => {
  const unlisted = await readMediaFile(bridge([{ name: "x.jpg", bytes: bytes(3) }]).ask, 0, accept("p.jpg"));
  assert.equal(unlisted.status, "error");
  assert.match(unlisted.reason, /media file 1: "x.jpg" is not in the save's list/);
  const early = await readMediaFile(bridge([]).ask, 4, accept());
  assert.deepEqual(early, { status: "error", reason: "media file 5: no file 4" });
  const big = await readMediaFile(bridge([], () => ({ name: "p.jpg", size: 2, data: "AAAA" })).ask, 0, accept("p.jpg"));
  assert.equal(big.status, "failed");
  assert.match(big.reason, /more than its 2 bytes/);
});

test("listMedia keeps the first entry per name, case folded, and reports the rest on their own message", () => {
  const exp = {
    messages: [
      { id: "m1", media: [{ kind: "photo", file: "a.jpg" }, { kind: "video", file: "../x.mp4" }] },
      { id: "m2", media: [{ kind: "photo", file: "A.JPG" }, { kind: "photo", file: ".hidden" }, null] },
      { id: "m3" },
      null,
    ],
  };
  const { listed, notCaptured } = listMedia(exp, validMediaName);
  assert.deepEqual([...listed.keys()], ["a.jpg"]);
  assert.equal(listed.get("a.jpg").name, "a.jpg");
  assert.deepEqual(notCaptured.map((n) => [n.message_id, n.kind]), [["m1", "video"], ["m2", "photo"], ["m2", "photo"], ["m2", "photo"]]);
  assert.match(notCaptured[1].reason, /repeated media file name "A.JPG"/);
  assert.deepEqual(exp.messages[2].media, [], "a message with no media list gets an empty one");
});

test("settleMedia keeps only the listed entry the zip holds: a repeated name's other entry goes, reported once", () => {
  const first = { kind: "photo", file: "a.jpg" };
  const repeat = { kind: "photo", file: "a.jpg" };
  const lost = { kind: "video", file: "b.mp4" };
  const exp = { messages: [{ id: "m1", media: [first, lost] }, { id: "m2", media: [repeat] }] };
  const { listed, notCaptured } = listMedia(exp, validMediaName);
  const saved = new Set([foldName("a.jpg")]);
  const whyNot = new Map([["b.mp4", "stopped at 6 of 9 bytes"]]);
  settleMedia(exp, listed, saved, whyNot, notCaptured);
  assert.deepEqual(exp.messages[0].media, [first]);
  assert.deepEqual(exp.messages[1].media, [], "the repeat links nothing, so no file is both linked and missing");
  assert.deepEqual(exp.media_not_captured.map((n) => [n.message_id, n.kind, n.reason.slice(0, 18)]), [
    ["m2", "photo", "invalid or repeate"],
    ["m1", "video", "stopped at 6 of 9 "],
  ]);
});

test("settleMedia gives every unread file the stop reason when the tab went away", () => {
  const exp = { messages: [{ id: "m1", media: [{ kind: "photo", file: "a.jpg" }, { kind: "photo", file: "b.jpg" }] }] };
  const { listed, notCaptured } = listMedia(exp, validMediaName);
  settleMedia(exp, listed, new Set(["a.jpg"]), new Map(), notCaptured, "the Messenger tab stopped answering (closed)");
  assert.deepEqual(exp.media_not_captured, [{ message_id: "m1", kind: "photo", reason: "the Messenger tab stopped answering (closed)" }]);
  assert.deepEqual(exp.messages[0].media.map((m) => m.file), ["a.jpg"]);
});

test("an empty first slice of a non-empty file, bad base64, or a size that is no number fails by name in one call", async () => {
  for (const [reply, why] of [
    [{ name: "p.jpg", size: 5, data: "" }, /returned 0 bytes at offset 0 of 5/],
    [{ name: "p.jpg", size: 5, data: "!!not base64!!" }, /sent bad base64 at offset 0/],
    [{ name: "p.jpg", size: "5", data: "AAAA" }, /no usable size/],
    [{ name: "p.jpg", size: null, data: "" }, /no usable size/],
  ]) {
    const b = bridge([], () => reply);
    const got = await readMediaFile(b.ask, 0, accept("p.jpg"));
    assert.equal(got.status, "failed", JSON.stringify(reply));
    assert.equal(got.name, "p.jpg");
    assert.match(got.reason, why);
    assert.equal(b.calls.length, 1, "no second request");
  }
  const zero = await readMediaFile(bridge([], () => ({ name: "e.jpg", size: 0, data: "" })).ask, 0, accept("e.jpg"));
  assert.equal(zero.status, "saved", "a genuinely empty file is saved empty");
});
