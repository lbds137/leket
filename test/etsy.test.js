// The Etsy module's pure half, ported from the console script in docs/etsy-script-spec.md
// — the script is the spec. Everything runs against an injected fetch stand-in: no test
// may open a socket, and the invariants the unit spec names (the stale >= 2 stop rule,
// the cumulative offset paging, one redact call over the whole serialized string, the
// dated filename) are pinned here one by one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// a red line under every test, like claude-sessions-export.test.js: an un-injected fetch
// is a bug
globalThis.fetch = async () => { throw new Error("no network in tests: inject a fetch stand-in"); };

const { messagesIn, parseIds, collectConversations, serializePayload, outputName, redactStateFor, redactionCollisions, redactLineFor, redactSetup, parsesAsJson, finishMessage, failureLines, conflictActionFor, counted }
  = await import("../src/modules/etsy/messages.js");
const { makeRedact } = await import("../src/modules/etsy/redact.js");
const { match } = await import("../src/modules/registry.js");
const { COMMANDS } = await import("../src/popup/commands.js");

// the per-file copy of the stand-in pattern in test/claude-sessions-export.test.js (its
// `standIn`): routes keyed by the queryless URL (the endpoint's own query moves per page),
// a route is a function of the page index this URL has already answered, returning the
// JSON body. A `status` outside 200-299 answers !ok.
const standIn = (routes) => {
  const calls = [];
  const counts = new Map();
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const base = url.split("?")[0];
    const route = routes[base];
    if (!route) throw new Error(`no stand-in for ${url}`);
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    const out = route(n);
    const status = out && out.status;
    if (status && (status < 200 || status >= 300)) return { ok: false, status, json: async () => out };
    return { ok: true, status: 200, json: async () => out };
  };
  fetch.calls = calls;
  return fetch;
};

// one message as the endpoint carries it
const msg = (id, create_date = 0, message_order = 0) => ({ conversation_message_id: id, create_date, message_order });
const url = (id) => `https://www.etsy.com/api/v3/ajax/member/conversations/detail/${id}/message-list`;

test("messagesIn finds every conversation_message_id carrier, wherever it is nested", () => {
  const carrier = { conversation_message_id: 7 };
  // several levels deep, through arrays and through objects without the key
  const deep = { a: [1, { b: [{ c: { d: carrier } }] }] };
  assert.deepEqual(messagesIn(deep), [carrier]);
  assert.deepEqual(messagesIn({ x: 1, y: "text", z: [carrier] }), [carrier]);
  assert.deepEqual(messagesIn([carrier, [carrier]]), [carrier, carrier]);
  // non-carrier leaves are excluded, not collected
  assert.deepEqual(messagesIn({ leaf: 3, nested: { deeper: null } }), []);
});

test("parseIds splits on spaces, commas and newlines, and drops junk tokens", () => {
  assert.deepEqual(parseIds("1, 2,3 4"), ["1", "2", "3", "4"]);
  assert.deepEqual(parseIds("1\n2\t3"), ["1", "2", "3"]);
  assert.deepEqual(parseIds("12a, 34, x"), ["34"]);
  assert.deepEqual(parseIds(""), []);
  assert.deepEqual(parseIds("junk"), []);
});

test("parseIds falls back to the /messages/ pathname, and text beats pathname", () => {
  assert.deepEqual(parseIds("", "/messages/123"), ["123"]);
  assert.deepEqual(parseIds("", "/shop/thing"), []);
  assert.deepEqual(parseIds("", ""), []);
  assert.deepEqual(parseIds("9", "/messages/123"), ["9"]);
});

test("two consecutive pages adding nothing stop the walk, and pages counts every page", async () => {
  const same = [msg(1), msg(2)];
  const fetch = standIn({ [url("111")]: () => same });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {} });
  // the walk stopped by itself (the route never empties); the upper bound stays loose so
  // a one-page-earlier stop keeps THIS pin green and reddens only the
  // one-stale-continues pin below
  assert.ok(fetch.calls.length <= 3, `the walk stopped (fetches: ${fetch.calls.length})`);
  assert.equal(convos[0].pages, fetch.calls.length, "pages counts the stale pages too");
  assert.deepEqual(convos[0].messages.map((m) => m.conversation_message_id), [1, 2]);
  assert.equal(convos[0].error, undefined);
});

