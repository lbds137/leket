// The reddit save across its homes: preparePostJson (offscreen document: fetch,
// validate, render to Markdown, two blobs) against stubbed fetch; downloadPrepared
// (worker: chrome.downloads, one file after the other) against a stubbed downloads
// API; the popup command and the worker relay against a stubbed chrome. The console
// script dev-docs/browser/reddit-json.js is the spec the prepare half ports: one fetch
// of the post's .json with the browser's own login riding along, saved as
// reddit-<id>.json with reddit-<id>.md beside it — and the script's old.reddit advice
// stays advice in the error text, never an auto-retry.
import { test } from "node:test";
import assert from "node:assert/strict";

import { postPage } from "./fixtures/reddit.js";

// --- the chrome stub. downloads lives HERE (the worker's), never in the offscreen
// --- document: chrome.runtime is the only extension API an offscreen document gets.
const workerDownloads = {
  endState: "complete",
  calls: [],
  listener: null,
  download: async (opts) => {
    workerDownloads.calls.push(opts);
    return workerDownloads.calls.length;
  },
  search: async () => [{ state: workerDownloads.endState }],
  onChanged: {
    addListener: (fn) => { workerDownloads.listener = fn; },
    removeListener: (fn) => { if (workerDownloads.listener === fn) workerDownloads.listener = null; },
  },
};

let onMessageListener = null;
let offscreenHas = false;
const offscreenCreates = [];
const relayedRuns = [];
const revokesSent = [];
let relayReply = null; // what the offscreen page answers the worker's relay with
let relayThrows = null; // or the error the relay rejects with
let workerListening = true;

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    onMessage: { addListener: (fn) => { onMessageListener = fn; } },
    getURL: (p) => `chrome-extension://test-extension-id/${p}`,
    sendMessage: async (msg) => {
      if (msg && msg.type === "discord-tools:reddit-save-run") {
        relayedRuns.push(msg);
        if (relayThrows) throw relayThrows;
        return relayReply;
      }
      if (msg && msg.type === "discord-tools:reddit-save-revoke") {
        revokesSent.push(msg);
        return { ok: true };
      }
      if (workerListening && msg && msg.type === "discord-tools:reddit-save") return handled(msg);
      return undefined;
    },
  },
  offscreen: {
    hasDocument: async () => offscreenHas,
    createDocument: async (o) => { offscreenCreates.push(o); offscreenHas = true; },
  },
  downloads: workerDownloads,
};

await import("../src/background.js");

const handled = (msg, sender = { id: "test-extension-id" }) =>
  new Promise((resolve) => {
    const keepOpen = onMessageListener(msg, sender, resolve);
    if (!keepOpen) resolve(undefined);
  });

const reset = () => {
  offscreenHas = false;
  offscreenCreates.length = 0;
  relayedRuns.length = 0;
  revokesSent.length = 0;
  relayReply = null;
  relayThrows = null;
  workerListening = true;
  workerDownloads.endState = "complete";
  workerDownloads.calls.length = 0;
};

const { commands } = await import("../src/modules/reddit/json.js");
const { preparePostJson } = await import("../src/modules/reddit/prepare.js");
const { downloadPrepared } = await import("../src/modules/reddit/download.js");
const { render } = await import("../src/modules/reddit/md.js");

// a red line under every test: anything that reaches the real network forgot to inject
// its fetch (this file sits behind a stubbed chrome; no test may open a socket)
globalThis.fetch = async () => { throw new Error("no network in tests: inject a fetch stand-in"); };

const okFetch = (body = JSON.stringify(postPage())) => {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, text: async () => body };
    },
  };
};

// --- preparePostJson: the offscreen document's half

