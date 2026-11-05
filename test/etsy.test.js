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

const { messagesIn, parseIds, collectConversations, serializePayload, outputName, redactStateFor, redactionCollisions }
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
  // the fetch rides the page's session, asking Etsy for JSON
  assert.deepEqual(fetch.calls[0].opts, { credentials: "include", headers: { accept: "application/json" } });
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

test("messages sort by create_date asc, ties by message_order asc, missing create_date as 0", async () => {
  const pages = [[msg(1, 100, 2), msg(2, 100, 1), msg(3, 50, 0), msg(4)], []];
  const fetch = standIn({ [url("111")]: (n) => pages[n] });
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {} });
  assert.deepEqual(convos[0].messages.map((m) => m.conversation_message_id), [4, 3, 2, 1]);
});

test("the page cap stops the walk with no error", async () => {
  let n = 0;
  const fetch = standIn({ [url("111")]: () => [msg(++n)] }); // every page brings something new
  const convos = await collectConversations(["111"], { fetch, sleep: async () => {}, maxPages: 5 });
  assert.equal(convos[0].pages, 5);
  assert.equal(fetch.calls.length, 5);
  assert.equal(convos[0].error, undefined);
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

test("redactionCollisions: a name one edit from Etsy's own words reaches them; a clean one does not", () => {
  const colliding = redactionCollisions(makeRedact({ name: "betsy", short: "bpt", firstSounds: "bpt" }));
  assert.deepEqual(colliding, ["etsy", "www.etsy.com", "https://www.etsy.com/messages/123456"]);
  assert.deepEqual(redactionCollisions(makeRedact({ ...VALID })), []);
  assert.deepEqual(redactionCollisions((s) => s), []);
});
