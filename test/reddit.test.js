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
const OFFSCREEN_URL = "chrome-extension://test-extension-id/src/modules/reddit/offscreen.html";
const offscreenCreates = [];
const relayedRuns = [];
const revokesSent = [];
const imageRequests = [];
const mdRequests = [];
const donesSent = [];
let relayReply = null; // what the offscreen page answers the worker's relay with
let relayThrows = null; // or the error the relay rejects with
let imageReply = null;
let mdReply = null;
let workerListening = true;

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    onMessage: { addListener: (fn) => { onMessageListener = fn; } },
    getURL: (p) => `chrome-extension://test-extension-id/${p}`,
    // Chrome 116+'s check; answers only for the exact document the worker asks about
    getContexts: async ({ contextTypes, documentUrls }) =>
      offscreenHas && contextTypes.includes("OFFSCREEN_DOCUMENT")
        && documentUrls.includes(OFFSCREEN_URL) ? [{ documentUrl: OFFSCREEN_URL }] : [],
    sendMessage: async (msg) => {
      if (msg && msg.type === "leket:reddit-save-run") {
        relayedRuns.push(msg);
        if (relayThrows) throw relayThrows;
        return relayReply;
      }
      if (msg && msg.type === "leket:reddit-save-image") {
        imageRequests.push(msg);
        return typeof imageReply === "function" ? imageReply(msg) : imageReply;
      }
      if (msg && msg.type === "leket:reddit-save-md") {
        mdRequests.push(msg);
        return typeof mdReply === "function" ? mdReply(msg) : mdReply;
      }
      if (msg && msg.type === "leket:reddit-save-done") {
        donesSent.push(msg);
        return { ok: true };
      }
      if (msg && msg.type === "leket:reddit-save-revoke") {
        revokesSent.push(msg);
        return { ok: true };
      }
      if (workerListening && msg && msg.type === "leket:reddit-save") return handled(msg);
      return undefined;
    },
  },
  offscreen: {
    // no hasDocument: the worker must not lean on it (Chrome 150+, past the 109 floor)
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
  imageRequests.length = 0;
  mdRequests.length = 0;
  donesSent.length = 0;
  relayReply = null;
  relayThrows = null;
  imageReply = null;
  mdReply = null;
  workerListening = true;
  workerDownloads.endState = "complete";
  workerDownloads.calls.length = 0;
};

const { commands } = await import("../src/modules/reddit/json.js");
const { preparePostJson, fetchImage, isPrivateHost } = await import("../src/modules/reddit/prepare.js");
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

test("comments that aren't a list refuse in the wrapper's words too, not as a bare TypeError", async () => {
  for (const children of [5, {}]) {
    const { fetch } = okFetch(JSON.stringify([{ data: { children: [{ data: { title: "t" } }] } }, { data: { children } }]));
    await assert.rejects(
      preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch }),
      (e) => {
        assert.match(e.message, /isn't this post's data/, JSON.stringify(children));
        return true;
      },
    );
  }
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

test("preparePostJson returns id, data and savable images for gallery, single-image and self posts", async () => {
  const selfPrep = await preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch: okFetch().fetch });
  assert.equal(selfPrep.id, "abc123");
  assert.ok(Array.isArray(selfPrep.data));
  assert.deepEqual(selfPrep.images, []);

  const singleBody = JSON.stringify(postPage({ is_self: false, post_hint: "image", url_overridden_by_dest: "https://i.redd.it/solo.png" }));
  const singlePrep = await preparePostJson("https://www.reddit.com/r/x/comments/abc123/t/", { fetch: okFetch(singleBody).fetch });
  assert.equal(singlePrep.id, "abc123");
  assert.deepEqual(singlePrep.images, [{ n: 1, u: "https://i.redd.it/solo.png", ext: "" }]);

  const galleryBody = JSON.stringify(postPage({
    is_gallery: true,
    is_self: false,
    gallery_data: { items: [{ media_id: "a" }, { media_id: "b" }, { media_id: "c" }] },
    media_metadata: {
      a: { status: "valid", m: "image/png", s: { u: "https://i.redd.it/one.png" } },
      b: { e: "RedditVideo", s: { mp4: "https://v.redd.it/clip.mp4" } },
      c: { status: "valid", m: "image/jpeg", s: { u: "https://preview.redd.it/three.jpg" } },
    },
  }));
  const galleryPrep = await preparePostJson("https://www.reddit.com/r/x/comments/def456/t/", { fetch: okFetch(galleryBody).fetch });
  assert.equal(galleryPrep.id, "def456");
  assert.deepEqual(galleryPrep.images, [
    { n: 1, u: "https://i.redd.it/one.png", ext: ".png" },
    { n: 3, u: "https://preview.redd.it/three.jpg", ext: ".jpg" },
  ]);
});

