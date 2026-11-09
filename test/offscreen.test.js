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
  const reply = await handled({ type: "leket:reddit-save-run", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
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
  const reply = await handled({ type: "leket:reddit-save-run", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok === false, `expected a refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /answered with a page/);
  fetchBody = okBody;
});

test("a revoke frees the blob url it names", async () => {
  const revoked = [];
  const realRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => { revoked.push(u); return realRevoke(u); };
  try {
    const reply = await handled({ type: "leket:reddit-save-revoke", url: "blob:nodedata:one" });
    assert.deepEqual(reply, { ok: true });
  } finally {
    URL.revokeObjectURL = realRevoke;
  }
  assert.deepEqual(revoked, ["blob:nodedata:one"]);
});

test("a message from a content-script relay (sender.tab) is declined", async () => {
  fetchCalls = [];
  const reply = await handled(
    { type: "leket:reddit-save-run", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" },
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

test("image, md and done handlers: token lookup, saved-name filter, folderRel check, token cleanup and sender refusal", async () => {
  const galleryPost = postPage({
    is_gallery: true,
    is_self: false,
    gallery_data: { items: [{ media_id: "a" }, { media_id: "b" }] },
    media_metadata: {
      a: { status: "valid", m: "image/png", s: { u: "https://i.redd.it/one.png" } },
      b: { status: "valid", m: "image/jpeg", s: { u: "https://preview.redd.it/two.jpg" } },
    },
  });
  fetchBody = JSON.stringify(galleryPost);
  const run = await handled({ type: "leket:reddit-save-run", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  fetchBody = okBody;
  assert.equal(run.ok, true);
  assert.equal(typeof run.token, "string");
  assert.equal(run.id, "abc123");
  assert.deepEqual(run.images, [
    { n: 1, u: "https://i.redd.it/one.png", ext: ".png" },
    { n: 2, u: "https://preview.redd.it/two.jpg", ext: ".jpg" },
  ]);

  // sender refusal on all three new handlers (sender.tab and foreign sender.id)
  for (const badSender of [{ id: "test-extension-id", tab: { id: 1 } }, { id: "foreign-extension" }]) {
    for (const msg of [
      { type: "leket:reddit-save-image", token: run.token, n: 1 },
      { type: "leket:reddit-save-md", token: run.token, saved: { 1: "01.png" }, folderRel: "reddit-abc123-images" },
      { type: "leket:reddit-save-done", token: run.token },
    ]) {
      assert.equal(await handled(msg, badSender), undefined);
    }
  }

  // unknown token or unknown n on image and md handlers
  assert.deepEqual(await handled({ type: "leket:reddit-save-image", token: "no-such-token", n: 1 }),
    { ok: false, error: "that save is over" });
  assert.deepEqual(await handled({ type: "leket:reddit-save-image", token: run.token, n: 99 }),
    { ok: false, error: "that save is over" });
  assert.deepEqual(await handled({ type: "leket:reddit-save-md", token: "no-such-token", saved: { 1: "01.png" }, folderRel: "reddit-abc123-images" }),
    { ok: false, error: "that save is over" });

  // leket:reddit-save-image success and failure
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (url === "https://i.redd.it/one.png") {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array([1, 2]) })),
              cancel: async () => {},
            };
          },
        },
      };
    }
    return { ok: true, status: 200, headers: { get: () => "text/html" } };
  };
  try {
    const imgOk = await handled({ type: "leket:reddit-save-image", token: run.token, n: 1 });
    assert.equal(imgOk.ok, true);
    assert.equal(imgOk.name, "01.png");
    assert.match(imgOk.url, /^blob:/);

    const imgFail = await handled({ type: "leket:reddit-save-image", token: run.token, n: 2 });
    assert.deepEqual(imgFail, { ok: false, error: "the server sent text/html, not an image" });
  } finally {
    globalThis.fetch = prevFetch;
  }

  // folderRel check on leket:reddit-save-md
  for (const badFolder of ["wrong-images", "reddit-other-images", "../reddit-abc123-images", ""]) {
    const bad = await handled({ type: "leket:reddit-save-md", token: run.token, saved: { 1: "01.png" }, folderRel: badFolder });
    assert.equal(bad.ok, false, `expected refusal for folderRel=${badFolder}`);
  }

  // saved-name filter on leket:reddit-save-md: keeps valid row 1, drops invalid row 2 and unknown row 3
  const realCreate = URL.createObjectURL;
  const blobs = [];
  URL.createObjectURL = (b) => { blobs.push(b); return realCreate(b); };
  let mdReply;
  try {
    mdReply = await handled({
      type: "leket:reddit-save-md",
      token: run.token,
      saved: { 1: "01.png", 2: "../02.jpg", 3: "03.png" },
      folderRel: "reddit-abc123-images",
    });
    // also check single-digit and non-image extension are filtered out
    await handled({
      type: "leket:reddit-save-md",
      token: run.token,
      saved: { 1: "1.png", 2: "02.svg" },
      folderRel: "reddit-abc123-images",
    });
  } finally {
    URL.createObjectURL = realCreate;
  }
  assert.equal(mdReply.ok, true);
  assert.equal(mdReply.mdName, "reddit-abc123.md");
  assert.match(mdReply.mdUrl, /^blob:/);
  const mdText = await blobs[0].text();
  assert.ok(mdText.includes("![image 1](<reddit-abc123-images/01.png>)"), mdText);
  assert.ok(mdText.includes("Image 1 source: https://i.redd.it/one.png"), mdText);
  assert.ok(mdText.includes("![image 2](<https://preview.redd.it/two.jpg>)"), "rejected saved[2] falls back to remote URL");
  const mdTextAllRejected = await blobs[1].text();
  assert.ok(mdTextAllRejected.includes("![image 1](<https://i.redd.it/one.png>)"), mdTextAllRejected);
  assert.ok(mdTextAllRejected.includes("![image 2](<https://preview.redd.it/two.jpg>)"), mdTextAllRejected);

  // leket:reddit-save-done deletes the token
  assert.deepEqual(await handled({ type: "leket:reddit-save-done", token: run.token }), { ok: true });
  assert.deepEqual(await handled({ type: "leket:reddit-save-image", token: run.token, n: 1 }),
    { ok: false, error: "that save is over" });
  assert.deepEqual(await handled({ type: "leket:reddit-save-md", token: run.token, saved: { 1: "01.png" }, folderRel: "reddit-abc123-images" }),
    { ok: false, error: "that save is over" });
});