test("ONE stale page followed by a page with new ids keeps the walk going", async () => {
  const pages = [[msg(1), msg(2)], [msg(1), msg(2)], [msg(3), msg(4)], []];
  const fetch = standIn({ [url("111")]: (n) => pages[n] });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {} });
  assert.equal(fetch.calls.length, 4, "the walk continued past the single stale page");
  assert.deepEqual(convos[0].messages.map((m) => m.conversation_message_id), [1, 2, 3, 4]);
  assert.equal(convos[0].pages, 4);
  assert.equal(convos[0].error, undefined);
});

test("an empty page breaks immediately, even right after a fresh one", async () => {
  const pages = [[msg(1)], []];
  const fetch = standIn({ [url("111")]: (n) => pages[n] });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {} });
  assert.equal(fetch.calls.length, 2);
  assert.equal(convos[0].pages, 2);
  assert.deepEqual(convos[0].messages.map((m) => m.conversation_message_id), [1]);
  assert.equal(convos[0].error, undefined);
});

test("page overlap is real: an id repeated across pages is never duplicated", async () => {
  const pages = [[msg(1), msg(2)], [msg(2), msg(3)], []];
  const fetch = standIn({ [url("111")]: (n) => pages[n] });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {} });
  assert.deepEqual(convos[0].messages.map((m) => m.conversation_message_id), [1, 2, 3]);
  assert.equal(convos[0].pages, 3);
});

test("each page attempt carries the cumulative offset on the exact path and query", async () => {
  const pages = [[msg(1), msg(2)], [msg(3)], [msg(4)], []];
  const fetch = standIn({ [url("111")]: (n) => pages[n] });
  await collectConversations(["111"], { fetch, sleep: async () => {} });
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    `${url("111")}?offset=0&fetch_older=true&load_shop_convos=false`,
    `${url("111")}?offset=2&fetch_older=true&load_shop_convos=false`,
    `${url("111")}?offset=3&fetch_older=true&load_shop_convos=false`,
    `${url("111")}?offset=4&fetch_older=true&load_shop_convos=false`,
  ]);
  // the fetch rides the page's session, asking Etsy for JSON, with a per-page timeout signal
  assert.ok(fetch.calls[0].opts.signal instanceof AbortSignal, "the fetch carries an abort timeout");
  assert.notEqual(fetch.calls[0].opts.signal, fetch.calls[1].opts.signal, "a fresh timeout signal per page");
  assert.deepEqual(fetch.calls[0].opts, {
    credentials: "include",
    headers: { accept: "application/json" },
    signal: fetch.calls[0].opts.signal,
  });
});

test("a fetch that times out records the error on its conversation; the next id still runs", async () => {
  const fetch = async (u) => {
    if (u.includes("/111/")) throw new DOMException("The operation timed out.", "TimeoutError");
    return { ok: true, status: 200, json: async () => [msg(9)] };
  };
  const convos = await collectConversations(["111", "222"], { fetch, sleep: async () => {} });
  assert.equal(convos[0].error, "timed out after 60 s at offset 0");
  assert.deepEqual(convos[1].messages.map((m) => m.conversation_message_id), [9]);
  assert.equal(convos[1].error, undefined);
});

test("timeoutMs reaches the abort signal: a fetch that never answers ends as a timeout", async () => {
  const fetch = (u, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
  });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {}, timeoutMs: 1 });
  assert.equal(convos[0].error, "timed out after 0.001 s at offset 0");
});

test("a timeout on a later page names that page's offset", async () => {
  const fetch = async (u) => {
    if (!u.includes("offset=0&")) throw new DOMException("The operation timed out.", "TimeoutError");
    return { ok: true, status: 200, json: async () => [msg(1), msg(2), msg(3)] };
  };
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {} });
  assert.equal(convos[0].error, "timed out after 60 s at offset 3");
  assert.equal(convos[0].messages.length, 3);
});

test("a body read the timeout aborts is a timeout, not a sign-out", async () => {
  const fetch = async (u, opts) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    }),
  });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {}, timeoutMs: 1 });
  assert.doesNotMatch(convos[0].error, /signed out/);
  assert.equal(convos[0].error, "timed out after 0.001 s at offset 0");
});