// --- fetchImage: image fetch, ctype/size guards, blob creation

const streamOf = (chunks, { onCancel } = {}) => ({
  getReader: () => {
    let i = 0;
    return {
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
      cancel: async () => { if (onCancel) onCancel(); },
    };
  },
});

const headersOf = (map) => ({
  get: (k) => map[k.toLowerCase()] ?? null,
});

test("fetchImage fetches with credentials omit and returns a typed blob URL and CLI filename", async () => {
  const calls = [];
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      headers: headersOf({ "content-type": "Image/PNG; charset=utf-8", "content-length": "4" }),
      body: streamOf([bytes]),
    };
  };
  const realCreate = URL.createObjectURL;
  const blobs = [];
  URL.createObjectURL = (b) => { blobs.push(b); return realCreate(b); };
  let got;
  try {
    got = await fetchImage({ n: 2, u: "https://i.redd.it/pic", ext: ".jpg" }, { fetch });
  } finally {
    URL.createObjectURL = realCreate;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://i.redd.it/pic");
  assert.equal(calls[0].opts.credentials, "omit");
  assert.equal(calls[0].opts.redirect, "manual", "a redirect's next hop is never requested");
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
  assert.equal(got.name, "02.png");
  assert.match(got.url, /^blob:/);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, "image/png");
  assert.deepEqual(new Uint8Array(await blobs[0].arrayBuffer()), bytes);
});

test("fetchImage refuses non-image content types, HTTP errors, oversized responses and network errors", async () => {
  // non-image content-type (and missing content-type)
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.jpg", ext: ".jpg" }, {
      fetch: async () => ({ ok: true, status: 200, headers: headersOf({ "content-type": "text/html; charset=UTF-8" }), body: streamOf([]) }),
    }),
    /^Error: the server sent text\/html, not an image$/,
  );
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.jpg", ext: ".jpg" }, {
      fetch: async () => ({ ok: true, status: 200, headers: headersOf({}), body: streamOf([]) }),
    }),
    /^Error: the server sent no content type, not an image$/,
  );
  // HTTP 404
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.jpg", ext: ".jpg" }, {
      fetch: async () => ({ ok: false, status: 404, headers: headersOf({}) }),
    }),
    /^Error: the server answered 404$/,
  );
  // an image response with no body says so, not a bare TypeError
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, {
      fetch: async () => ({ ok: true, status: 200, headers: headersOf({ "content-type": "image/png" }), body: null }),
    }),
    /^Error: the server sent no image data$/,
  );
  // over the 50 MiB cap by content-length
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: headersOf({ "content-type": "image/png", "content-length": String(50 * 1048576 + 1) }),
      }),
    }),
    /^Error: over 50 MB$/,
  );
  // over the cap mid-stream: cancels the reader as soon as the count passes 50 MiB
  let cancelled = false;
  let reads = 0;
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: headersOf({ "content-type": "image/png" }),
        body: {
          getReader: () => ({
            read: async () => {
              reads += 1;
              return { done: false, value: new Uint8Array(30 * 1048576) };
            },
            cancel: async () => { cancelled = true; },
          }),
        },
      }),
    }),
    /^Error: over 50 MB$/,
  );
  assert.equal(cancelled, true, "the reader was cancelled when the stream passed 50 MiB");
  assert.equal(reads, 2, "stopped on the chunk that crossed the cap");
  // a redirect (redirect: "manual" hands back an opaque one) is refused, not followed
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, {
      fetch: async () => ({ type: "opaqueredirect", ok: false, status: 0, headers: headersOf({}), body: null }),
    }),
    /^Error: not fetched: it redirects to another address$/,
  );
  // fetch throw
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, {
      fetch: async () => { throw new TypeError("Failed to fetch"); },
    }),
    /^Error: couldn't reach it \(Failed to fetch\)$/,
  );
  // body-read rejection
  await assert.rejects(
    fetchImage({ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: headersOf({ "content-type": "image/png" }),
        body: { getReader: () => ({ read: async () => { throw new Error("stream reset"); } }) },
      }),
    }),
    /^Error: couldn't reach it \(stream reset\)$/,
  );
});