test("a post's json is fetched once, from the tab's own origin, with the login riding along", async () => {
  for (const [tabUrl, origin] of [
    ["https://www.reddit.com/r/AskReddit/comments/abc123/whats_the_best_thing/", "https://www.reddit.com"],
    ["https://old.reddit.com/r/AskReddit/comments/abc123/", "https://old.reddit.com"],
    ["https://www.reddit.com/comments/abc123/", "https://www.reddit.com"],
    ["https://www.reddit.com/user/someone/comments/abc123/my_post/", "https://www.reddit.com"],
    ["https://www.reddit.com/u/someone/comments/abc123/my_post/", "https://www.reddit.com"],
    // a subreddit literally named "comments": the extraction must skip past it
    ["https://www.reddit.com/r/comments/comments/abc123/t/", "https://www.reddit.com"],
  ]) {
    const { fetch, calls } = okFetch();
    await preparePostJson(tabUrl, { fetch });
    assert.equal(calls.length, 1, `expected one fetch for ${tabUrl}`);
    assert.equal(calls[0].url, `${origin}/comments/abc123.json?raw_json=1&limit=500`);
    // the whole point of the port: the fetch goes out as the logged-in browser
    assert.equal(calls[0].opts.credentials, "include");
    // a stalled reddit must not park the popup on "Working…" forever
    assert.ok(calls[0].opts.signal instanceof AbortSignal, "the fetch carries an abort timeout");
  }
});

test("a fetch that times out reads as an unreachable reddit", async () => {
  const fetch = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch }),
    /Couldn't reach reddit/,
  );
});

test("a post outside www and old reddit is refused before anything is fetched", async () => {
  const { fetch, calls } = okFetch();
  await assert.rejects(
    preparePostJson("https://example.com/comments/abc123/t/", { fetch }),
    /Not a reddit post page/,
  );
  assert.equal(calls.length, 0, "a lookalike host must not draw a credentialed fetch");
});

test("a large thread prepares fine — the blobs have no URL size cap", async () => {
  const big = JSON.stringify(postPage({ selftext: "x".repeat(3 * 1024 * 1024) }));
  const { fetch } = okFetch(big);
  const prep = await preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch });
  assert.equal(prep.name, "reddit-abc123.json");
  assert.match(prep.url, /^blob:/);
  assert.equal(prep.mdName, "reddit-abc123.md");
  assert.match(prep.mdUrl, /^blob:/);
});

test("the prepared md is exactly render() over the fetched post page", async () => {
  const body = JSON.stringify(postPage({}, [
    { kind: "t1", data: { author: "alice", score: 5, created_utc: 1699000000, body: "first" } },
    { kind: "t1", data: { author: "bob", score: 1, created_utc: 1699000000, body: "second" } },
  ]));
  const { fetch } = okFetch(body);
  const realCreate = URL.createObjectURL;
  const blobs = [];
  URL.createObjectURL = (b) => { blobs.push(b); return realCreate(b); };
  let prep;
  try {
    prep = await preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch });
  } finally {
    URL.createObjectURL = realCreate;
  }
  assert.equal(prep.mdName, "reddit-abc123.md");
  const mdBlob = blobs.find((b) => b && b.type === "text/markdown");
  assert.ok(mdBlob, "a text/markdown blob was created");
  assert.equal(await mdBlob.text(), render(JSON.parse(body)));
});

test("a 200 that parses but isn't a post page refuses the save, in the wrapper's words", async () => {
  const { fetch, calls } = okFetch('{"kind":"Listing"}');
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch }),
    (e) => {
      assert.match(e.message, /isn't this post's data/);
      assert.match(e.message, /old\.reddit\.com\/comments\/abc123/);
      assert.match(e.message, /isn't a reddit post page/);
      return true;
    },
  );
  assert.equal(calls.length, 1, "one fetch, no retry");
});

test("a refused fetch reports reddit's answer with the old.reddit advice, and does not retry", async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); return { ok: false, status: 403, text: async () => "" }; };
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch }),
    /reddit answered 403; try again from old\.reddit\.com\/comments\/abc123/,
  );
  assert.equal(calls.length, 1, "one fetch, no auto-retry: the advice is the user's move");
});

test("a 200 that is a page, not json, is refused", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => "<html>login wall</html>" });
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch }),
    /answered with a page.*old\.reddit\.com\/comments\/abc123/,
  );
});

test("an unreachable reddit says so", async () => {
  const fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch }),
    /Couldn't reach reddit.*Failed to fetch/,
  );
});

test("a fetch whose body read rejects is reported as an unreachable reddit", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => { throw new Error("reset"); } });
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch }),
    /Couldn't reach reddit.*\(reset\)/,
  );
});

