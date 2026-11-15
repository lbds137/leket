// src/modules/messenger/bridge.js with stand-ins for the page window and chrome.runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../src/modules/messenger/bridge.js", import.meta.url), "utf8");

// readyAnswer: what the worker answers leket:ready with ("throw" = the extension is gone)
function page({ readyAnswer = { ok: true }, orphaned = false } = {}) {
  const listeners = [], acks = [];
  let onMessage;
  const ready = [];
  const clock = { t: 1_000_000 };
  const answer = { now: readyAnswer };
  const sandbox = {
    Date: { now: () => clock.t },
    location: { origin: "https://www.messenger.com" },
    document: { documentElement: { dataset: {} } },
    crypto: { randomUUID: (() => { let n = 0; return () => `k${++n}`; })() },
    addEventListener: (type, f) => listeners.push(f),
    postMessage: (data) => acks.push(data),
    chrome: {
      runtime: {
        get id() { return orphaned ? undefined : "ext"; },
        onMessage: { addListener: (f) => { onMessage = f; } },
        sendMessage: async (m) => {
          ready.push(m);
          if (answer.now === "throw") throw new Error("Extension context invalidated");
          return answer.now;
        },
      },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const win = vm.runInContext("window", sandbox);
  return {
    sandbox,
    acks,
    clock,
    answer,
    ready: () => ready,
    post: async (data, { origin = "https://www.messenger.com", source = win } = {}) => {
      for (const f of listeners) await f({ source, origin, data });
    },
    ask: (msg, sender = { id: "ext" }) => new Promise((r) => {
      // a listener that returns without replying leaves the asker with nothing
      if (onMessage(msg, sender, r) !== true) setTimeout(() => r(undefined), 0);
    }),
  };
}

const save = (id, extra = {}) => ({
  type: "leket:messenger-export",
  id,
  file: `messenger-${id}-1.json`,
  json: JSON.stringify({ id }),
  files: [{ name: `${id}.jpg`, blob: new Blob([id]) }],
  ...extra,
});
const plain = (x) => JSON.parse(JSON.stringify(x));

test("a post with JSON and two Blobs gives one leket:ready, chunk 0 returns the JSON, and leket:file reassembles a 7 MiB Blob across two 6 MiB offsets", async () => {
  const p = page();
  assert.equal(p.sandbox.document.documentElement.dataset.leketMessengerBridge, "1");

  const size = 7 * 1024 * 1024;
  const raw = new Uint8Array(size);
  for (let i = 0; i < size; i++) raw[i] = (i * 31 + 17) & 0xff;
  const blob1 = new Blob([raw], { type: "video/mp4" });
  const smallRaw = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const blob2 = new Blob([smallRaw], { type: "image/jpeg" });

  const json = JSON.stringify({ leket: "messenger", version: 1, count: 1, messages: [{ id: "m1" }] });
  await p.post({
    type: "leket:messenger-export",
    id: "s1",
    file: "messenger-thread-123.json",
    json,
    files: [
      { name: "2026-11-15_m1_1.mp4", blob: blob1 },
      { name: "2026-11-15_m1_2.jpg", blob: blob2 },
    ],
  });

  assert.equal(p.ready().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(p.acks)), [{ type: "leket:ack", id: "s1", ok: true }]);
  const key = p.ready()[0].key;

  const chunk0 = await p.ask({ type: "leket:chunk", key, index: 0 });
  assert.equal(chunk0.total, 1);
  assert.equal(chunk0.file, "messenger-thread-123.json");
  assert.equal(chunk0.files, 2);
  assert.equal(chunk0.chunk, json);

  const step = 6 * 1024 * 1024;
  const slice0 = await p.ask({ type: "leket:file", key, index: 0, offset: 0 });
  assert.equal(slice0.name, "2026-11-15_m1_1.mp4");
  assert.equal(slice0.size, size);
  const bytes0 = Buffer.from(slice0.data, "base64");
  assert.equal(bytes0.length, step);

  const slice1 = await p.ask({ type: "leket:file", key, index: 0, offset: step });
  assert.equal(slice1.name, "2026-11-15_m1_1.mp4");
  assert.equal(slice1.size, size);
  const bytes1 = Buffer.from(slice1.data, "base64");
  assert.equal(bytes1.length, size - step);

  const reassembled = Buffer.concat([bytes0, bytes1]);
  assert.equal(Buffer.compare(reassembled, Buffer.from(raw.buffer)), 0, "7 MiB Blob reassembles byte-exactly");

  const secondFile = await p.ask({ type: "leket:file", key, index: 1, offset: 0 });
  assert.equal(secondFile.name, "2026-11-15_m1_2.jpg");
  assert.equal(secondFile.size, smallRaw.length);
  assert.deepEqual([...Buffer.from(secondFile.data, "base64")], [...smallRaw]);
});

test("a second accepted post drops the first save, saying gone; a released save is gone", async () => {
  const p = page();
  await p.post(save("a"));
  p.clock.t += 10_000;
  await p.post(save("b"));
  const [k1, k2] = p.ready().map((m) => m.key);
  assert.deepEqual(plain(await p.ask({ type: "leket:chunk", key: k1, index: 0 })).gone, true);
  const fileGone = await p.ask({ type: "leket:file", key: k1, index: 0, offset: 0 });
  assert.match(fileGone.error, /gone/);
  assert.equal(fileGone.gone, true);
  assert.equal((await p.ask({ type: "leket:chunk", key: k2, index: 0 })).chunk, '{"id":"b"}');
  await p.ask({ type: "leket:release", key: k2 });
  assert.match((await p.ask({ type: "leket:chunk", key: k2, index: 0 })).error, /gone/);
});

for (const [label, refusal] of [["answers {ok:false}", { ok: false }], ["throws", "throw"]]) {
  test(`a post whose leket:ready ${label} is dropped and acked false, and the older save stays readable`, async () => {
    const p = page();
    await p.post(save("a"));
    p.clock.t += 10_000;
    p.answer.now = refusal;
    await p.post(save("b"));
    const [k1, k2] = p.ready().map((m) => m.key);
    assert.deepEqual(plain(p.acks), [
      { type: "leket:ack", id: "a", ok: true },
      { type: "leket:ack", id: "b", ok: false },
    ]);
    assert.equal((await p.ask({ type: "leket:chunk", key: k1, index: 0 })).chunk, '{"id":"a"}');
    assert.equal((await p.ask({ type: "leket:chunk", key: k2, index: 0 })).gone, true);
  });
}

// two handoffs in flight at once (a slow worker past the 10 s throttle), finishing in
// either order: the newer save is always the one left readable
for (const order of ["older first", "newer first"]) {
  test(`overlapping handoffs answering ${order} leave the newer save readable`, async () => {
    const p = page();
    const releases = {};
    const tick = () => new Promise((r) => setTimeout(r, 0));
    p.answer.now = new Promise((r) => { releases.a = r; });
    const postA = p.post(save("a"));
    await tick();
    p.clock.t += 10_000;
    p.answer.now = new Promise((r) => { releases.b = r; });
    const postB = p.post(save("b"));
    await tick();
    const [first, second] = order === "older first" ? ["a", "b"] : ["b", "a"];
    releases[first]({ ok: true });
    await tick();
    releases[second]({ ok: true });
    await Promise.all([postA, postB]);
    const [k1, k2] = p.ready().map((m) => m.key);
    assert.equal((await p.ask({ type: "leket:chunk", key: k2, index: 0 })).chunk, '{"id":"b"}');
    assert.equal((await p.ask({ type: "leket:chunk", key: k1, index: 0 })).gone, true);
    const acks = Object.fromEntries(plain(p.acks).map((a) => [a.id, a.ok]));
    assert.deepEqual(acks, { a: order === "older first", b: true }, "an ack says ok only if its save was still readable");
  });
}

test("a second post within 10 s is refused as too soon and opens nothing; after 10 s one is accepted", async () => {
  const p = page();
  await p.post(save("a"));
  p.clock.t += 9_999;
  await p.post(save("b"));
  assert.equal(p.ready().length, 1);
  assert.deepEqual(plain(p.acks)[1], { type: "leket:ack", id: "b", ok: false, reason: "too-soon" });
  p.clock.t += 1;
  await p.post(save("c"));
  assert.equal(p.ready().length, 2);
  assert.deepEqual(plain(p.acks)[2], { type: "leket:ack", id: "c", ok: true });
});

test("a post from another origin, or from another window, is ignored", async () => {
  const p = page();
  await p.post(save("x"), { origin: "https://evil.example" });
  await p.post(save("y"), { source: {} });
  assert.deepEqual([p.acks.length, p.ready().length], [0, 0]);
});

test("a request from another extension gets no answer", async () => {
  const p = page();
  await p.post(save("a"));
  const key = p.ready()[0].key;
  assert.equal(await p.ask({ type: "leket:chunk", key, index: 0 }, { id: "other-extension" }), undefined);
  assert.equal(await p.ask({ type: "leket:release", key }, { id: "other-extension" }), undefined);
  assert.equal((await p.ask({ type: "leket:chunk", key, index: 0 })).chunk, '{"id":"a"}', "a foreign release frees nothing");
});

test("the JSON is never cut inside a surrogate pair at the 8 MiB boundary", async () => {
  const p = page();
  const CHUNK = 8 * 1024 * 1024;
  // the pair's high half sits at index CHUNK - 1, the last place chunk 0 could end
  const json = `"${"a".repeat(CHUNK - 2)}\u{1F600}${"b".repeat(10)}"`;
  assert.equal(json.charCodeAt(CHUNK - 1), 0xd83d);
  await p.post(save("s", { json }));
  const key = p.ready()[0].key;
  const c0 = await p.ask({ type: "leket:chunk", key, index: 0 });
  assert.equal(c0.total, 2);
  assert.equal(c0.chunk.length, CHUNK - 1, "chunk 0 stops before the high surrogate");
  const c1 = await p.ask({ type: "leket:chunk", key, index: 1 });
  assert.equal(c1.chunk.codePointAt(0), 0x1f600);
  assert.equal(c0.chunk + c1.chunk, json);
});

test("bad piece, file and offset requests get an error, not a slice", async () => {
  const p = page();
  await p.post(save("a", { files: [{ name: "a.jpg", blob: new Blob(["abcd"]) }] }));
  const key = p.ready()[0].key;
  for (const index of [-1, 1, 0.5, "0", "length", null]) {
    assert.match((await p.ask({ type: "leket:chunk", key, index })).error, /no piece/, `chunk ${index}`);
  }
  for (const index of [-1, 1, 0.5, "0", "length", "__proto__", null]) {
    assert.match((await p.ask({ type: "leket:file", key, index, offset: 0 })).error, /no file/, `file ${index}`);
  }
  for (const offset of [-1, 4, 5, 1.5, "0", undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match((await p.ask({ type: "leket:file", key, index: 0, offset })).error, /no offset/, `offset ${offset}`);
  }
  const ok = await p.ask({ type: "leket:file", key, index: 0, offset: 3 });
  assert.equal(Buffer.from(ok.data, "base64").toString(), "d");
});