test("an AbortError the page's timeout caused reads as timed out; any other abort reads as stopped", async () => {
  // a read the timeout signal ended, surfacing as a plain AbortError (older engines)
  const late = (u, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
  let convos = await collectConversations(["111"], { fetch: late, sleep: async () => {}, timeoutMs: 1 });
  assert.equal(convos[0].error, "timed out after 0.001 s at offset 0");
  // an abort while the page's own signal is still live is not a timeout: it says stopped
  const stopped = async (u) => {
    if (!u.includes("offset=0&")) throw new DOMException("The operation was aborted.", "AbortError");
    return { ok: true, status: 200, json: async () => [msg(1), msg(2)] };
  };
  convos = await collectConversations(["111"], { fetch: stopped, sleep: async () => {} });
  assert.equal(convos[0].error, "stopped at offset 2");
  assert.equal(convos[0].messages.length, 2);
  // the same in the body read: a live signal, an AbortError, a stop and not a sign-out
  const body = async () => ({ ok: true, status: 200, json: async () => { throw new DOMException("aborted", "AbortError"); } });
  convos = await collectConversations(["111"], { fetch: body, sleep: async () => {} });
  assert.equal(convos[0].error, "stopped at offset 0");
});

test("a !ok page marks its conversation with the HTTP error; the next id still runs", async () => {
  const fetch = async (u) => {
    if (u.includes("/111/")) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [msg(9)] };
  };
  const convos = await collectConversations(["111", "222"], { fetch, sleep: async () => {} });
  assert.deepEqual(convos.map((c) => c.id), ["111", "222"]);
  assert.equal(convos[0].error, "HTTP 403 at offset 0");
  assert.deepEqual(convos[1].messages.map((m) => m.conversation_message_id), [9]);
  assert.equal(convos[1].error, undefined);
});

test("a 200 whose json() throws is the signed-out error; the next id still runs", async () => {
  // Etsy's login page answers 200 with HTML, not JSON: json() throws. The walk says
  // signed out instead of leaking the parser's message, and the next id still runs.
  const fetch = async (u) => {
    if (u.includes("/111/")) {
      return {
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON"); },
      };
    }
    return { ok: true, status: 200, json: async () => [msg(9)] };
  };
  const convos = await collectConversations(["111", "222"], { fetch, sleep: async () => {} });
  assert.equal(convos[0].error, "not JSON (signed out of Etsy?) at offset 0");
  assert.deepEqual(convos[1].messages.map((m) => m.conversation_message_id), [9]);
  assert.equal(convos[1].error, undefined);
});

test("messages sort by create_date asc, ties by message_order asc, missing create_date as 0", async () => {
  const pages = [[msg(1, 100, 2), msg(2, 100, 1), msg(3, 50, 0), msg(4)], []];
  const fetch = standIn({ [url("111")]: (n) => pages[n] });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {} });
  assert.deepEqual(convos[0].messages.map((m) => m.conversation_message_id), [4, 3, 2, 1]);
});

test("the page cap stops the walk with no error, and marks it truncated", async () => {
  let n = 0;
  const fetch = standIn({ [url("111")]: () => [msg(++n)] }); // every page brings something new
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {}, maxPages: 5 });
  assert.equal(convos[0].pages, 5);
  assert.equal(fetch.calls.length, 5);
  assert.equal(convos[0].error, undefined);
  assert.equal(convos[0].truncated, true);
});

test("a walk that ends on its own is never truncated, even on the cap's last page", async () => {
  // the third page is empty: the walk breaks on it, the same page that reaches maxPages
  const pages = [[msg(1)], [msg(2)], []];
  const fetch = standIn({ [url("111")]: (k) => pages[k] });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {}, maxPages: 3 });
  assert.equal(convos[0].pages, 3);
  assert.equal(convos[0].truncated, undefined);
  assert.ok(!("truncated" in convos[0]), "the field is absent, so an uncapped file keeps the script's shape");
});

test("a cap below one page is refused before any fetch", async () => {
  for (const maxPages of [0, -1, 0.5, NaN, "3"]) {
    const fetch = standIn({ [url("111")]: () => [msg(1)] });
    await assert.rejects(collectConversations(["111"], { fetch, sleep: async () => {}, maxPages }), RangeError, String(maxPages));
    assert.equal(fetch.calls.length, 0);
  }
});

test("an answer with no messages and no error is marked empty in the file; others carry no empty field", async () => {
  const fetch = async (u) => {
    if (u.includes("/111/")) return { ok: true, status: 200, json: async () => [] };
    if (u.includes("/222/")) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (u.includes("offset=0&") ? [msg(9)] : []) };
  };
  const convos = await collectConversations(["111", "222", "333"], { fetch, sleep: async () => {} });
  assert.equal(convos[0].empty, true);
  assert.ok(!("empty" in convos[1]), "an error explains the missing messages: no empty marker");
  assert.ok(!("empty" in convos[2]), "a conversation with messages keeps the script's shape");
  assert.equal(JSON.parse(serializePayload(convos)).conversations[0].empty, true);
});