test("fetchImage refuses non-https, invalid and local/private-network URLs before any fetch", async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); throw new Error("fetch should not be called"); };
  for (const [u, expected] of [
    ["not a url", /^Error: not fetched: not a valid address$/],
    ["http://images.example.org/a.png", /^Error: not fetched: only https images are fetched$/],
    ["http://i.redd.it.example.org/a.png", /^Error: not fetched: only https images are fetched$/],
    ["ftp://i.redd.it/a.png", /^Error: not fetched: only https images are fetched$/],
    ["https://localhost/a.png", /^Error: not fetched: a local or private-network address$/],
    ["https://127.0.0.1/a.png", /^Error: not fetched: a local or private-network address$/],
    ["https://2130706433/a.png", /^Error: not fetched: a local or private-network address$/],
    ["https://192.168.1.5/a.png", /^Error: not fetched: a local or private-network address$/],
    ["https://[::1]/a.png", /^Error: not fetched: a local or private-network address$/],
    ["https://[::ffff:127.0.0.1]/a.png", /^Error: not fetched: a local or private-network address$/],
    ["https://router/a.png", /^Error: not fetched: a local or private-network address$/],
    ["https://printer.local/a.png", /^Error: not fetched: a local or private-network address$/],
  ]) {
    await assert.rejects(fetchImage({ n: 1, u, ext: ".png" }, { fetch }), expected, u);
  }
  assert.equal(calls.length, 0, "fetch spy was never called");
});

test("fetchImage upgrades http on reddit's own image hosts to https instead of refusing", async () => {
  // a fetch stub that records each URL it is asked for and answers with one image chunk
  const okImage = (calls, ctype = "image/png") => async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: headersOf({ "content-type": ctype }), body: streamOf([new Uint8Array([1])]) };
  };
  for (const host of ["i.redd.it", "preview.redd.it", "external-preview.redd.it"]) {
    const calls = [];
    const got = await fetchImage({ n: 1, u: `http://${host}/a.png?w=1`, ext: "" }, { fetch: okImage(calls) });
    assert.deepEqual(calls, [`https://${host}/a.png?w=1`], host);
    assert.equal(got.name, "01.png");
  }
  // an http port doesn't carry over to https
  let calls = [];
  await fetchImage({ n: 1, u: "http://i.redd.it:8080/a.png", ext: "" }, { fetch: okImage(calls) });
  assert.deepEqual(calls, ["https://i.redd.it/a.png"]);
  // a trailing dot is the same host: upgraded, and fetched without the dot
  calls = [];
  await fetchImage({ n: 1, u: "http://i.redd.it./a.png", ext: "" }, { fetch: okImage(calls) });
  assert.deepEqual(calls, ["https://i.redd.it/a.png"]);
  // an upgraded image with no known type takes its extension from the URL it was posted as
  calls = [];
  const got = await fetchImage({ n: 2, u: "http://i.redd.it/a.webp", ext: "" }, { fetch: okImage(calls, "image/x-unknown") });
  assert.deepEqual(calls, ["https://i.redd.it/a.webp"]);
  assert.equal(got.name, "02.webp");
});

test("fetchImage refuses an address with a login in it, on both the https and the upgraded path", async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); throw new Error("fetch should not be called"); };
  for (const u of ["https://u:p@i.redd.it/a.png", "http://u:p@i.redd.it/a.png", "https://u@images.example.org/a.png", "http://:p@i.redd.it/a.png"]) {
    await assert.rejects(fetchImage({ n: 1, u, ext: ".png" }, { fetch }), /^Error: not fetched: the address carries a login$/, u);
  }
  assert.equal(calls.length, 0, "fetch spy was never called");
});

