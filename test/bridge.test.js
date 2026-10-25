// src/bridge.js with stand-ins for the page window and chrome.runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");

function page({ sendFails = false } = {}) {
  const listeners = [], acks = [];
  let onMessage, ready = [];
  const sandbox = {
    location: { origin: "https://discord.com" },
    document: { documentElement: { dataset: {} } },
    crypto: { randomUUID: (() => { let n = 0; return () => `k${++n}`; })() },
    addEventListener: (type, f) => listeners.push(f),
    postMessage: (data) => acks.push(data),
    chrome: { runtime: { id: "ext", onMessage: { addListener: (f) => { onMessage = f; } },
      sendMessage: async (m) => { if (sendFails) throw new Error("Extension context invalidated"); ready.push(m); return { ok: true }; } } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const win = vm.runInContext("window", sandbox);
  return {
    sandbox, acks, ready: () => ready,
    post: async (data) => { for (const f of listeners) await f({ source: win, origin: "https://discord.com", data }); },
    ask: (msg) => new Promise((r) => onMessage(msg, { id: "ext" }, r)),
  };
}

test("the save comes back whole in pieces, never splitting an emoji", async () => {
  const p = page();
  assert.equal(p.sandbox.document.documentElement.dataset.discordToolsBridge, "1");
  const CHUNK = 8 * 1024 * 1024;
  // the emoji's two halves straddle the first piece boundary
  const json = "a".repeat(CHUNK - 1) + "😀" + "b".repeat(10);
  await p.post({ type: "discord-tools:export", id: "s1", file: "discord-x-1.json", json, attachments: true });
  assert.deepEqual(JSON.parse(JSON.stringify(p.acks)), [{ type: "discord-tools:ack", id: "s1", ok: true }]);
  const key = p.ready()[0].key;
  const first = await p.ask({ type: "discord-tools:chunk", key, index: 0 });
  assert.equal(first.total, 2);
  const second = await p.ask({ type: "discord-tools:chunk", key, index: 1 });
  assert.ok(second.chunk.startsWith("😀"));
  assert.equal(first.chunk + second.chunk, json);
  assert.match((await p.ask({ type: "discord-tools:chunk", key, index: 2 })).error, /no piece 2/);
});

test("a second save leaves the first readable; a released one is gone", async () => {
  const p = page();
  await p.post({ type: "discord-tools:export", id: "a", file: "discord-a-1.json", json: "{}" });
  await p.post({ type: "discord-tools:export", id: "b", file: "discord-b-1.json", json: "[]" });
  const [k1, k2] = p.ready().map((m) => m.key);
  assert.equal((await p.ask({ type: "discord-tools:chunk", key: k1, index: 0 })).chunk, "{}");
  await p.ask({ type: "discord-tools:release", key: k1 });
  assert.match((await p.ask({ type: "discord-tools:chunk", key: k1, index: 0 })).error, /gone/);
  assert.equal((await p.ask({ type: "discord-tools:chunk", key: k2, index: 0 })).chunk, "[]");
});

test("when the extension can't be reached, the collector is told so", async () => {
  const p = page({ sendFails: true });
  await p.post({ type: "discord-tools:export", id: "z", file: "discord-z-1.json", json: "{}" });
  assert.deepEqual(JSON.parse(JSON.stringify(p.acks)), [{ type: "discord-tools:ack", id: "z", ok: false }]);
});