test("sleeps: one per continuing page attempt, none on the break, one trailing per conversation", async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const pages = [[msg(1), msg(2)], [msg(3)], []];
  const fetch = standIn({ [url("111")]: (n) => pages[n] });
  await collectConversations(["111"], { fetch, sleep, pauseMs: 400 });
  assert.deepEqual(sleeps, [400, 400, 400]);
});

test("the trailing sleep fires after every conversation, including the last", async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const fetch = async () => ({ ok: true, status: 200, json: async () => [] }); // empty: no inter-page sleep
  await collectConversations(["111", "222"], { fetch, sleep, pauseMs: 7 });
  assert.deepEqual(sleeps, [7, 7]);
});

// the payload: the script's shape, plus the loud redact field the file's consumer asked for
const METHOD =
  "Collected with Leket's Etsy module on etsy.com. " +
  "Each conversation was paged through /api/v3/ajax/member/conversations/detail/<id>/message-list " +
  "(offset, fetch_older=true) and deduped on conversation_message_id; message objects are as Etsy returned them.";

test("serializePayload: no opts — the script's payload shape, loudly unredacted", () => {
  const convo = { id: "111", url: "https://www.etsy.com/messages/111", pages: 1, messages: [msg(1)] };
  const out = serializePayload([convo], { extractedAt: "2026-11-05T00:00:00.000Z" });
  const expected = {
    source: "etsy",
    extracted_at: "2026-11-05T00:00:00.000Z",
    redact: "off (no etsyRedact config)",
    method: METHOD,
    conversations: [convo],
  };
  assert.deepEqual(JSON.parse(out), expected);
  // the field order is pinned too: source, extracted_at, redact, method, conversations
  assert.deepEqual(Object.keys(JSON.parse(out)), Object.keys(expected));
  assert.equal(out, JSON.stringify(expected, null, 1), "indent is one space");
});

test("serializePayload: a redact fn — the field says on, redact runs once over the whole string", () => {
  const seen = [];
  const out = serializePayload([], {
    extractedAt: "2026-11-05T00:00:00.000Z",
    redact: (t) => { seen.push(t); return "REDACTED"; },
  });
  assert.deepEqual(seen, [JSON.stringify({
    source: "etsy",
    extracted_at: "2026-11-05T00:00:00.000Z",
    redact: "on",
    method: METHOD,
    conversations: [],
  }, null, 1)]);
  assert.equal(out, "REDACTED", "the redact fn's return value is the result");
});

test("serializePayload: a state that contradicts the function throws instead of mislabelling the file", () => {
  // "on" with no guard would claim a redaction that never ran
  assert.throws(
    () => serializePayload([], { redactState: "on" }),
    /redact state "on" without a redact function — not saving a mislabelled export/,
  );
  assert.throws(() => serializePayload([], { redactState: "on", redact: undefined }), /without a redact function/);
  // a guard with an off state would hide one that did
  assert.throws(
    () => serializePayload([], { redactState: "off (etsyRedact config incomplete)", redact: (t) => t }),
    /redact state "off \(etsyRedact config incomplete\)" with a redact function/,
  );
  // the consistent pairs still serialize
  assert.doesNotThrow(() => serializePayload([], { redactState: "on", redact: (t) => t }));
  assert.doesNotThrow(() => serializePayload([], { redactState: "off (no etsyRedact config)" }));
});

test("serializePayload: an explicit redactState override goes into the field verbatim", () => {
  const out = serializePayload([], {
    extractedAt: "2026-11-05T00:00:00.000Z",
    redactState: "off (etsyRedact config incomplete)",
  });
  assert.equal(JSON.parse(out).redact, "off (etsyRedact config incomplete)");
  // redact absent: identity passthrough
  assert.equal(out, JSON.stringify({
    source: "etsy",
    extracted_at: "2026-11-05T00:00:00.000Z",
    redact: "off (etsyRedact config incomplete)",
    method: METHOD,
    conversations: [],
  }, null, 1));
});