test("preparePostJson returns notFetched for the comment tree", async () => {
  const plain = await preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch: okFetch().fetch });
  assert.deepEqual(plain.notFetched, { count: 0, atLeast: false });
  const withMore = okFetch(JSON.stringify(postPage({}, [
    { kind: "more", data: { count: 4, parent_id: "t1_abc9" } },
    { kind: "more", data: { count: 0, parent_id: "t1_abc9" } },
  ])));
  const partial = await preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch: withMore.fetch });
  assert.deepEqual(partial.notFetched, { count: 5, atLeast: true });
});

test("a page without a post id in its path is refused, in the script's words, and nothing is fetched", async () => {
  const { fetch, calls } = okFetch();
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/AskReddit/", { fetch }),
    /Not a post page/,
  );
  assert.equal(calls.length, 0, "nothing was fetched");
});

// --- downloadPrepared: the worker's half (chrome.downloads lives here), two files
// --- (json first, md second), downloaded one after the other

const twoFiles = [
  { url: "blob:json", name: "reddit-abc123.json" },
  { url: "blob:md", name: "reddit-abc123.md" },
];

test("both files settle: they download in order, saveAs pinned off, and each settles its own revoke", async () => {
  const settledFiles = [];
  const done = await downloadPrepared(workerDownloads, twoFiles, { onSettled: (f) => settledFiles.push(f) });
  // overwrite, not Chrome's default uniquify: a re-save must update the one file the
  // CLI's canonical name points at, never park a stale (1) copy beside it
  assert.deepEqual(workerDownloads.calls, [
    { url: "blob:json", filename: "reddit-abc123.json", saveAs: false, conflictAction: "overwrite" },
    { url: "blob:md", filename: "reddit-abc123.md", saveAs: false, conflictAction: "overwrite" },
  ]);
  assert.equal(done.settled, true);
  assert.equal(done.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads.");
  assert.deepEqual(settledFiles, twoFiles);
  workerDownloads.calls.length = 0;
});

test("downloadPrepared appends the notFetched note when the count is > 0 and keeps the message unchanged for 0 or undefined", async () => {
  const three = await downloadPrepared(workerDownloads, twoFiles, { notFetched: { count: 3, atLeast: false } });
  assert.equal(three.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads. 3 more comments weren't fetched — the .md links to them on reddit.");
  const one = await downloadPrepared(workerDownloads, twoFiles, { notFetched: { count: 1, atLeast: false } });
  assert.equal(one.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads. 1 more comment wasn't fetched — the .md links to them on reddit.");
  const floor = await downloadPrepared(workerDownloads, twoFiles, { notFetched: { count: 4, atLeast: true } });
  assert.equal(floor.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads. At least 4 more comments weren't fetched — the .md links to them on reddit.");
  const zero = await downloadPrepared(workerDownloads, twoFiles, { notFetched: { count: 0, atLeast: false } });
  assert.equal(zero.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads.");
  const undef = await downloadPrepared(workerDownloads, twoFiles, {});
  assert.equal(undef.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads.");
  workerDownloads.calls.length = 0;
});

test("a first download Chrome refuses to start says so, skips the second file, and frees its blob too", async () => {
  workerDownloads.download = async (opts) => { workerDownloads.calls.push(opts); throw new Error("URL length exceeds kMaxURLChars"); };
  const settledNames = [];
  let threw = null;
  try {
    await downloadPrepared(workerDownloads, twoFiles, { onSettled: (f) => settledNames.push(f.name) });
  } catch (e) {
    threw = e;
  }
  workerDownloads.download = async (opts) => { workerDownloads.calls.push(opts); return workerDownloads.calls.length; };
  assert.match(threw && threw.message || "", /Chrome didn't complete the save of reddit-abc123\.json/);
  assert.equal(workerDownloads.calls.length, 1, "the .md was never passed to downloads.download");
  // the skip is over for good: nothing will ever read the md blob, so it is revoked
  // alongside the json's — a refused save must not leak it in the offscreen document
  assert.deepEqual(settledNames, ["reddit-abc123.json", "reddit-abc123.md"]);
  workerDownloads.calls.length = 0;
});

test("an interrupted second file names the .md, after the json settled", async () => {
  workerDownloads.endState = "interrupted";
  const realSearch = workerDownloads.search;
  let searches = 0;
  workerDownloads.search = async () => { searches += 1; return [{ state: searches === 1 ? "complete" : "interrupted" }]; };
  const settledNames = [];
  let threw = null;
  try {
    await downloadPrepared(workerDownloads, twoFiles, { onSettled: (f) => settledNames.push(f.name) });
  } catch (e) {
    threw = e;
  }
  workerDownloads.search = realSearch;
  workerDownloads.endState = "complete";
  // nothing was still saving when the .md failed, so the message is exactly the
  // single-file failure — byte-pinned, so a changed trailing clause cannot slip through
  assert.equal(threw && threw.message || "", "Chrome didn't complete the save of reddit-abc123.md — check Chrome's downloads, then click Save again.");
  // an interrupted download is over for good too: its blob may be revoked like a settled one's
  assert.deepEqual(settledNames, ["reddit-abc123.json", "reddit-abc123.md"]);
});

test("a failed save after a timed-out one names both files: the failure and the one still saving", async () => {
  workerDownloads.endState = "in_progress";
  const realSearch = workerDownloads.search;
  let searches = 0;
  workerDownloads.search = async () => { searches += 1; return [{ state: searches === 1 ? "in_progress" : "interrupted" }]; };
  const settledNames = [];
  let threw = null;
  try {
    await downloadPrepared(workerDownloads, twoFiles, { timeout: 5, onSettled: (f) => settledNames.push(f.name) });
  } catch (e) {
    threw = e;
  }
  workerDownloads.search = realSearch;
  workerDownloads.endState = "complete";
  assert.equal(threw && threw.message,
    "Chrome didn't complete the save of reddit-abc123.md; reddit-abc123.json is still saving, unconfirmed — check Chrome's downloads, then click Save again.");
  assert.deepEqual(settledNames, ["reddit-abc123.md"],
    "the interrupted md fired onSettled, the timed-out json did NOT (its blob may still be read; no revoke)");
});

test("a json with no word and an md that settles: the message names both fates", async () => {
  workerDownloads.endState = "in_progress";
  const realSearch = workerDownloads.search;
  let searches = 0;
  workerDownloads.search = async () => { searches += 1; return [{ state: searches === 1 ? "in_progress" : "complete" }]; };
  // a notFetched count rides along, but the note waits for both files: none here
  const done = await downloadPrepared(workerDownloads, twoFiles, { timeout: 5, notFetched: { count: 3, atLeast: false } });
  workerDownloads.search = realSearch;
  workerDownloads.endState = "complete";
  assert.equal(done.settled, false);
  assert.equal(done.message,
    "Saved reddit-abc123.md to Downloads. reddit-abc123.json is still saving, with no word for a long while"
    + " — if it never lands in Downloads, click Save again.");
});

test("a json that settles and an md with no word: the message names both fates", async () => {
  workerDownloads.endState = "in_progress";
  const realSearch = workerDownloads.search;
  let searches = 0;
  workerDownloads.search = async () => { searches += 1; return [{ state: searches === 1 ? "complete" : "in_progress" }]; };
  const settledNames = [];
  const done = await downloadPrepared(workerDownloads, twoFiles, { timeout: 5, onSettled: (f) => settledNames.push(f.name) });
  workerDownloads.search = realSearch;
  workerDownloads.endState = "complete";
  assert.equal(done.settled, false);
  assert.match(done.message, /Saved reddit-abc123\.json to Downloads\. reddit-abc123\.md is still saving/);
  assert.deepEqual(settledNames, ["reddit-abc123.json"], "onSettled fired only for the settled json");
});

test("both files going quiet names both, and onSettled fired for neither", async () => {
  workerDownloads.endState = "in_progress";
  const settledNames = [];
  const done = await downloadPrepared(workerDownloads, twoFiles, { timeout: 5, onSettled: (f) => settledNames.push(f.name) });
  workerDownloads.endState = "complete";
  assert.equal(done.settled, false);
  assert.match(done.message, /reddit-abc123\.json and reddit-abc123\.md are still saving/);
  assert.match(done.message, /they never land/);
  assert.deepEqual(settledNames, [], "an unsettled download may still be reading the blob: no revoke");
});

// --- the popup command and the worker relay

test("the popup command hands the save to the worker and shows its message", async () => {
  reset();
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json", mdUrl: "blob:md", mdName: "reddit-abc123.md" };
  const shown = await commands.json({ url: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.match(shown, /Saved reddit-abc123\.json and reddit-abc123\.md/);
  assert.equal(relayedRuns.length, 1, "one relay to the offscreen document");
  assert.equal(relayedRuns[0].tabUrl, "https://www.reddit.com/r/x/comments/abc123/t/");
  assert.equal(workerDownloads.calls.length, 2, "the worker, not the document, downloads");
  assert.equal(revokesSent.length, 2, "each settled blob is asked to be freed");
  assert.deepEqual(revokesSent.map((m) => m.url), ["blob:x", "blob:md"], "each file revokes its own blob");
});

test("a relayed error is the popup's error text, bare", async () => {
  reset();
  relayReply = { ok: false, error: "reddit answered 403; try again from old.reddit.com/comments/abc123" };
  await assert.rejects(
    commands.json({ url: "https://www.reddit.com/r/x/comments/abc123/t/" }),
    /reddit answered 403/,
  );
  assert.equal(workerDownloads.calls.length, 0, "nothing downloads when the document refuses");
  assert.equal(revokesSent.length, 0);
});

test("a relay that rejects (no receiving end yet) comes back as a structured refusal", async () => {
  reset();
  relayThrows = new Error("Could not establish connection. Receiving end does not exist.");
  const reply = await handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /Receiving end does not exist/);
});

test("a silent save page gets the try-again advice, as a structured refusal", async () => {
  reset();
  relayReply = undefined;
  const reply = await handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /didn't answer/);
});

// --- the worker and its offscreen document

test("the worker opens the offscreen document on the first save and relays", async () => {
  reset();
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json", mdUrl: "blob:md", mdName: "reddit-abc123.md" };
  const reply = await handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok, `expected a save, got ${JSON.stringify(reply)}`);
  assert.equal(offscreenCreates.length, 1, "the document was created");
  assert.match(offscreenCreates[0].url, /offscreen\.html$/);
  assert.deepEqual(offscreenCreates[0].reasons, ["BLOBS"]);
  assert.ok(offscreenCreates[0].justification, "Chrome wants a justification");
});

test("an existing offscreen document is reused, not re-created", async () => {
  reset();
  offscreenHas = true;
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json", mdUrl: "blob:md", mdName: "reddit-abc123.md" };
  const reply = await handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok, `expected a save, got ${JSON.stringify(reply)}`);
  assert.equal(offscreenCreates.length, 0, "no second document");
});

test("two saves racing still create only one offscreen document, and the second waits for its listener", async () => {
  reset();
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json", mdUrl: "blob:md", mdName: "reddit-abc123.md" };
  offscreenHas = false;
  let release;
  let docReady = false;
  const slow = chrome.offscreen.createDocument;
  chrome.offscreen.createDocument = async (o) => {
    offscreenCreates.push(o);
    offscreenHas = true; // Chrome lists the document as soon as it is asked for…
    await new Promise((r) => { release = r; }); // …but its listener is up only once creation resolves
  };
  const realSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (msg) => {
    if (msg && msg.type === "discord-tools:reddit-save-run" && !docReady) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return realSend(msg);
  };
  const first = handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  const second = handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/y/comments/def456/t/" });
  await new Promise((r) => setTimeout(r, 5));
  release();
  docReady = true;
  const [a, b] = await Promise.all([first, second]);
  chrome.offscreen.createDocument = slow;
  chrome.runtime.sendMessage = realSend;
  assert.ok(a && a.ok && b && b.ok, `both saves land: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
  assert.equal(offscreenCreates.length, 1, "one document, shared creation");
});

test("a tab url the registry would not match is refused, and nothing is opened or relayed", async () => {
  reset();
  const reply = await handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/AskReddit/" });
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /no longer a reddit post page/);
  assert.equal(offscreenCreates.length, 0);
  assert.equal(relayedRuns.length, 0);
});