test("isPrivateHost classifies normalized WHATWG URL hostnames", () => {
  for (const [u, expected] of [
    ["https://i.redd.it/", false],
    ["https://images.example.org/", false],
    ["https://8.8.8.8/", false],
    ["https://172.32.0.1/", false],
    ["https://100.128.0.1/", false],
    ["https://[2606:4700::1111]/", false],
    ["https://0x7f.1/", true],
    ["https://172.31.255.255/", true],
    ["https://100.64.0.1/", true],
    ["https://169.254.1.1/", true],
    ["https://0.0.0.0/", true],
    ["https://255.255.255.255/", true],
    ["https://[fe80::1]/", true],
    ["https://[fd00::1]/", true],
    ["https://localhost./", true],
    ["https://x.localhost/", true],
    ["https://a../", true],
    ["https://localhost.localdomain/", true],
    ["https://192.0.0.1/", true],
    ["https://192.0.2.1/", true],
    ["https://198.18.0.1/", true],
    ["https://198.19.255.255/", true],
    ["https://198.51.100.1/", true],
    ["https://203.0.113.1/", true],
    ["https://[2002:7f00:1::]/", true],
    ["https://[2001::1]/", true],
    ["https://192.0.1.1/", false],
    ["https://198.20.0.1/", false],
    ["https://[2001:db8::1]/", true],
    ["https://[2001:2::1]/", true],
    ["https://[2001:10::1]/", true],
    ["https://[2001:1ff::1]/", true],
    ["https://192.88.99.1/", true],
    ["https://home.arpa/", true],
    ["https://x.home.arpa/", true],
    ["https://nas.lan/", true],
    ["https://metadata.google.internal/", true],
    ["https://[2001:4860::1]/", false],
    ["https://[3fff::1]/", true],
    ["https://[3fff:fff::1]/", true],
    ["https://[3fff:1000::1]/", false],
    ["https://[2001:200::1]/", false],
    ["https://192.88.98.1/", false],
    ["https://myhome.arpa.example.com/", false],
    ["https://notlocaldomain.com/", false],
  ]) {
    assert.equal(isPrivateHost(new URL(u).hostname), expected, u);
  }
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

test("downloadPrepared with images downloads json -> images -> re-rendered md, frees the old md blob, and formats all three message shapes", async () => {
  workerDownloads.calls.length = 0;
  const events = [];
  const settled = [];
  let renderedWith = null;
  const done = await downloadPrepared(workerDownloads, twoFiles, {
    notFetched: { count: 2, atLeast: false },
    onSettled: (f) => { events.push(`settled:${f.url}`); settled.push(f); },
    images: {
      list: [{ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, { n: 2, u: "https://i.redd.it/b.jpg", ext: ".jpg" }],
      folder: "reddit-abc123-images",
      fetchImage: async (n) => {
        events.push(`fetch:${n}`);
        return n === 1 ? { ok: true, url: "blob:img1", name: "01.png" } : { ok: true, url: "blob:img2", name: "02.jpg" };
      },
      renderMd: async (saved) => {
        events.push("renderMd");
        renderedWith = saved;
        return { url: "blob:md-new", name: "reddit-abc123.md" };
      },
    },
  });
  assert.deepEqual(workerDownloads.calls.map((c) => [c.url, c.filename]), [
    ["blob:json", "reddit-abc123.json"],
    ["blob:img1", "reddit-abc123-images/01.png"],
    ["blob:img2", "reddit-abc123-images/02.jpg"],
    ["blob:md-new", "reddit-abc123.md"],
  ]);
  assert.deepEqual(renderedWith, { 1: "01.png", 2: "02.jpg" });
  assert.deepEqual(settled.map((f) => f.url), ["blob:json", "blob:img1", "blob:img2", "blob:md", "blob:md-new"],
    "the unlinked initial md blob is freed before the re-rendered md downloads, and the new md is freed when it settles");
  assert.equal(done.message,
    "Saved reddit-abc123.json and reddit-abc123.md to Downloads. The post's 2 images are in reddit-abc123-images. 2 more comments weren't fetched — the .md links to them on reddit.");
  workerDownloads.calls.length = 0;

  // 1 of 1 image saved (singular)
  const singleDone = await downloadPrepared(workerDownloads, twoFiles, {
    images: {
      list: [{ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }],
      folder: "reddit-abc123-images",
      fetchImage: async () => ({ ok: true, url: "blob:img1", name: "01.png" }),
      renderMd: async () => ({ url: "blob:md-new", name: "reddit-abc123.md" }),
    },
  });
  assert.equal(singleDone.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads. The post's image is in reddit-abc123-images.");
  workerDownloads.calls.length = 0;

  // 0 < k < m (partial save)
  const partialDone = await downloadPrepared(workerDownloads, twoFiles, {
    images: {
      list: [{ n: 1 }, { n: 2 }, { n: 3 }],
      folder: "reddit-abc123-images",
      fetchImage: async (n) => (n === 1
        ? { ok: true, url: "blob:img1", name: "01.png" }
        : { ok: false, error: n === 2 ? "the server answered 404" : "over 50 MB" }),
      renderMd: async (saved) => {
        assert.deepEqual(saved, { 1: "01.png" });
        return { url: "blob:md-new", name: "reddit-abc123.md" };
      },
    },
  });
  assert.equal(partialDone.message,
    "Saved reddit-abc123.json and reddit-abc123.md to Downloads. 1 of 3 images saved in reddit-abc123-images; the .md links the rest where they're hosted (image 2: the server answered 404; image 3: over 50 MB).");
  workerDownloads.calls.length = 0;

  // k === 0 (none saved, plural and singular): downloads original files[1] and never calls renderMd
  let renderCalled = false;
  const zeroPlural = await downloadPrepared(workerDownloads, twoFiles, {
    images: {
      list: [{ n: 1 }, { n: 2 }],
      folder: "reddit-abc123-images",
      fetchImage: async (n) => ({ ok: false, error: `bad ${n}` }),
      renderMd: async () => { renderCalled = true; return { url: "blob:md-new", name: "reddit-abc123.md" }; },
    },
  });
  assert.equal(renderCalled, false, "renderMd is not called when no image saved");
  assert.deepEqual(workerDownloads.calls.map((c) => c.url), ["blob:json", "blob:md"], "original md is downloaded unchanged");
  assert.equal(zeroPlural.message,
    "Saved reddit-abc123.json and reddit-abc123.md to Downloads. The post's images weren't saved; the .md links them where they're hosted (image 1: bad 1; image 2: bad 2).");
  workerDownloads.calls.length = 0;

  const zeroSingle = await downloadPrepared(workerDownloads, twoFiles, {
    images: {
      list: [{ n: 1 }],
      folder: "reddit-abc123-images",
      fetchImage: async () => null,
      renderMd: async () => { renderCalled = true; return { url: "blob:md-new", name: "reddit-abc123.md" }; },
    },
  });
  assert.equal(renderCalled, false);
  assert.equal(zeroSingle.message,
    "Saved reddit-abc123.json and reddit-abc123.md to Downloads. The post's image wasn't saved; the .md links it where it's hosted (image 1: no answer).");
  workerDownloads.calls.length = 0;
});

test("downloadPrepared with images: a json refusal fetches no image; image download false/null doesn't stop the save; a renderMd throw falls back to the prepared .md", async () => {
  // json refusal fetches no image
  let fetched = 0;
  const realSearch = workerDownloads.search;
  workerDownloads.search = async () => [{ state: "interrupted" }];
  await assert.rejects(
    downloadPrepared(workerDownloads, twoFiles, {
      images: {
        list: [{ n: 1 }],
        folder: "reddit-abc123-images",
        fetchImage: async () => { fetched += 1; return { ok: true, url: "blob:img1", name: "01.png" }; },
        renderMd: async () => ({ url: "blob:md-new", name: "reddit-abc123.md" }),
      },
    }),
    /Chrome didn't complete the save of reddit-abc123\.json/,
  );
  assert.equal(fetched, 0, "no image is fetched when the json fails");
  workerDownloads.calls.length = 0;

  // image download false (interrupted) and null (timeout) don't stop the save
  let call = 0;
  workerDownloads.search = async () => {
    call += 1;
    // call 1 = json (complete), call 2 = img1 (interrupted -> false), call 3 = img2 (in_progress -> null), call 4 = md (complete)
    if (call === 2) return [{ state: "interrupted" }];
    if (call === 3) return [{ state: "in_progress" }];
    return [{ state: "complete" }];
  };
  const settledUrls = [];
  const res = await downloadPrepared(workerDownloads, twoFiles, {
    timeout: 5,
    onSettled: (f) => settledUrls.push(f.url),
    images: {
      list: [{ n: 1 }, { n: 2 }],
      folder: "reddit-abc123-images",
      fetchImage: async (n) => ({ ok: true, url: `blob:img${n}`, name: `0${n}.png` }),
      renderMd: async () => { throw new Error("should not be called"); },
    },
  });
  workerDownloads.search = realSearch;
  workerDownloads.calls.length = 0;
  assert.equal(res.settled, true);
  assert.equal(res.message,
    "Saved reddit-abc123.json and reddit-abc123.md to Downloads. The post's images weren't saved; the .md links them where they're hosted (image 1: Chrome didn't complete the save; image 2: no word from Chrome yet).");
  assert.deepEqual(settledUrls, ["blob:json", "blob:img1", "blob:md"],
    "interrupted img1 fires onSettled; timed-out img2 does NOT fire onSettled");

  // renderMd throw falls back to the prepared .md (files[1]), freeing it only after its download
  const freedOnFallback = [];
  const callsWhenFreed = [];
  const fallbackDone = await downloadPrepared(workerDownloads, twoFiles, {
    onSettled: (f) => {
      freedOnFallback.push(f.url);
      callsWhenFreed.push([f.url, workerDownloads.calls.map((c) => c.url)]);
    },
    images: {
      list: [{ n: 1 }],
      folder: "reddit-abc123-images",
      fetchImage: async () => ({ ok: true, url: "blob:img1", name: "01.png" }),
      renderMd: async () => { throw new Error("render threw"); },
    },
  });
  assert.deepEqual(workerDownloads.calls.map((c) => [c.url, c.filename]), [
    ["blob:json", "reddit-abc123.json"],
    ["blob:img1", "reddit-abc123-images/01.png"],
    ["blob:md", "reddit-abc123.md"],
  ]);
  assert.deepEqual(freedOnFallback, ["blob:json", "blob:img1", "blob:md"]);
  assert.deepEqual(callsWhenFreed[2], ["blob:md", ["blob:json", "blob:img1", "blob:md"]],
    "blob:md is freed only after its own download");
  assert.equal(fallbackDone.message,
    "Saved reddit-abc123.json and reddit-abc123.md to Downloads. The post's image is in reddit-abc123-images. The .md couldn't be rewritten to link the saved images, so it links every image where it's hosted.");
  workerDownloads.calls.length = 0;

  // some saved and the re-render failed: the partial sentence leaves the linking to the
  // fallback sentence, so the two don't say different things
  const partialFallback = await downloadPrepared(workerDownloads, twoFiles, {
    images: {
      list: [{ n: 1 }, { n: 2 }],
      folder: "reddit-abc123-images",
      fetchImage: async (n) => (n === 1 ? { ok: true, url: "blob:img1", name: "01.png" } : { ok: false, error: "the server answered 404" }),
      renderMd: async () => { throw new Error("render threw"); },
    },
  });
  assert.equal(partialFallback.message,
    "Saved reddit-abc123.json and reddit-abc123.md to Downloads. 1 of 2 images saved in reddit-abc123-images (image 2: the server answered 404). The .md couldn't be rewritten to link the saved images, so it links every image where it's hosted.");
  workerDownloads.calls.length = 0;

  // renderMd fallback whose .md download is then interrupted while the json had no word
  let fallbackCall = 0;
  workerDownloads.search = async () => {
    fallbackCall += 1;
    // call 1 = json (in_progress -> null), call 2 = img1 (complete -> true), call 3 = fallback md (interrupted -> false)
    if (fallbackCall === 1) return [{ state: "in_progress" }];
    if (fallbackCall === 2) return [{ state: "complete" }];
    return [{ state: "interrupted" }];
  };
  const freedAfterInterrupt = [];
  let fallbackThrew = null;
  try {
    await downloadPrepared(workerDownloads, twoFiles, {
      timeout: 5,
      onSettled: (f) => freedAfterInterrupt.push(f.url),
      images: {
        list: [{ n: 1 }],
        folder: "reddit-abc123-images",
        fetchImage: async () => ({ ok: true, url: "blob:img1", name: "01.png" }),
        renderMd: async () => { throw new Error("render threw"); },
      },
    });
  } catch (e) {
    fallbackThrew = e;
  }
  workerDownloads.search = realSearch;
  workerDownloads.calls.length = 0;
  assert.equal(fallbackThrew && fallbackThrew.message,
    "Chrome didn't complete the save of reddit-abc123.md; reddit-abc123.json is still saving, unconfirmed — check Chrome's downloads, then click Save again.");
  assert.deepEqual(freedAfterInterrupt, ["blob:img1", "blob:md"]);
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
  const reply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /Receiving end does not exist/);
});

test("a silent save page gets the try-again advice, as a structured refusal", async () => {
  reset();
  relayReply = undefined;
  const reply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /didn't answer/);
});

// --- the worker and its offscreen document

test("the worker opens the offscreen document on the first save and relays", async () => {
  reset();
  relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json", mdUrl: "blob:md", mdName: "reddit-abc123.md" };
  const reply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
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
  const reply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok, `expected a save, got ${JSON.stringify(reply)}`);
  assert.equal(offscreenCreates.length, 0, "no second document");
});

test("below Chrome 116 (no getContexts) the worker's clients say whether the document is open", async () => {
  const getContexts = chrome.runtime.getContexts;
  delete chrome.runtime.getContexts;
  const hadSelf = "self" in globalThis, oldSelf = globalThis.self;
  // the worker's clients list the document by its URL once it is open, and only when
  // uncontrolled clients are asked for: nothing proves the worker controls it
  globalThis.self = { clients: { matchAll: async (opts) => (offscreenHas && opts?.includeUncontrolled === true ? [{ url: OFFSCREEN_URL }] : [{ url: "chrome-extension://test-extension-id/other.html" }]) } };
  try {
    const save = () => handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
    reset();
    relayReply = { ok: true, url: "blob:x", name: "reddit-abc123.json", mdUrl: "blob:md", mdName: "reddit-abc123.md" };
    assert.ok((await save()).ok);
    assert.equal(offscreenCreates.length, 1, "no document among the clients: one is created");
    assert.ok((await save()).ok);
    assert.equal(offscreenCreates.length, 1, "the open document is found among the clients and reused");
  } finally {
    chrome.runtime.getContexts = getContexts;
    if (hadSelf) globalThis.self = oldSelf; else delete globalThis.self;
  }
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
    if (msg && msg.type === "leket:reddit-save-run" && !docReady) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return realSend(msg);
  };
  const first = handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  const second = handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/y/comments/def456/t/" });
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
  const reply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/AskReddit/" });
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /no longer a reddit post page/);
  assert.equal(offscreenCreates.length, 0);
  assert.equal(relayedRuns.length, 0);
});