test("serializePayload: the default extracted_at is a real ISO instant", () => {
  const extractedAt = JSON.parse(serializePayload([])).extracted_at;
  assert.ok(!Number.isNaN(Date.parse(extractedAt)));
  assert.match(extractedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("outputName is the dated filename the script always made", () => {
  assert.equal(outputName(new Date("2026-11-05T14:12:00Z")), "etsy-conversations-2026-11-05.json");
  // a second date, so a hardcoded filename can't ride the day this pin was written
  assert.equal(outputName(new Date("2026-01-31T00:30:00Z")), "etsy-conversations-2026-01-31.json");
});

test("the registry matches etsy.com on any path, and nothing else", () => {
  assert.equal(match("https://www.etsy.com/messages/123").id, "etsy");
  assert.equal(match("https://www.etsy.com/").id, "etsy");
  assert.equal(match("https://etsy.com/x").id, "etsy");
  assert.equal(match("https://ebay.com/"), null);
});

test("the etsy command is wired in the popup", () => {
  assert.equal(typeof COMMANDS.etsy.messages, "function");
});

test("the manifest carries the etsy host permission and the storage permission", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.host_permissions.includes("https://www.etsy.com/*"));
  assert.ok(manifest.permissions.includes("storage"));
});

// the loud-state decision, pinned pure: the page's config branch only relays these
// strings, so what a file says in its redact field is decided here
const VALID = { name: "janedoe", short: "jane", firstSounds: "jgy" };

test("redactStateFor: no config is the loud no-config off; the valid config is on", () => {
  assert.equal(redactStateFor(undefined), "off (no etsyRedact config)");
  assert.equal(redactStateFor(null), "off (no etsyRedact config)");
  assert.equal(redactStateFor({ ...VALID }), "on");
});

test("redactStateFor: each guard precondition broken is the incomplete off", () => {
  // an uppercase name is not the all-lowercase field the guard's classes are built from
  assert.equal(redactStateFor({ ...VALID, name: "JaneDoe" }), "off (etsyRedact config incomplete)");
  // the short form must share the name's first letter
  assert.equal(redactStateFor({ ...VALID, short: "djane" }), "off (etsyRedact config incomplete)");
  // the first-sound set must start with the name's first letter
  assert.equal(redactStateFor({ ...VALID, firstSounds: "gy" }), "off (etsyRedact config incomplete)");
  // every field must be plain lowercase ASCII: a regex-unsafe character would corrupt
  // the guard's classes
  assert.equal(redactStateFor({ ...VALID, firstSounds: "g-y" }), "off (etsyRedact config incomplete)");
  assert.equal(redactStateFor({ ...VALID, short: "ja]ne" }), "off (etsyRedact config incomplete)");
  // a non-string field is not a config the guard can build from
  assert.equal(redactStateFor({ name: 5, short: "jane", firstSounds: "jgy" }), "off (etsyRedact config incomplete)");
});

test("serializePayload: a passed-but-undefined redact with no state says off, identity output", () => {
  const expected = {
    source: "etsy",
    extracted_at: "2026-11-05T00:00:00.000Z",
    redact: "off (no etsyRedact config)",
    method: METHOD,
    conversations: [],
  };
  const out = serializePayload([], { extractedAt: "2026-11-05T00:00:00.000Z", redact: undefined });
  assert.equal(JSON.parse(out).redact, "off (no etsyRedact config)");
  assert.deepEqual(JSON.parse(out), expected);
  assert.equal(out, JSON.stringify(expected, null, 1), "identity output: the string is untouched");
});

test("parsesAsJson: real JSON is true, junk is false", () => {
  assert.equal(parsesAsJson('{"a":1}'), true);
  assert.equal(parsesAsJson("nope"), false);
});

test("parsesAsJson: serializePayload's own identity output parses", () => {
  const out = serializePayload([], { extractedAt: "2026-11-05T00:00:00.000Z" });
  assert.equal(parsesAsJson(out), true);
});

// The whole-blob seam pin: a message text whose newline sits right before an email
// bearing the config's own name used to make the guard's match start on the JSON escape
// letter, leaving a dangling backslash. With pastEscape in the guard, the escape stays
// intact and the redacted payload parses as JSON.
// (The newline is built fromCharCode so the source carries no escape to mis-transcribe.)
test("parsesAsJson: a newline before a name-bearing email stays valid JSON after redaction", () => {
  const newline = String.fromCharCode(10);
  const text = `Email me:${newline}betsy@gmail.com`;
  const convo = {
    id: "111",
    url: "https://www.etsy.com/messages/111",
    pages: 1,
    messages: [{ conversation_message_id: 1, create_date: 0, message_order: 0, text }],
  };
  const out = serializePayload([convo], {
    extractedAt: "2026-11-05T00:00:00.000Z",
    redact: makeRedact({ name: "betsy", short: "bpt", firstSounds: "bpt" }),
  });
  assert.equal(parsesAsJson(out), true);
  assert.equal(JSON.parse(out).conversations[0].messages[0].text, `Email me:${newline}[email redacted]`);
});

test("the manifest grants the bare etsy.com host the registry already matches", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.host_permissions.includes("https://etsy.com/*"));
});

