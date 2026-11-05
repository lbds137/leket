// src/modules/reddit/offscreen.js against a chrome stub that has NO downloads key:
// chrome.runtime is the only extension API an offscreen document gets, so the whole
// document path (listen, prepare, answer; revoke) must work without ever touching
// chrome.downloads — that split is what keeps the save working at all. fetch is
// stubbed per test; the file-level check pins the split structurally too.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { postPage } from "./fixtures/reddit.js";

let onMessageListener = null;
let fetchCalls = [];

const okBody = JSON.stringify(postPage());
let fetchBody = okBody;

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    onMessage: { addListener: (fn) => { onMessageListener = fn; } },
  },
  // deliberately no chrome.downloads here: the document must never reach for it
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return { ok: true, status: 200, text: async () => fetchBody };
};

await import("../src/modules/reddit/offscreen.js");

const handled = (msg, sender = { id: "test-extension-id" }) =>
  new Promise((resolve) => {
    const keepOpen = onMessageListener(msg, sender, resolve);
    if (!keepOpen) resolve(undefined);
  });

after(() => { globalThis.fetch = realFetch; });

test("a save run prepares and answers with both blobs and both names, no downloads involved", async () => {
  fetchCalls = [];
  const reply = await handled({ type: "discord-tools:reddit-save-run", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok, `expected a prepared save, got ${JSON.stringify(reply)}`);
  assert.equal(reply.name, "reddit-abc123.json");
  assert.match(reply.url, /^blob:/);
  assert.equal(reply.mdName, "reddit-abc123.md");
  assert.match(reply.mdUrl, /^blob:/);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].opts.credentials, "include");
});

test("a refused save run answers with the error text", async () => {
  fetchBody = "<html>login wall</html>";
  const reply = await handled({ type: "discord-tools:reddit-save-run", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok === false, `expected a refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /answered with a page/);
  fetchBody = okBody;
});

test("a revoke frees the blob url it names", async () => {
  const revoked = [];
  const realRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => { revoked.push(u); return realRevoke(u); };
  try {
    const reply = await handled({ type: "discord-tools:reddit-save-revoke", url: "blob:nodedata:one" });
    assert.deepEqual(reply, { ok: true });
  } finally {
    URL.revokeObjectURL = realRevoke;
  }
  assert.deepEqual(revoked, ["blob:nodedata:one"]);
});

test("a message from a content-script relay (sender.tab) is declined", async () => {
  fetchCalls = [];
  const reply = await handled(
    { type: "discord-tools:reddit-save-run", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" },
    { id: "test-extension-id", tab: { id: 7 } },
  );
  assert.equal(reply, undefined, "the document must not answer a relayed message");
  assert.equal(fetchCalls.length, 0);
});

test("the offscreen-side files never reference chrome.downloads", async () => {
  for (const f of ["src/modules/reddit/offscreen.js", "src/modules/reddit/prepare.js", "src/modules/reddit/md.js"]) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!src.includes("chrome.downloads"), `${f} references chrome.downloads — the document does not have it`);
  }
});