test("the worker relay sends image, md and done messages, and sends done even when a download throws", async () => {
  reset();
  relayReply = {
    ok: true,
    token: "tok-1",
    id: "abc123",
    images: [{ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }],
    url: "blob:json",
    name: "reddit-abc123.json",
    mdUrl: "blob:md-initial",
    mdName: "reddit-abc123.md",
  };
  imageReply = { ok: true, url: "blob:img1", name: "01.png" };
  mdReply = { ok: true, mdUrl: "blob:md-final", mdName: "reddit-abc123.md" };
  const reply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.ok(reply && reply.ok, JSON.stringify(reply));
  assert.match(reply.message, /The post's image is in reddit-abc123-images\./);
  assert.deepEqual(imageRequests, [{ type: "leket:reddit-save-image", token: "tok-1", n: 1 }]);
  assert.deepEqual(mdRequests, [{
    type: "leket:reddit-save-md",
    token: "tok-1",
    saved: { 1: "01.png" },
    folderRel: "reddit-abc123-images",
  }]);
  assert.deepEqual(donesSent, [{ type: "leket:reddit-save-done", token: "tok-1" }]);
  assert.deepEqual(revokesSent.map((m) => m.url), ["blob:json", "blob:img1", "blob:md-initial", "blob:md-final"]);

  // when the download throws, leket:reddit-save-done is still sent in finally
  reset();
  relayReply = {
    ok: true,
    token: "tok-2",
    id: "abc123",
    images: [{ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }],
    url: "blob:json",
    name: "reddit-abc123.json",
    mdUrl: "blob:md-initial",
    mdName: "reddit-abc123.md",
  };
  workerDownloads.endState = "interrupted";
  const failedReply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  workerDownloads.endState = "complete";
  assert.equal(failedReply.ok, false);
  assert.deepEqual(donesSent, [{ type: "leket:reddit-save-done", token: "tok-2" }], "done is sent even when the download throws");
});

// --- review round 1: an image Chrome refuses outright, a late image, a refused body, a text post

// a downloads stub whose download() can throw synchronously and whose events the test fires
const scriptedDownloads = ({ throwFor = () => false, stateFor = () => "complete" } = {}) => {
  const dl = {
    calls: [],
    listeners: new Set(),
    download(opts) {
      if (throwFor(opts.filename)) throw new Error("Invalid filename");
      dl.calls.push(opts);
      return Promise.resolve(dl.calls.length);
    },
    search: async ({ id }) => [{ state: stateFor(dl.calls[id - 1].filename) }],
    onChanged: {
      addListener: (fn) => dl.listeners.add(fn),
      removeListener: (fn) => dl.listeners.delete(fn),
    },
    fire: (id, state) => { for (const fn of [...dl.listeners]) fn({ id, state: { current: state } }); },
  };
  return dl;
};

test("an image whose download Chrome refuses to start is noted and freed, and the save goes on", async () => {
  const dl = scriptedDownloads({ throwFor: (f) => f.endsWith("/02.png") });
  const freed = [];
  const rendered = [];
  const done = await downloadPrepared(dl, twoFiles, {
    onSettled: (f) => freed.push(f.url),
    images: {
      list: [{ n: 1 }, { n: 2 }, { n: 3 }],
      folder: "reddit-abc123-images",
      fetchImage: async (n) => ({ ok: true, url: `blob:img${n}`, name: `0${n}.png` }),
      renderMd: async (saved) => { rendered.push(saved); return { url: "blob:md-new", name: "reddit-abc123.md" }; },
    },
  });
  assert.deepEqual(dl.calls.map((c) => c.filename),
    ["reddit-abc123.json", "reddit-abc123-images/01.png", "reddit-abc123-images/03.png", "reddit-abc123.md"]);
  assert.deepEqual(rendered, [{ 1: "01.png", 3: "03.png" }]);
  assert.ok(freed.includes("blob:img2"), `the refused image's blob is freed (${freed})`);
  assert.equal(freed.filter((u) => u === "blob:img2").length, 1);
  assert.match(done.message, /2 of 3 images saved in reddit-abc123-images; the \.md links the rest where they're hosted \(image 2: Chrome refused the download\)\./);
});

test("an image with no word at the timeout is freed when it ends later", async () => {
  const dl = scriptedDownloads({ stateFor: (f) => (f.includes("-images/") ? "in_progress" : "complete") });
  const freed = [];
  const done = await downloadPrepared(dl, twoFiles, {
    timeout: 5,
    onSettled: (f) => freed.push(f.url),
    images: {
      list: [{ n: 1 }],
      folder: "reddit-abc123-images",
      fetchImage: async () => ({ ok: true, url: "blob:img1", name: "01.png" }),
      renderMd: async () => { throw new Error("not called: nothing saved"); },
    },
  });
  assert.match(done.message, /The post's image wasn't saved; the \.md links it where it's hosted \(image 1: no word from Chrome yet\)\./);
  assert.ok(!freed.includes("blob:img1"), "a download still going keeps its blob");
  dl.fire(2, "complete");
  assert.deepEqual(freed.filter((u) => u === "blob:img1"), ["blob:img1"], "its late end frees it, once");
});

test("fetchImage cancels the unread body of a response it refuses", async () => {
  for (const [status, type] of [[404, "image/png"], [200, "text/html"]]) {
    let cancelled = 0;
    await assert.rejects(fetchImage({ n: 1, u: "https://i.redd.it/a.png", ext: ".png" }, {
      fetch: async () => ({ ok: status === 200, status, headers: headersOf({ "content-type": type }), body: { cancel: async () => { cancelled += 1; } } }),
    }));
    assert.equal(cancelled, 1, `status ${status} ${type}: the body is cancelled`);
  }
});

test("a text post keeps the two-file save: no image, md or done message", async () => {
  reset();
  relayReply = { ok: true, id: "abc123", images: [], url: "blob:json", name: "reddit-abc123.json", mdUrl: "blob:md", mdName: "reddit-abc123.md" };
  const reply = await handled({ type: "leket:reddit-save", tabUrl: "https://www.reddit.com/r/x/comments/abc123/t/" });
  assert.equal(reply.message, "Saved reddit-abc123.json and reddit-abc123.md to Downloads.");
  assert.deepEqual([imageRequests.length, mdRequests.length, donesSent.length], [0, 0, 0]);
});