test("the etsy open carries the matched tab's id as a query; a tabless call opens the page bare", async () => {
  const created = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test-extension-id/${p}` },
  };
  const fake = { create: async (o) => { created.push(o.url); return { id: 99 }; } };
  assert.equal(await COMMANDS.etsy.messages({ id: 5 }, { tabs: fake }), "Opened the Etsy page.");
  assert.equal(created.length, 1);
  assert.ok(created[0].endsWith("/src/modules/etsy/page.html?tab=5"), created[0]);
  assert.equal(await COMMANDS.etsy.messages(undefined, { tabs: fake }), "Opened the Etsy page.");
  assert.equal(created.length, 2);
  assert.ok(created[1].endsWith("/src/modules/etsy/page.html"), created[1]);
  assert.ok(!created[1].includes("?"), created[1]);
});

test("redactionCollisions: a name one edit from Etsy's own words or payload keys reaches them; a clean one does not", () => {
  const colliding = redactionCollisions(makeRedact({ name: "betsy", short: "bpt", firstSounds: "bpt" }));
  assert.deepEqual(colliding, ["etsy", "www.etsy.com", "https://www.etsy.com/messages/123456"]);
  assert.deepEqual(redactionCollisions(makeRedact({ name: "paige", short: "pai", firstSounds: "p" })), ["pages"]);
  assert.deepEqual(redactionCollisions(makeRedact({ ...VALID })), []);
  assert.deepEqual(redactionCollisions((s) => s), []);
  assert.deepEqual(redactionCollisions(() => "[redacted]"), [
    "etsy",
    "www.etsy.com",
    "https://www.etsy.com/messages/123456",
    "source",
    "extracted_at",
    "redact",
    "method",
    "conversations",
    "id",
    "url",
    "pages",
    "messages",
    "error",
    "conversation_message_id",
    "create_date",
    "message_order",
    "truncated",
    "empty",
  ]);
});

test("redactLineFor: on is quiet unless a name collides; a collision, both off states and an unknown state warn", () => {
  assert.deepEqual(redactLineFor("on"), { text: "Redact: on.", cls: "" });
  assert.deepEqual(redactLineFor("on", []), { text: "Redact: on.", cls: "" });
  assert.deepEqual(redactLineFor("on", ["etsy", "pages"]), {
    text: "Redact: on. This name also matches Etsy's own words or the export's field names (etsy, pages) — those read [redacted] in the export, and a redacted field name changes the file's shape.",
    cls: "warn",
  });
  assert.deepEqual(redactLineFor("off (etsyRedact config incomplete)"), {
    text: "Redact: off — config invalid (needs lowercase name and short sharing the first letter, and firstSounds starting with it); the export is unredacted.",
    cls: "warn",
  });
  assert.deepEqual(redactLineFor("off (no etsyRedact config)"), {
    text: "Redact: off — no etsyRedact config; the export is unredacted.",
    cls: "warn",
  });
  // wired to redactStateFor's own outputs: a renamed state string can't fall through to
  // the wrong off line
  assert.equal(redactLineFor(redactStateFor(undefined)).text, "Redact: off — no etsyRedact config; the export is unredacted.");
  assert.match(redactLineFor(redactStateFor({ name: "X" })).text, /^Redact: off — config invalid/);
  assert.equal(redactLineFor(redactStateFor({ ...VALID })).text, "Redact: on.");
  // a state added later without its own line names itself and warns, claiming nothing
  // about what the export holds (it could be a partial "on")
  for (const state of ["off (some new reason)", "on (partial)"]) {
    assert.deepEqual(redactLineFor(state), {
      text: `Redact: ${state} — this page has no description for that state; check the export before sharing it.`,
      cls: "warn",
    });
  }
});

test("redactSetup: the page's own chain — state, guard only when on, and the line", () => {
  // a colliding config's hits reach the warning, and the guard it hands back is live
  const betsy = { name: "betsy", short: "bpt", firstSounds: "bpt" };
  const on = redactSetup(betsy);
  assert.equal(on.redactState, "on");
  assert.equal(typeof on.redact, "function");
  assert.notEqual(on.redact("betsy"), "betsy");
  assert.deepEqual(on.line, {
    text: "Redact: on. This name also matches Etsy's own words or the export's field names (etsy, www.etsy.com, https://www.etsy.com/messages/123456) — those read [redacted] in the export, and a redacted field name changes the file's shape.",
    cls: "warn",
  });
  assert.deepEqual(redactSetup({ ...VALID }).line, { text: "Redact: on.", cls: "" });
  // both off states: no guard, and the matching loud line
  for (const [stored, start] of [[undefined, "Redact: off — no etsyRedact config"], [{ name: "X" }, "Redact: off — config invalid"]]) {
    const off = redactSetup(stored);
    assert.equal(off.redact, undefined);
    assert.ok(off.line.text.startsWith(start), off.line.text);
    assert.equal(off.line.cls, "warn");
  }
});

test("finishMessage: ok class only when saved, no errors, redact on, and JSON sound; warn otherwise", () => {
  const cleanConvo = { id: "111", messages: [msg(1), msg(2)] };
  const errConvo = { id: "222", messages: [msg(3)], error: "HTTP 500 at offset 0" };
  const filename = "etsy-conversations-2026-11-05.json";

  assert.deepEqual(
    finishMessage({ saved: true, conversations: [cleanConvo], filename, redactState: "on", sound: true }),
    { text: "Saved 1 conversation, 2 messages. Redact: on.", cls: "ok" },
  );

  // conversation errors force warn and name the error count
  assert.deepEqual(
    finishMessage({ saved: true, conversations: [cleanConvo, errConvo], filename, redactState: "on", sound: true }),
    { text: "Saved 2 conversations, 3 messages, 1 with errors (listed in the file). Redact: on.", cls: "warn" },
  );

  // unguarded exports (either off state) force warn even with zero conversation errors
  for (const redactState of ["off (no etsyRedact config)", "off (etsyRedact config incomplete)"]) {
    assert.deepEqual(
      finishMessage({ saved: true, conversations: [cleanConvo], filename, redactState, sound: true }),
      { text: `Saved 1 conversation, 2 messages. Redact: ${redactState}.`, cls: "warn" },
    );
  }

  // an unparseable redacted output forces warn and appends the do-not-share warning
  assert.deepEqual(
    finishMessage({ saved: true, conversations: [cleanConvo], filename, redactState: "on", sound: false }),
    {
      text: "Saved 1 conversation, 2 messages. Redact: on. The redacted file does NOT parse as JSON — do not share it, and report it. It was saved beside any earlier export of the day, not over it.",
      cls: "warn",
    },
  );
  // a no-word save of an unsound file carries the same warning: its late end may never be said
  const lateUnsound = finishMessage({ saved: null, conversations: [cleanConvo], filename, redactState: "on", sound: false });
  assert.deepEqual(
    lateUnsound,
    {
      text: "No word from Chrome in 15 minutes — the save may still be running; keep this tab open and this line will say how it ends. Redact: on. The redacted file does NOT parse as JSON — do not share it, and report it. It is being saved beside any earlier export of the day, not over it.",
      cls: "warn",
    },
  );

  // interrupted/refused (false) and no-word (null) saves always warn
  assert.deepEqual(
    finishMessage({ saved: false, conversations: [cleanConvo], filename, redactState: "on", sound: true }),
    {
      text: `The download didn't finish — Chrome interrupted or refused it, and ${filename} was not saved. See Chrome's downloads. Redact: on.`,
      cls: "warn",
    },
  );
  assert.deepEqual(
    finishMessage({ saved: null, conversations: [cleanConvo], filename, redactState: "on", sound: true }),
    {
      text: "No word from Chrome in 15 minutes — the save may still be running; keep this tab open and this line will say how it ends. Redact: on.",
      cls: "warn",
    },
  );
});

test("finishMessage: the seq === runSeq guard drops a stale run's late finish and keeps the current run's", () => {
  const cleanConvo = { id: "111", messages: [msg(1)] };
  const filename = "etsy-conversations-2026-11-05.json";
  assert.equal(
    finishMessage({ saved: true, conversations: [cleanConvo], filename, redactState: "on", sound: true, seq: 1, runSeq: 2 }),
    null,
  );
  assert.deepEqual(
    finishMessage({ saved: true, conversations: [cleanConvo], filename, redactState: "on", sound: true, seq: 2, runSeq: 2 }),
    { text: "Saved 1 conversation, 1 message. Redact: on.", cls: "ok" },
  );
});

test("conflictActionFor: a sound export overwrites the same-day file, an unsound one lands beside it", () => {
  assert.equal(conflictActionFor(true), "overwrite");
  assert.equal(conflictActionFor(false), "uniquify");
});

test("page.js wires the pure decisions: finishMessage and conflictActionFor are what it calls", () => {
  const src = readFileSync(new URL("../src/modules/etsy/page.js", import.meta.url), "utf8");
  assert.match(src, /conflictAction: conflictActionFor\(sound\)/);
  // onLate no longer checks the run itself: finish handing seq and runSeq to
  // finishMessage is what drops a stale run's late end, so both names are pinned
  assert.match(src, /finishMessage\(\{[^}]*\bseq\b[^}]*\}\)/);
  assert.match(src, /finishMessage\(\{[^}]*\brunSeq\b[^}]*\}\)/);
  // the redact setup and the failure list come from the pure helpers, not inline copies
  assert.match(src, /= redactSetup\(stored\);/);
  assert.match(src, /failures\(failureLines\(conversations\)\)/);
  assert.doesNotMatch(src, /redactionCollisions|redactLineFor|makeRedact/);
  // the progress line counts through the same plural as the finish line
  assert.match(src, /\$\{counted\(seenSize, "message"\)\} — keep this tab open/);
  assert.equal(counted(1, "message"), "1 message");
  assert.equal(counted(0, "message"), "0 messages");
  assert.equal(counted(2, "conversation"), "2 conversations");
  // the redact line is cleared when a run starts and when a run throws
  // (comment lines are stripped first, so a commented-out hide doesn't count; each hide
  // is pinned to its place: right after the failures reset, and first in the catch)
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.equal([...code.matchAll(/redactLine\.hidden = true;/g)].length, 2);
  assert.match(code, /const seq = \+\+runSeq;\s*failures\(\[\]\);\s*redactLine\.hidden = true;/, "cleared as the run starts");
  assert.match(code, /\} catch \(err\) \{\s*redactLine\.hidden = true;/, "cleared first thing in the run's catch");
  // a download Chrome refuses outright frees its blob URL before the run's catch narrates it
  assert.match(code, /saved = await trackDownload\([\s\S]*?\} catch \(err\) \{\s*URL\.revokeObjectURL\(blobUrl\);\s*throw err;\s*\}/);
});

test("finishMessage + failureLines: an empty answer and a capped walk warn and are listed", () => {
  const clean = { id: "111", messages: [msg(1)] };
  const empty = { id: "222", messages: [] };
  const capped = { id: "333", messages: [msg(2), msg(3)], truncated: true };
  const errored = { id: "444", messages: [], error: "HTTP 500 at offset 0" };
  const filename = "etsy-conversations-2026-11-05.json";
  assert.deepEqual(
    finishMessage({ saved: true, conversations: [clean, empty], filename, redactState: "on", sound: true }),
    { text: "Saved 2 conversations, 1 message, 1 with no messages (wrong id?). Redact: on.", cls: "warn" },
  );
  assert.deepEqual(
    finishMessage({ saved: true, conversations: [clean, capped], filename, redactState: "on", sound: true }),
    { text: "Saved 2 conversations, 3 messages, 1 stopped at the page cap (older messages may be missing). Redact: on.", cls: "warn" },
  );
  // an errored conversation with no messages counts once, as an error, not also as empty
  assert.deepEqual(
    finishMessage({ saved: true, conversations: [clean, errored], filename, redactState: "on", sound: true }),
    { text: "Saved 2 conversations, 1 message, 1 with errors (listed in the file). Redact: on.", cls: "warn" },
  );
  assert.deepEqual(failureLines([clean, empty, capped, errored]), [
    "222: no messages — check the id",
    "333: stopped at the page cap — older messages may be missing",
    "444: HTTP 500 at offset 0",
  ]);
  assert.deepEqual(failureLines([clean]), []);
});
