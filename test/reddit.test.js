// The reddit save across its homes: preparePostJson (offscreen document: fetch,
// validate, blob) against stubbed fetch; downloadPrepared (worker: chrome.downloads)
// against a stubbed downloads API; the popup command and the worker relay against a
// stubbed chrome. The console script dev-docs/browser/reddit-json.js is the spec the
// prepare half ports: one fetch of the post's .json with the browser's own login
// riding along, saved as reddit-<id>.json — and the script's old.reddit advice stays
// advice in the error text, never an auto-retry.
import { test } from "node:test";
import assert from "node:assert/strict";

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

// a red line under every test: anything that reaches the real network forgot to inject
// its fetch (this file sits behind a stubbed chrome; no test may open a socket)
globalThis.fetch = async () => { throw new Error("no network in tests: inject a fetch stand-in"); };

const okFetch = (body = '{"kind":"Listing"}') => {
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

test("a large thread prepares fine — the blob has no URL size cap", async () => {
  const big = JSON.stringify({ kind: "Listing", data: { body: "x".repeat(3 * 1024 * 1024) } });
  const { fetch } = okFetch(big);
  const prep = await preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch });
  assert.equal(prep.name, "reddit-abc123.json");
  assert.match(prep.url, /^blob:/);
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

test("a page without a post id in its path is refused, in the script's words, and nothing is fetched", async () => {
  const { fetch, calls } = okFetch();
  await assert.rejects(
    preparePostJson("https://www.reddit.com/r/AskReddit/", { fetch }),
    /Not a post page/,
  );
  assert.equal(calls.length, 0, "nothing was fetched");
});

// --- downloadPrepared: the worker's half (chrome.downloads lives here)

test("the prepared blob downloads under the CLI's expected name with saveAs pinned off", async () => {
  const revokes = [];
  const done = await downloadPrepared(workerDownloads, { url: "blob:x", name: "reddit-z9y8x7.json" }, {
    onSettled: () => revokes.push(1),
  });
  assert.match(done.message, /Saved reddit-z9y8x7\.json to Downloads/);
  assert.match(done.message, /reddit-export --from-json ~\/Downloads\/reddit-z9y8x7\.json/);
  assert.equal(done.settled, true);
  // overwrite, not Chrome's default uniquify: a re-save must update the one file the
  // CLI's canonical name points at, never park a stale (1) copy beside it
  assert.deepEqual(workerDownloads.calls, [{ url: "blob:x", filename: "reddit-z9y8x7.json", saveAs: false, conflictAction: "overwrite" }]);
  assert.equal(revokes.length, 1, "a settled download frees the blob");
  workerDownloads.calls.length = 0;
});

test("a download Chrome refuses to start says so, and is not a save", async () => {
  workerDownloads.download = async () => { throw new Error("URL length exceeds kMaxURLChars"); };
  await assert.rejects(
    downloadPrepared(workerDownloads, { url: "blob:x", name: "reddit-abc123.json" }),
    /Chrome didn't complete the save/,
  );
  workerDownloads.download = async (opts) => { workerDownloads.calls.push(opts); return workerDownloads.calls.length; };
  workerDownloads.calls.length = 0;
});

test("an interrupted download says so instead of reporting a save", async () => {
  workerDownloads.endState = "interrupted";
  await assert.rejects(
    downloadPrepared(workerDownloads, { url: "blob:x", name: "reddit-abc123.json" }),
    /Chrome didn't complete the save/,
  );
  workerDownloads.endState = "complete";
});

test("a download with no word stays unsettled and says so, instead of claiming a save", async () => {
  workerDownloads.endState = "in_progress";
  const revokes = [];
  const done = await downloadPrepared(workerDownloads, { url: "blob:x", name: "reddit-abc123.json" }, {
    timeout: 5,
    onSettled: () => revokes.push(1),
  });
  assert.match(done.message, /still saving/);
  assert.equal(done.settled, false);
  assert.equal(revokes.length, 0, "an unsettled download may still be reading the blob: no revoke");
  workerDownloads.endState = "complete";
});

// --- the popup command and the worker relay

test("the popup command hands the save to the worker and shows its message", async () => {
  reset();
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json" };
  const shown = await commands.json({ url: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.match(shown, /Saved reddit-abc123\.json/);
  assert.equal(relayedRuns.length, 1, "one relay to the offscreen document");
  assert.equal(relayedRuns[0].tabUrl, "https://www.reddit.com/r/x/comments/abc123/t/");
  assert.equal(workerDownloads.calls.length, 1, "the worker, not the document, downloads");
  assert.equal(revokesSent.length, 1, "the settled blob is asked to be freed");
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
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json" };
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
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json" };
  const reply = await handled({ type: "discord-tools:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok, `expected a save, got ${JSON.stringify(reply)}`);
  assert.equal(offscreenCreates.length, 0, "no second document");
});

test("two saves racing still create only one offscreen document, and the second waits for its listener", async () => {
  reset();
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json" };
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
