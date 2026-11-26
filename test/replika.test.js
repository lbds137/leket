// src/modules/replika/: the protocol, the record builders and a full save, run under
// node with a fake fetch, a fake socket and an injected sleep. The centerpiece is the
// leak test: a whole run whose raw objects carry the auth token, the user id, the device
// id, the chat id and two signed media URLs in message fields, unknown extra fields,
// error bodies and a rejecting fetch — none of which may reach data.json, index.html,
// any reason line, the problem lines or the console.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SignedOut, headers, call, readReplikaAuth, readDiary, readMemories,
  createHistoryPager, readHistory, signedImageUrl, usableMediaUrl, replikaPictureUrl,
  HISTORY_SOCKET, HISTORY_NO_LIST, HISTORY_NO_DATE, HISTORY_STUCK, HISTORY_CLOSED,
  HISTORY_SILENT, DIARY_PARTIAL, DIARY_DAYS_SKIPPED, DIARY_STUCK, DIARY_PAGE_CAP, MEMORY_V14_PARTIAL, MEMORY_V15_PARTIAL,
  MEDIA_LINK_UNUSABLE, MEDIA_VOICE_LINK_UNUSABLE, MEDIA_FETCH_FAILED, MEDIA_HOST_NOT_REPLIKA,
} from "../src/modules/replika/api.js";
import {
  buildMessage, buildDiary, buildFact, tallyUnknown, makeMediaNamer, safeId, extFor,
  collectMedia, runSave, buildZip, saveName, downloadOptions, problems, endLine, render,
  MSG_ALLOWED, DIARY_LIST_ALLOWED, DIARY_DAY_ALLOWED, FACT_ALLOWED, MEDIA_SIGN_FAILED, STEP_FAILED,
} from "../src/modules/replika/save.js";
import { md5 } from "../src/lib/md5.js";
import { crc32 } from "../src/lib/zip.js";

const instant = async () => {}; // the injected sleep: retries test their order, not their seconds
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const bytes = (buf, type) => new Response(buf, { status: 200, headers: { "content-type": type } });

// a fetchFn over a route table; the calls it saw are pinned afterwards
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const route = routes(url, init || {}, calls.length);
    if (typeof route === "function") return route();
    return route;
  };
  fn.calls = calls;
  return fn;
}

// a WebSocket stand-in. History replies answer sends in order (an array is a reply's
// messages, an object with event_name "history" goes verbatim, null sends nothing,
// "close" fires the close event, "error" the error event). Any OTHER event arrives on
// its own, fired at construction — the way a live socket interleaves events with the
// replies, so an ignored event never eats a reply slot. Dispatches through onmessage AND
// addEventListener, matching what readHistory may use.
function fakeSocketClass(batches) {
  const sockets = [];
  const isEvent = (b) => b != null && typeof b === "object" && !Array.isArray(b) && b.event_name !== "history";
  const replies = batches.filter((b) => !isEvent(b));
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = {};
      sockets.push(this);
      for (const b of batches) {
        if (isEvent(b)) queueMicrotask(() => this.fire({ data: JSON.stringify(b) }));
      }
    }
    fire(frame) {
      if (frame.data !== undefined) {
        if (this.onmessage) this.onmessage(frame);
        for (const f of this.listeners.message || []) f(frame);
      }
      for (const f of this.listeners[frame.kind] || []) f({});
    }
    send(text) {
      this.sent.push(JSON.parse(text));
      const batch = replies[Math.min(this.sent.length - 1, replies.length - 1)];
      if (batch === null || batch === undefined) return;
      queueMicrotask(() => {
        if (batch === "close" || batch === "error") return this.fire({ kind: batch });
        const payload = Array.isArray(batch) ? { event_name: "history", payload: { messages: batch } } : batch;
        this.fire({ data: JSON.stringify(payload) });
      });
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    close() { this.closed = true; }
  }
  FakeWebSocket.sockets = sockets;
  return FakeWebSocket;
}

const AUTH = {
  userId: "uid-424242", deviceId: "dev-987654", authToken: "fake-token-1234",
  chatId: "chat-31337", userName: "Ada Example", botName: "Echo",
};
// what the REST seam costs per call: the four headers with the fixed-prefix hash
const DIARY_LIST_URL = "https://my.replika.com/api/mobile/1.5/diaries";
const LIST_URL = (until) => `${DIARY_LIST_URL}?limit=100${until ? `&until=${encodeURIComponent(until)}` : ""}`;
const DAY_URL = (date) => `${DIARY_LIST_URL}/${date}`;
const REST_URL = LIST_URL();
const MEMORY_14 = "https://my.replika.ai/api/mobile/1.4/memory";
const MEMORY_15 = "https://my.replika.com/api/mobile/1.5/memory/v3/";
const GET_URL = "https://my.replika.ai/api/mobile/1.5/images/signed/actions/get_url";

// ---------- readReplikaAuth ----------

function withStorage(store, run) {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null) };
  try {
    return run();
  } finally {
    if (saved === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = saved;
  }
}

test("readReplikaAuth reads the three keys and answers the whole auth", () => {
  withStorage({
    auth: JSON.stringify({ userId: AUTH.userId, deviceId: AUTH.deviceId, authToken: AUTH.authToken }),
    ws: JSON.stringify({ chatId: AUTH.chatId }),
    profile: JSON.stringify({ userProfile: { first_name: "Ada Example" }, bot: { name: "Echo" } }),
  }, () => {
    const probe = readReplikaAuth();
    assert.deepEqual(probe, {
      ok: true,
      missing: [],
      auth: { ...AUTH },
    });
  });
});

test("readReplikaAuth: a missing auth or ws is not signed in; a missing profile only costs the names", () => {
  withStorage({ ws: JSON.stringify({ chatId: "c" }) }, () => {
    const probe = readReplikaAuth();
    assert.equal(probe.ok, false);
    assert.ok(probe.missing.includes("auth"));
  });
  withStorage({ auth: JSON.stringify({ userId: "u", deviceId: "d", authToken: "t" }) }, () => {
    const probe = readReplikaAuth();
    assert.equal(probe.ok, false);
    assert.deepEqual(probe.missing, ["ws", "profile"]);
  });
  withStorage({}, () => {
    const probe = readReplikaAuth();
    assert.equal(probe.ok, false);
    assert.deepEqual(probe.missing, ["auth", "ws", "profile"]);
  });
  withStorage({
    auth: JSON.stringify({ userId: "u", deviceId: "d", authToken: "t" }),
    ws: JSON.stringify({ chatId: "c" }),
  }, () => {
    const probe = readReplikaAuth();
    assert.equal(probe.ok, true); // profile missing alone does not fail the run
    assert.deepEqual(probe.missing, ["profile"]);
    assert.equal(probe.auth.userName, null);
    assert.equal(probe.auth.botName, null);
  });
});

test("readReplikaAuth: an unparsable key, a non-object, or an auth without its token counts as missing", () => {
  for (const bad of ["not json", JSON.stringify("a string"), "42"]) {
    withStorage({ auth: bad, ws: JSON.stringify({ chatId: "c" }) }, () => {
      const probe = readReplikaAuth();
      assert.equal(probe.ok, false, bad);
      assert.ok(probe.missing.includes("auth"));
    });
  }
  withStorage({ auth: JSON.stringify({ userId: "u", deviceId: "d" }), ws: JSON.stringify({ chatId: "c" }) }, () => {
    const probe = readReplikaAuth();
    assert.equal(probe.ok, false); // no authToken: not signed in
    assert.ok(probe.missing.includes("auth"));
  });
  withStorage({ auth: JSON.stringify({ userId: "u", deviceId: "d", authToken: "t" }), ws: "not json", profile: "]" }, () => {
    const probe = readReplikaAuth();
    assert.equal(probe.ok, false);
    assert.deepEqual(probe.missing, ["ws", "profile"]);
  });
});

// ---------- headers and call ----------

test("headers carries the four REST headers, and the hash is the md5 of the fixed prefix and the device id", () => {
  const h = headers(AUTH);
  assert.equal(h["x-user-id"], AUTH.userId);
  assert.equal(h["x-auth-token"], AUTH.authToken);
  assert.equal(h["x-device-id"], AUTH.deviceId);
  assert.equal(h["x-timestamp-hash"], md5(`time_covfefe_prefix=2020_${AUTH.deviceId}`));
  assert.ok(/^[0-9a-f]{32}$/.test(h["x-timestamp-hash"]));
  assert.equal(h["content-type"], undefined); // GET callers carry no content-type
  assert.equal(headers(AUTH, true)["content-type"], "application/json");
});

test("call parses 2xx JSON and fetches with credentials omitted", async () => {
  const fn = fakeFetch(() => reply({ hello: "world" }));
  const out = await call(REST_URL, { auth: AUTH, fetchFn: fn, sleep: instant });
  assert.deepEqual(out, { hello: "world" });
  assert.equal(fn.calls[0].init.credentials, "omit");
  assert.equal(fn.calls[0].init.headers["x-auth-token"], AUTH.authToken);
  assert.equal(fn.calls[0].init.headers["content-type"], undefined);
});

test("call turns 401 and 403 into SignedOut with the fixed sign-in message, with no retry", async () => {
  for (const status of [401, 403]) {
    const fn = fakeFetch(() => reply({ detail: "no" }, status));
    await assert.rejects(
      () => call(REST_URL, { auth: AUTH, fetchFn: fn, sleep: instant }),
      (e) => {
        assert.ok(e instanceof SignedOut, "a SignedOut, not a plain Error");
        assert.equal(e.message, "Replika answered 401/403: sign in again on Replika and rerun");
        assert.equal(fn.calls.length, 1); // retrying cannot sign in
        return true;
      },
    );
  }
});

test("call retries 429 and 5xx with 2 s, 4 s, 8 s on the injected sleep, then throws the fixed message", async () => {
  const sleeps = [];
  const backoff = (ms) => { sleeps.push(ms); return instant(); };
  const fn = fakeFetch(() => reply({ boom: "fake-token-1234" }, 500));
  await assert.rejects(
    () => call(REST_URL, { auth: AUTH, fetchFn: fn, sleep: backoff }),
    (e) => {
      // the body's secret never rides an error message
      assert.equal(e.message, "Replika answered HTTP 500");
      assert.ok(!e.message.includes("fake-token-1234"));
      assert.ok(!e.message.includes(REST_URL), "no URL in the message");
      return true;
    },
  );
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
  assert.equal(fn.calls.length, 4);
});

test("call retries a network error and then throws exactly 'network error', not the fetch's own message", async () => {
  const fn = fakeFetch(() => { throw new Error(`socket hangup with fake-token-1234 at ${REST_URL}`); });
  await assert.rejects(
    () => call(REST_URL, { auth: AUTH, fetchFn: fn, sleep: instant }),
    (e) => {
      assert.equal(e.message, "network error");
      assert.ok(!e.message.includes("fake-token-1234") && !e.message.includes(REST_URL));
      return true;
    },
  );
});

test("call sends a POST body as JSON with the content-type, and throws at once on other statuses", async () => {
  const fn = fakeFetch(() => reply([{ id: "d1" }]));
  const out = await call(DAY_URL("2026-02-01"), { method: "POST", body: { ids: ["d1"] }, auth: AUTH, fetchFn: fn, sleep: instant });
  assert.deepEqual(out, [{ id: "d1" }]);
  assert.deepEqual(fn.calls[0].body, { ids: ["d1"] });
  assert.equal(fn.calls[0].init.headers["content-type"], "application/json");
  const fn2 = fakeFetch(() => reply({}, 404));
  await assert.rejects(
    () => call(REST_URL, { auth: AUTH, fetchFn: fn2, sleep: instant }),
    (e) => e.message === "Replika answered HTTP 404",
  );
  assert.equal(fn2.calls.length, 1);
});

// ---------- readDiary ----------

// a list item as the web app's list answers it, and a day as its detail call answers it
const li = (date, title = null) => ({ date, diary_entry_id: `x-${date}`, image_count: 0, read: true, title });
const dayOf = (date, entries = [{ id: `e-${date}`, diary_id: "dd", text: `text of ${date}`, timestamp: `${date}T09:00:00Z`, read: true, image_count: 0, images: [] }]) => ({ date, entries });
const diaryRoutes = (pages, days = {}) => (url) => {
  for (const [until, items] of Object.entries(pages)) if (url === LIST_URL(until || null)) return reply(items);
  for (const [date, day] of Object.entries(days)) if (url === DAY_URL(date)) return reply(day);
  throw new Error(`unexpected ${url}`);
};

test("readDiary pages the list back by date until an empty array, then fetches each day oldest first", async () => {
  const fn = fakeFetch(diaryRoutes(
    { "": [li("2026-02-03", "Third"), li("2026-02-02")], "2026-02-02": [li("2026-02-01", "First")], "2026-02-01": [] },
    { "2026-02-01": dayOf("2026-02-01"), "2026-02-02": dayOf("2026-02-02"), "2026-02-03": dayOf("2026-02-03") },
  ));
  const { days, list, partial, signedOut } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, null);
  assert.equal(signedOut, false);
  assert.deepEqual(list.map((i) => i.date), ["2026-02-03", "2026-02-02", "2026-02-01"]);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01", "2026-02-02", "2026-02-03"]);
  assert.deepEqual(fn.calls.map((c) => c.url), [
    LIST_URL(), LIST_URL("2026-02-02"), LIST_URL("2026-02-01"),
    DAY_URL("2026-02-01"), DAY_URL("2026-02-02"), DAY_URL("2026-02-03"),
  ]);
  for (const c of fn.calls) assert.equal(c.init.method, "GET");
});

test("readDiary: `until` is the oldest date of the previous page, URL-encoded", async () => {
  // a page not in date order: the oldest date, not the first or last item, is the cursor
  const fn = fakeFetch(diaryRoutes(
    { "": [li("2026-03-05"), li("2026-03-01"), li("2026-03-03")], "2026-03-01": [] },
    { "2026-03-01": dayOf("2026-03-01"), "2026-03-03": dayOf("2026-03-03"), "2026-03-05": dayOf("2026-03-05") },
  ));
  await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  const listCalls = fn.calls.map((c) => c.url).filter((u) => u.includes("?limit="));
  assert.deepEqual(listCalls, [`${DIARY_LIST_URL}?limit=100`, `${DIARY_LIST_URL}?limit=100&until=${encodeURIComponent("2026-03-01")}`]);
});

test("readDiary: a list item whose date is not YYYY-MM-DD is never requested", async () => {
  const fn = fakeFetch(diaryRoutes(
    { "": [li("2026-02-02"), li("../../etc/passwd"), li("2026-2-1"), { title: "no date" }, li(20260201), null], "2026-02-02": [] },
    { "2026-02-02": dayOf("2026-02-02") },
  ));
  const { days, list, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, null);
  assert.deepEqual(list.map((i) => i.date), ["2026-02-02"]);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-02"]);
  assert.ok(fn.calls.every((c) => !c.url.includes("passwd") && !c.url.includes("2026-2-1")), "no invalid date reaches a URL");
  assert.equal(fn.calls.length, 3); // the first page, the empty page after it, the one valid day
});

test("readDiary: a non-array list reply is a partial failure with nothing read, not a throw", async () => {
  const fn = fakeFetch(() => reply({ nope: true }));
  const { days, list, partial, signedOut } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_PARTIAL);
  assert.equal(signedOut, false);
  assert.equal(list.length, 0);
  assert.equal(days.length, 0);
});

test("readDiary: a non-array list reply after some pages keeps their dates and fetches their days", async () => {
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-02"), li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply({ nope: true });
    if (url === DAY_URL("2026-02-01")) return reply(dayOf("2026-02-01"));
    if (url === DAY_URL("2026-02-02")) return reply(dayOf("2026-02-02"));
    throw new Error(`unexpected ${url}`);
  });
  const { days, list, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_PARTIAL);
  assert.equal(list.length, 2);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01", "2026-02-02"]);
});

test("readDiary: a failed list page after some pages keeps what was read and names a fixed partial reason", async () => {
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-02"), li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply({ detail: "fake-token-1234" }, 500); // the body's secret never surfaces
    if (url === DAY_URL("2026-02-01")) return reply(dayOf("2026-02-01"));
    if (url === DAY_URL("2026-02-02")) return reply(dayOf("2026-02-02"));
    throw new Error(`unexpected ${url}`);
  });
  const { days, partial, signedOut } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_PARTIAL);
  assert.equal(signedOut, false);
  assert.equal(days.length, 2); // the days of the first page were kept
});

test("readDiary: a list that repeats the same page stops as stuck, with no duplicates", async () => {
  const fn = fakeFetch((url) => {
    if (url.startsWith(`${DIARY_LIST_URL}?`)) return reply([li("2026-02-02"), li("2026-02-01")]);
    if (url === DAY_URL("2026-02-01")) return reply(dayOf("2026-02-01"));
    if (url === DAY_URL("2026-02-02")) return reply(dayOf("2026-02-02"));
    throw new Error(`unexpected ${url}`);
  });
  const { days, list, partial, signedOut } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_STUCK);
  assert.equal(signedOut, false);
  assert.equal(list.length, 2);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01", "2026-02-02"]);
  assert.equal(fn.calls.filter((c) => c.url.includes("?limit=")).length, 2); // the first page, then the repeat that proves it
});

test("readDiary: a list that never ends stops at maxPages with its own reason and keeps what was read", async () => {
  // each page holds one day older than the last, forever
  const fn = fakeFetch((url) => {
    if (url.includes("?limit=")) {
      const until = new URL(url).searchParams.get("until");
      const n = until ? Number(until.slice(-2)) - 1 : 28;
      return reply([li(`2026-02-${String(n).padStart(2, "0")}`)]);
    }
    return reply(dayOf(url.slice(url.lastIndexOf("/") + 1)));
  });
  const { days, list, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant, maxPages: 3 });
  assert.equal(partial, DIARY_PAGE_CAP);
  assert.equal(list.length, 3);
  assert.equal(days.length, 3);
});

test("readDiary: a failed day call skips that day, still reads the newer days, and is not a throw", async () => {
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-03"), li("2026-02-02"), li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) return reply(dayOf("2026-02-01"));
    if (url === DAY_URL("2026-02-02")) return reply({ detail: "fake-token-1234" }, 500);
    if (url === DAY_URL("2026-02-03")) return reply(dayOf("2026-02-03"));
    throw new Error(`unexpected ${url}`);
  });
  const { days, list, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_DAYS_SKIPPED);
  assert.equal(list.length, 3);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01", "2026-02-03"]); // the day after the failure is still read
});

test("readDiary: five failed days in a row stop the day calls as a partial diary", async () => {
  const dates = ["2026-02-07", "2026-02-06", "2026-02-05", "2026-02-04", "2026-02-03", "2026-02-02", "2026-02-01"];
  const asked = [];
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply(dates.map((d) => li(d)));
    if (url === LIST_URL("2026-02-01")) return reply([]);
    asked.push(url);
    if (url === DAY_URL("2026-02-01")) return reply(dayOf("2026-02-01"));
    return reply({}, 500);
  });
  const { days, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_PARTIAL);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01"]);
  assert.equal(new Set(asked).size, 6); // the good day, then five failed days (each retried); 2026-02-07 is never asked
});

test("readDiary: a failed list page outranks a skipped day in the partial reason", async () => {
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-02"), li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply({}, 500);
    if (url === DAY_URL("2026-02-01")) return reply({}, 500);
    if (url === DAY_URL("2026-02-02")) return reply(dayOf("2026-02-02"));
    throw new Error(`unexpected ${url}`);
  });
  const { days, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_PARTIAL);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-02"]);
});

test("readDiary: a list reason set earlier still outranks the five-in-a-row stop", async () => {
  const dates = ["2026-02-05", "2026-02-04", "2026-02-03", "2026-02-02", "2026-02-01"];
  const fn = fakeFetch((url) => {
    if (url === LIST_URL() || url === LIST_URL("2026-02-01")) return reply(dates.map((d) => li(d))); // the same page again
    return reply({}, 500);
  });
  const { days, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_STUCK);
  assert.deepEqual(days, []);
});

test("readDiary: rests between day calls, not before the first", async () => {
  const log = [];
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-02"), li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    log.push(url.slice(-10));
    return reply(dayOf(url.slice(-10)));
  });
  await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: async () => { log.push("pause"); } });
  assert.deepEqual(log, ["2026-02-01", "pause", "2026-02-02"]);
});

test("readDiary: a day reply without an entries array counts as a skipped day", async () => {
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    return reply("not a day");
  });
  const { days, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_DAYS_SKIPPED);
  assert.equal(days.length, 0);
});

test("readDiary: the same date twice in one page is listed, requested and recorded once", async () => {
  const fn = fakeFetch(diaryRoutes(
    { "": [li("2026-02-02", "First copy"), li("2026-02-02", "Second copy"), li("2026-02-01")], "2026-02-01": [] },
    { "2026-02-01": dayOf("2026-02-01"), "2026-02-02": dayOf("2026-02-02") },
  ));
  const { days, list, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, null);
  assert.deepEqual(list.map((i) => i.date), ["2026-02-02", "2026-02-01"]);
  assert.equal(list[0].title, "First copy"); // the first item for a date wins
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01", "2026-02-02"]);
  assert.equal(fn.calls.filter((c) => c.url === DAY_URL("2026-02-02")).length, 1);
});

test("readDiary: a page of only newer unseen dates keeps its days but never moves `until` forward", async () => {
  let afterFirst = 0;
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-03-05"), li("2026-03-04")]);
    if (url === LIST_URL("2026-03-04")) return reply(afterFirst++ === 0 ? [li("2026-03-10")] : []);
    if (url.startsWith(`${DIARY_LIST_URL}/`)) return reply(dayOf(url.slice(url.lastIndexOf("/") + 1)));
    throw new Error(`unexpected ${url}`);
  });
  const { days, list, partial } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, null);
  assert.deepEqual(fn.calls.map((c) => c.url).filter((u) => u.includes("?limit=")), [LIST_URL(), LIST_URL("2026-03-04"), LIST_URL("2026-03-04")]);
  assert.deepEqual(list.map((i) => i.date), ["2026-03-05", "2026-03-04", "2026-03-10"]); // the newer day is real: kept
  assert.deepEqual(days.map((d) => d.date), ["2026-03-04", "2026-03-05", "2026-03-10"]);
});

test("readDiary: a day reply for another date counts as a skipped day and keeps the days already read", async () => {
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-02"), li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) return reply(dayOf("2026-02-01"));
    if (url === DAY_URL("2026-02-02")) return reply(dayOf("2026-02-09")); // answers a different day
    throw new Error(`unexpected ${url}`);
  });
  const { days, list, partial, signedOut } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(partial, DIARY_DAYS_SKIPPED);
  assert.equal(signedOut, false);
  assert.equal(list.length, 2);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01"]);
});

test("readDiary: a 401 on the list keeps nothing but names the sign-in reason and marks the step signed out", async () => {
  const fn = fakeFetch(() => reply({}, 401));
  const { days, partial, signedOut } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(signedOut, true);
  assert.equal(partial, "Replika answered 401/403: sign in again on Replika and rerun");
  assert.equal(days.length, 0);
});

test("readDiary: a 401 on a day keeps the days already read and marks the step signed out", async () => {
  const fn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-02"), li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) return reply(dayOf("2026-02-01"));
    return reply({}, 401);
  });
  const { days, list, partial, signedOut } = await readDiary({ auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(signedOut, true);
  assert.equal(partial, "Replika answered 401/403: sign in again on Replika and rerun");
  assert.equal(list.length, 2);
  assert.deepEqual(days.map((d) => d.date), ["2026-02-01"]);
});

test("readMemories reads both endpoints into their three lists", async () => {
  const fn = fakeFetch((url) => {
    if (url === MEMORY_14) return reply({ facts: [{ text: "likes tea", creation_timestamp: "2026-01-05T00:00:00Z" }] });
    if (url === MEMORY_15) return reply({ customer_facts: [{ text: "has a sister" }], robot_facts: [{ text: "Echo remembers walks" }] });
    throw new Error(`unexpected ${url}`);
  });
  const out = await readMemories({ auth: AUTH, fetchFn: fn, sleep: instant });
  assert.equal(out.partial, null);
  assert.equal(out.facts.length, 1);
  assert.equal(out.customerFacts.length, 1);
  assert.equal(out.robotFacts.length, 1);
  assert.ok(fn.calls.some((c) => c.url === MEMORY_14) && fn.calls.some((c) => c.url === MEMORY_15));
});

test("readMemories: one endpoint failing keeps the other's facts and names which part failed", async () => {
  const fn = fakeFetch((url) => (url === MEMORY_14 ? reply({ facts: [{ text: "likes tea" }] }) : reply({}, 503)));
  const out = await readMemories({ auth: AUTH, fetchFn: fn, sleep: instant });
  assert.equal(out.partial, MEMORY_V15_PARTIAL);
  assert.equal(out.facts.length, 1);
  assert.equal(out.customerFacts.length, 0);
  const fn2 = fakeFetch((url) => (url === MEMORY_14 ? reply({}, 500) : reply({ customer_facts: [{ text: "x" }], robot_facts: [] })));
  const out2 = await readMemories({ auth: AUTH, fetchFn: fn2, sleep: instant });
  assert.equal(out2.partial, MEMORY_V14_PARTIAL);
  assert.equal(out2.customerFacts.length, 1);
});

test("readMemories: a reply missing its array is a failure, not an empty list", async () => {
  // the v1.4 reply has no facts array at all; v1.5 answers well so only v1.4 fails
  const fn = fakeFetch((url) => (url === MEMORY_14 ? reply({}) : reply({ customer_facts: [], robot_facts: [] })));
  const out = await readMemories({ auth: AUTH, fetchFn: fn, sleep: instant });
  assert.equal(out.partial, MEMORY_V14_PARTIAL);
  assert.equal(out.facts.length, 0);
  assert.equal(out.customerFacts.length, 0);
});

test("readMemories: both endpoints failing names both; a 401 stops with the sign-in reason", async () => {
  const fn = fakeFetch(() => reply({}, 500));
  const out = await readMemories({ auth: AUTH, fetchFn: fn, sleep: instant });
  assert.ok(out.partial.length > 0 && out.partial !== MEMORY_V14_PARTIAL && out.partial !== MEMORY_V15_PARTIAL);
  const fn2 = fakeFetch(() => reply({}, 403));
  const out2 = await readMemories({ auth: AUTH, fetchFn: fn2, sleep: instant });
  assert.equal(out2.signedOut, true);
  assert.match(out2.partial, /sign in again/);
});

// ---------- the history pager ----------

const msg = (id, at, extra = {}) => ({
  id,
  content: { type: "text", text: `message ${id}` },
  meta: { nature: "Customer", timestamp: at, ...extra },
});

test("the pager's first request carries the auth and no last_message_id; a fresh token rides every request", () => {
  let n = 0;
  const pager = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId, uuid: () => `tok-${++n}` });
  const first = pager.request();
  assert.equal(first.event_name, "history");
  assert.equal(first.token, "tok-1");
  assert.deepEqual(first.auth, { user_id: AUTH.userId, auth_token: AUTH.authToken, device_id: AUTH.deviceId });
  assert.deepEqual(first.payload, { chat_id: AUTH.chatId, limit: 1000 });
  assert.ok(!("last_message_id" in first.payload));
  assert.equal(pager.accept({ event_name: "history", payload: { messages: [msg("a", "2026-01-02T00:00:00Z")] } }).next, true);
  const second = pager.request();
  assert.equal(second.token, "tok-2"); // a fresh uuid per request
  assert.equal(second.payload.last_message_id, "a");
});

test("the cursor is the message with the smallest timestamp in the batch, not messages[0]: a newest-first batch pages from its oldest end", () => {
  const pager = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId });
  // the server sends the batch newest-first, as the API is seen to do
  const batch = [msg("m3", "2026-06-03T10:00:00Z"), msg("m2", "2026-06-02T10:00:00Z"), msg("m1", "2026-06-01T10:00:00Z")];
  const r = pager.accept({ event_name: "history", payload: { messages: batch } });
  assert.deepEqual(r, { next: true });
  assert.equal(pager.request().payload.last_message_id, "m1");
  assert.equal(pager.size(), 3);
});

test("ties on the smallest timestamp keep the first in array order, and an undated message is never the cursor", () => {
  const pager = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId });
  const batch = [msg("t1", "2026-06-01T10:00:00Z"), msg("t2", "2026-06-01T10:00:00Z"), msg("u1", "not a date"), msg("u2", null)];
  assert.deepEqual(pager.accept({ event_name: "history", payload: { messages: batch } }), { next: true });
  assert.equal(pager.request().payload.last_message_id, "t1");
  const pager2 = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId });
  assert.deepEqual(
    pager2.accept({ event_name: "history", payload: { messages: [msg("u1", "garbage"), msg("u2", undefined)] } }),
    { error: HISTORY_NO_DATE },
  );
});

test("a batch that adds nothing unseen, or pages from the same cursor again, trips the stuck guard", () => {
  const pager = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId });
  const batch = [msg("m1", "2026-06-01T10:00:00Z"), msg("m2", "2026-06-02T10:00:00Z")];
  assert.deepEqual(pager.accept({ event_name: "history", payload: { messages: batch } }), { next: true });
  // the server repeats the very same batch: no new message, same cursor — one fixed error
  assert.deepEqual(pager.accept({ event_name: "history", payload: { messages: batch } }), { error: HISTORY_STUCK });
  const pager2 = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId });
  assert.deepEqual(pager2.accept({ event_name: "history", payload: { messages: [msg("m1", "2026-06-01T10:00:00Z")] } }), { next: true });
  // a different-looking batch that still lands on the same cursor is stuck too
  assert.deepEqual(
    pager2.accept({ event_name: "history", payload: { messages: [msg("m1", "2026-06-01T10:00:00Z"), msg("m9", "2026-06-09T00:00:00Z")] } }),
    { error: HISTORY_STUCK },
  );
});

test("messages already seen are not added twice, an empty batch is done, other event names are ignored, and a message list that isn't one is an error", () => {
  const pager = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId });
  assert.deepEqual(pager.accept({ event_name: "ping", payload: {} }), { ignore: true });
  assert.deepEqual(pager.accept({ event_name: "history", payload: {} }), { error: HISTORY_NO_LIST });
  assert.deepEqual(pager.accept({ event_name: "history", payload: { messages: "no" } }), { error: HISTORY_NO_LIST });
  assert.deepEqual(pager.accept(null), { ignore: true });
  assert.deepEqual(pager.accept({ event_name: "history", payload: { messages: [msg("m1", "2026-06-01T00:00:00Z")] } }), { next: true });
  assert.deepEqual(pager.accept({ event_name: "history", payload: { messages: [msg("m1", "2026-06-01T00:00:00Z")] } }), { error: HISTORY_STUCK });
  assert.deepEqual(pager.accept({ event_name: "history", payload: { messages: [] } }), { done: true });
  assert.equal(pager.size(), 1);
});

test("messages() sorts oldest first with undated messages last and stable, whatever order the batches arrived in", () => {
  const pager = createHistoryPager({ auth: AUTH, chatId: AUTH.chatId });
  pager.accept({ event_name: "history", payload: { messages: [msg("new", "2026-06-03T00:00:00Z"), msg("old", "2026-06-01T00:00:00Z")] } });
  pager.accept({ event_name: "history", payload: { messages: [msg("mid", "2026-06-02T00:00:00Z"), msg("u1", "junk"), msg("u2", "also junk")] } });
  assert.deepEqual(pager.messages().map((m) => m.id), ["old", "mid", "new", "u1", "u2"]);
});

// ---------- readHistory over a socket ----------

test("readHistory drives the pager over one socket to done: batches oldest-join into a sorted list", async () => {
  const Socket = fakeSocketClass([
    [msg("m3", "2026-06-03T10:00:00Z"), msg("m1", "2026-06-01T10:00:00Z")],
    [msg("m2", "2026-06-02T10:00:00Z")],
    [],
  ]);
  const seen = [];
  const out = await readHistory({
    auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Socket, timeoutMs: 500, onProgress: (n) => seen.push(n),
  });
  assert.equal(out.partial, null);
  assert.deepEqual(out.messages.map((m) => m.id), ["m1", "m2", "m3"]);
  assert.equal(Socket.sockets[0].url, HISTORY_SOCKET);
  assert.equal(Socket.sockets[0].sent.length, 3);
  assert.ok(!("last_message_id" in Socket.sockets[0].sent[0].payload));
  assert.equal(Socket.sockets[0].sent[1].payload.last_message_id, "m1");
  assert.equal(Socket.sockets[0].sent[2].payload.last_message_id, "m2");
  assert.equal(Socket.sockets[0].closed, true); // closed at done, not left open
  assert.deepEqual(seen, [2, 3, 3]); // the counts rode the progress callback
});

test("readHistory ignores other event names on the way and still finds the history reply", async () => {
  const Socket = fakeSocketClass([
    { event_name: "typing", payload: {} },
    { event_name: "history", payload: { messages: [msg("m1", "2026-06-01T00:00:00Z")] } },
    [],
  ]);
  const out = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Socket, timeoutMs: 500 });
  assert.equal(out.partial, null);
  assert.deepEqual(out.messages.map((m) => m.id), ["m1"]);
});

test("readHistory: a socket that closes or errors before done ends the pass with a fixed reason, keeping what arrived", async () => {
  const Socket = fakeSocketClass([
    [msg("m1", "2026-06-01T00:00:00Z")],
    "close",
  ]);
  const out = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Socket, timeoutMs: 500 });
  assert.equal(out.partial, HISTORY_CLOSED);
  assert.deepEqual(out.messages.map((m) => m.id), ["m1"]);
  const ErrSocket = fakeSocketClass([
    [msg("m1", "2026-06-01T00:00:00Z")],
    "error",
  ]);
  const out2 = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: ErrSocket, timeoutMs: 500 });
  assert.equal(out2.partial, HISTORY_CLOSED);
});

test("readHistory: a socket that never answers goes quiet with the fixed no-reply reason", async () => {
  const Socket = fakeSocketClass([null]);
  const out = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Socket, timeoutMs: 30 });
  assert.equal(out.partial, HISTORY_SILENT);
  assert.deepEqual(out.messages, []);
});

test("readHistory: a socket still connecting (readyState 0) that fires open later completes the history", async () => {
  const Base = fakeSocketClass([[msg("m1", "2026-06-01T00:00:00Z")], []]);
  class Connecting extends Base {
    constructor(url) {
      super(url);
      this.readyState = 0;
      setTimeout(() => { this.readyState = 1; this.fire({ kind: "open" }); }, 5);
    }
  }
  const out = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Connecting, timeoutMs: 1000 });
  assert.equal(out.partial, null);
  assert.deepEqual(out.messages.map((m) => m.id), ["m1"]);
});

test("readHistory: a socket already closed (readyState 3) ends with HISTORY_CLOSED at once, not at the timer", async () => {
  const Base = fakeSocketClass([null]);
  class Closed extends Base {
    constructor(url) { super(url); this.readyState = 3; }
  }
  const started = Date.now();
  const out = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Closed, timeoutMs: 60000 });
  assert.equal(out.partial, HISTORY_CLOSED);
  assert.ok(Date.now() - started < 5000, "it did not wait out the timer");
  assert.equal(Base.sockets[0].sent.length, 0);
});

test("readHistory: a frame arriving after the pass finished is ignored", async () => {
  const Base = fakeSocketClass([[msg("m1", "2026-06-01T00:00:00Z")], []]);
  const out = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Base, timeoutMs: 1000 });
  assert.equal(out.partial, null);
  const sock = Base.sockets[0];
  const sentBefore = sock.sent.length;
  sock.fire({ data: JSON.stringify({ event_name: "history", payload: { messages: [msg("late", "2026-05-01T00:00:00Z")] } }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sock.sent.length, sentBefore, "a late frame sends no further request");
  assert.deepEqual(out.messages.map((m) => m.id), ["m1"]);
});

test("readHistory: a constructor that refuses still answers what it collected", async () => {
  const out = await readHistory({
    auth: AUTH, chatId: AUTH.chatId, timeoutMs: 50,
    WebSocketCtor: class { constructor() { throw new Error("refused"); } },
  });
  assert.equal(out.partial, HISTORY_CLOSED);
  assert.deepEqual(out.messages, []);
});

test("readHistory works over onmessage alone, the way a minimal stand-in speaks", async () => {
  // a stand-in with no addEventListener: readHistory falls back to the on* properties
  const replies = [
    { event_name: "history", payload: { messages: [msg("m1", "2026-06-01T00:00:00Z")] } },
    { event_name: "history", payload: { messages: [] } },
  ];
  let sent = 0;
  const urlSeen = [];
  const Socket = function (url) {
    urlSeen.push(url);
    this.sent = [];
    this.send = (text) => {
      this.sent.push(JSON.parse(text));
      const batch = replies[Math.min(sent++, replies.length - 1)];
      if (batch === null) return;
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(batch) }));
    };
    this.close = () => {};
  };
  const out = await readHistory({ auth: AUTH, chatId: AUTH.chatId, WebSocketCtor: Socket, timeoutMs: 500 });
  assert.equal(out.partial, null);
  assert.deepEqual(out.messages.map((m) => m.id), ["m1"]);
  assert.deepEqual(urlSeen, [HISTORY_SOCKET]);
});

// ---------- the signed media link ----------

test("usableMediaUrl takes https hosts only: no http, no localhost, no IP literal", () => {
  assert.equal(usableMediaUrl("https://s3-us-west-1.amazonaws.com/replika-content-images/pic?sig=x"), true);
  assert.equal(usableMediaUrl("http://signed.example.org/pic"), false);
  assert.equal(usableMediaUrl("https://localhost/pic"), false);
  assert.equal(usableMediaUrl("https://sub.localhost/pic"), false);
  assert.equal(usableMediaUrl("https://127.0.0.1/pic"), false);
  assert.equal(usableMediaUrl("https://93.184.216.34/pic"), false);
  assert.equal(usableMediaUrl("https://[::1]/pic"), false);
  assert.equal(usableMediaUrl("not a url"), false);
});

test("signedImageUrl posts the raw link and answers the signed URL; an unusable reply answers null", async () => {
  const fn = fakeFetch((url, init) => {
    assert.equal(url, GET_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/json");
    const raw = JSON.parse(init.body).image_url;
    return reply({ image_url: raw === "https://cdn.example.org/raw.png" ? "https://s3-us-west-1.amazonaws.com/replika-content-images/p.png?sig=abc" : "http://nope.example.org/x" });
  });
  assert.equal(await signedImageUrl("https://cdn.example.org/raw.png", { auth: AUTH, fetchFn: fn, sleep: instant }), "https://s3-us-west-1.amazonaws.com/replika-content-images/p.png?sig=abc");
  assert.equal(await signedImageUrl("https://cdn.example.org/other.png", { auth: AUTH, fetchFn: fn, sleep: instant }), null);
  const body = fn.calls[0].body;
  assert.deepEqual(body, { image_url: "https://cdn.example.org/raw.png" });
});

// ---------- the record builders ----------

test("buildMessage builds the allowlisted record; a text message keeps its text", () => {
  const { record, media } = buildMessage(msg("m1", "2026-06-01T10:00:00Z"));
  assert.deepEqual(record, { id: "m1", at: "2026-06-01T10:00:00Z", from: "you", kind: "text", text: "message m1" });
  assert.equal(media, null);
  const robot = buildMessage({ ...msg("m2", "2026-06-02T10:00:00Z"), meta: { nature: "Robot", timestamp: "2026-06-02T10:00:00Z" } });
  assert.equal(robot.record.from, "replika");
  const stranger = buildMessage({ ...msg("m3", "2026-06-03T10:00:00Z"), meta: { nature: "Something Else", timestamp: "2026-06-03T10:00:00Z" } });
  assert.equal(stranger.record.from, "unknown");
});

test("buildMessage: an image's raw link and a voice's raw link are never written into the record", () => {
  const pic = buildMessage({ id: "p1", content: { type: "images", text: "https://cdn.example.org/raw-pic.png" }, meta: { nature: "Robot", timestamp: "2026-06-01T00:00:00Z" } });
  assert.equal(pic.record.text, undefined);
  assert.ok(!JSON.stringify(pic.record).includes("raw-pic.png"));
  assert.equal(pic.media.url, "https://cdn.example.org/raw-pic.png"); // travels out of band only
  const voice = buildMessage({ id: "v1", content: { type: "voice_message", voice_message_url: "https://cdn.example.org/clip.m4a" }, meta: { nature: "Customer", timestamp: "2026-06-01T00:00:00Z" } });
  assert.ok(!JSON.stringify(voice.record).includes("clip.m4a"));
  assert.equal(voice.media.url, "https://cdn.example.org/clip.m4a");
});

test("buildMessage: reactions only when an array of strings or numbers sits on the message or its meta", () => {
  const onMeta = buildMessage({ id: "r1", content: { type: "text", text: "x" }, meta: { nature: "Customer", timestamp: "t", reactions: ["❤", 3] } });
  assert.deepEqual(onMeta.record.reactions, ["❤", 3]);
  const onMessage = buildMessage({ id: "r2", content: { type: "text", text: "x" }, reactions: [1, 2], meta: { nature: "Customer", timestamp: "t" } });
  assert.deepEqual(onMessage.record.reactions, [1, 2]);
  assert.equal(buildMessage({ id: "r3", content: { type: "text", text: "x" }, meta: { nature: "Customer", timestamp: "t", reactions: "junk" } }).record.reactions, undefined);
  assert.equal(buildMessage({ id: "r4", content: { type: "text", text: "x" }, meta: { nature: "Customer", timestamp: "t", reactions: [{ who: "x" }] } }).record.reactions, undefined);
});

test("buildMessage: a kind Leket doesn't read is not captured with its type named, escaped only in HTML", () => {
  const { record } = buildMessage({ id: "k1", content: { type: "sticker", payload: "whatever" }, meta: { nature: "Robot", timestamp: "t" } });
  assert.equal(record.kind, "sticker");
  assert.equal(record.not_captured, "Leket doesn't read sticker messages yet");
  const kindless = buildMessage({ id: "k2", content: {}, meta: { nature: "Robot", timestamp: "t" } });
  assert.equal(kindless.record.kind, null);
  assert.equal(kindless.record.not_captured, "Leket doesn't read this message's type yet");
});

test("buildDiary: one record per day, the list item's title, each entry's id, time and text (strings only)", () => {
  const day = { date: "2026-02-01", entries: [
    { id: "e1", timestamp: "2026-02-01T09:00:00Z", text: "one", images: [] },
    { id: 2, timestamp: 5, text: 42 },
    { text: "two" },
    null,
  ] };
  const { record, plans } = buildDiary(day, { date: "2026-02-01", title: "A title", read: true });
  assert.deepEqual(record, { date: "2026-02-01", title: "A title", entries: [
    { id: "e1", at: "2026-02-01T09:00:00Z", text: "one", images: [] },
    { id: 2, at: 5, text: null, images: [] },
    { id: null, at: null, text: "two", images: [] },
  ] });
  assert.deepEqual(plans, []);
  assert.equal(buildDiary(day, null).record.title, null);
  assert.equal(buildDiary(day, { title: 7 }).record.title, null);
  assert.deepEqual(buildDiary(null, null).record, { date: null, title: null, entries: [] });
});

test("buildDiary: each picture is a record plus an out-of-band plan; only blurred and is_romantic booleans are copied", () => {
  const url = "https://cdn.example.org/diary-a.png";
  const { record, plans } = buildDiary({ date: "2026-02-01", entries: [{ id: "e1", text: "t", images: [
    { url, blurred: false, is_romantic: true, extra: "x" },
    { url: "https://cdn.example.org/diary-b.png", blurred: "yes", is_romantic: 1 },
    { blurred: true },
    null,
  ] }] }, null);
  const images = record.entries[0].images;
  assert.deepEqual(images[0], { kind: "images", id: "e1-0", blurred: false, is_romantic: true });
  assert.deepEqual(images[1], { kind: "images", id: "e1-1" });
  assert.deepEqual(images[2], { kind: "images", id: "e1-2", blurred: true, not_captured: MEDIA_LINK_UNUSABLE });
  assert.deepEqual(images[3], { kind: "images", id: "e1-3", not_captured: MEDIA_LINK_UNUSABLE });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].record, images[0]); // the plan mutates the record inside the diary record
  assert.equal(plans[0].url, url);
  assert.ok(!JSON.stringify(record).includes("cdn.example.org"), "the raw link is never in the record");
});

test("buildFact keeps the id when it is there, and `about` comes from the list it was read from", () => {
  assert.deepEqual(buildFact({ id: "f1", text: "likes tea", creation_timestamp: "2026-01-05T00:00:00Z" }, "you"),
    { at: "2026-01-05T00:00:00Z", text: "likes tea", about: "you", id: "f1" });
  assert.deepEqual(buildFact({ text: "no id here" }, null), { at: null, text: "no id here", about: null });
});

// ---------- the unknown-key tally ----------

test("tallyUnknown counts the key paths the builders never read, paths only, arrays as path[]", () => {
  const counts = tallyUnknown([
    { id: "1", content: { type: "text", text: "hi" }, meta: { nature: "Customer", timestamp: "t", extra: "x", nest: { deep: 1, deeper: { leaf: true } }, arr: [1, 2] } },
    { id: "2", content: { type: "text", text: "ho", extra: "y" }, meta: { nature: "Robot", timestamp: "t2" } },
  ], MSG_ALLOWED);
  assert.deepEqual(counts, {
    "meta.extra": 1,
    "meta.nest.deep": 1,
    "meta.nest.deeper.leaf": 1,
    "meta.arr[]": 1,
    "content.extra": 1,
  });
  assert.deepEqual(tallyUnknown([], MSG_ALLOWED), {});
  // a null field is a key path present but unused, with no value in the tally
  assert.deepEqual(tallyUnknown([{ edited_at: null }], new Set([])), { edited_at: 1 });
});

test("tallyUnknown walks arrays: an allowed array counts as read whole, any other has its object items walked", () => {
  // (c) a day whose entry carries diary_id reports it at its real path
  const day = { date: "2026-02-01", entries: [{ id: "e1", diary_id: "d1", text: "t", images: [{ url: "u", blurred: false, extra_img: 1 }] }] };
  assert.deepEqual(tallyUnknown([day], DIARY_DAY_ALLOWED), { "entries[].diary_id": 1, "entries[].images[].extra_img": 1 });
  // the list items only read date and title
  assert.deepEqual(tallyUnknown([li("2026-02-01", "T")], DIARY_LIST_ALLOWED), { diary_entry_id: 1, image_count: 1, read: 1 });
  // a message's reactions (allowed arrays) are read whole: neither the array nor what is inside it is reported
  const msg = { id: "1", reactions: [{ kind: "heart_secret" }], meta: { nature: "Robot", reactions: ["❤"] } };
  assert.deepEqual(tallyUnknown([msg], MSG_ALLOWED), {});
  // a non-object item, an empty array and an unallowed array of objects
  assert.deepEqual(tallyUnknown([{ a: [1, "x"], b: [], c: [{ d: 1 }, { d: 2, e: 3 }] }], new Set([])), { "a[]": 1, "c[].d": 2, "c[].e": 1 });
  // a day with images: [] reports no entries[].images[]
  assert.deepEqual(tallyUnknown([dayOf("2026-02-01")], DIARY_DAY_ALLOWED), { "entries[].diary_id": 1, "entries[].read": 1, "entries[].image_count": 1 });
  // the depth cap still holds inside an array
  assert.deepEqual(tallyUnknown([{ a: { b: { c: { d: [{ e: 1 }] } } } }], new Set([])), { "a.b.c.d[].*": 1 });
});

test("tallyUnknown: a key that isn't a short plain name is written as *, so a secret in a key never reaches the tally", () => {
  const counts = tallyUnknown([
    { meta: { attachments: { "https://cdn.example.org/x.png": 1, "fake-token-1234": 2, "ok_key": 3 } }, "uid-424242": true },
  ], new Set([]));
  assert.deepEqual(counts, { "meta.attachments.*": 2, "meta.attachments.ok_key": 1, "*": 1 });
  const text = JSON.stringify(counts);
  for (const s of ["cdn.example.org", "fake-token-1234", "uid-424242"]) assert.ok(!text.includes(s), s);
  // the pattern allows 41 characters (one lead + up to 40); a 42-character name is also *
  assert.deepEqual(tallyUnknown([{ ["a".repeat(42)]: 1 }], new Set([])), { "*": 1 });
  assert.deepEqual(tallyUnknown([{ ["a".repeat(41)]: 1 }], new Set([])), { ["a".repeat(41)]: 1 });
});

test("tallyUnknown: objects deeper than four segments are not entered, and past 200 paths the rest count under (more)", () => {
  const deep = tallyUnknown([{ a: { b: { c: { d: { e: { f: 1 } } } } } }], new Set([]));
  assert.deepEqual(deep, { "a.b.c.d.*": 1 });
  assert.deepEqual(tallyUnknown([{ a: { b: { c: { d: 1 } } } }], new Set([])), { "a.b.c.d": 1 }); // four segments still a leaf
  const wide = {};
  for (let i = 0; i < 250; i++) wide[`k${i}`] = 1;
  const counts = tallyUnknown([wide], new Set([]));
  assert.equal(Object.keys(counts).length, 201); // 200 paths + "(more)"
  assert.equal(counts["(more)"], 50);
  assert.equal(counts.k0, 1);
});

// ---------- media names ----------

test("extFor maps the blob types to extensions and falls back to bin", () => {
  assert.equal(extFor("image/jpeg"), "jpg");
  assert.equal(extFor("image/png"), "png");
  assert.equal(extFor("image/webp"), "webp");
  assert.equal(extFor("image/gif"), "gif");
  assert.equal(extFor("audio/mpeg"), "mp3");
  assert.equal(extFor("audio/mp4"), "m4a");
  assert.equal(extFor("audio/x-m4a"), "m4a");
  assert.equal(extFor("audio/ogg"), "ogg");
  assert.equal(extFor("audio/wav"), "wav");
  assert.equal(extFor("application/octet-stream"), "bin");
});

test("safeId keeps [A-Za-z0-9_-], replaces the rest, cuts to 80, and never hands out an empty stem", () => {
  assert.equal(safeId("abc-DEF_123"), "abc-DEF_123");
  assert.equal(safeId("a b/c:d"), "a_b_c_d");
  assert.equal(safeId("x".repeat(100)), "x".repeat(80));
  assert.equal(safeId(""), "file");
  assert.equal(safeId(null), "file");
});

test("the media namer gives a clash -2, -3, per extension", () => {
  const name = makeMediaNamer();
  assert.equal(name("m1", "image/png"), "m1.png");
  assert.equal(name("m1", "image/png"), "m1-2.png");
  assert.equal(name("m1", "image/png"), "m1-3.png");
  assert.equal(name("m1", "image/jpeg"), "m1.jpg"); // a different extension is no clash
  assert.equal(name("a b", "audio/mp4"), "a_b.m4a");
});

// ---------- collectMedia ----------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function mediaRoutes() {
  const seen = [];
  const fn = fakeFetch((url, init) => {
    seen.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === GET_URL) {
      const raw = init.body ? JSON.parse(init.body).image_url : null;
      if (raw === "https://cdn.example.org/pic.png") return reply({ image_url: "https://s3-us-west-1.amazonaws.com/replika-content-images/pic.png?sig=abc" });
      if (raw === "https://cdn.example.org/pic2.png") return reply({ image_url: "https://s3-us-west-1.amazonaws.com/replika-content-images/pic2.png?sig=abc" });
      if (raw === "https://cdn.example.org/pic3.png") return reply({ image_url: "https://127.0.0.1/x.png" });
      if (raw === "https://cdn.example.org/signedout.png") return reply({}, 401);
      return reply({ image_url: "https://s3-us-west-1.amazonaws.com/replika-content-images/fail.png?sig=abc" });
    }
    if (url === "https://s3-us-west-1.amazonaws.com/replika-content-images/pic.png?sig=abc") return bytes(PNG, "image/png");
    if (url === "https://s3-us-west-1.amazonaws.com/replika-content-images/pic2.png?sig=abc") return bytes(PNG, "image/png; charset=binary");
    // a voice clip is fetched by its own link, never signed
    if (url === "https://cdn.example.org/voice.m4a") return bytes(new Uint8Array([1, 2, 3, 4]), "audio/mp4");
    return reply({}, 403); // the signed host refuses this one
  });
  fn.signedCalls = seen;
  return fn;
}

const planFor = (id, kind, url) => {
  const built = buildMessage({
    id,
    content: kind === "images" ? { type: "images", text: url } : { type: "voice_message", voice_message_url: url },
    meta: { nature: "Robot", timestamp: "2026-06-01T00:00:00Z" },
  });
  return { record: built.record, url: built.media.url };
};

test("collectMedia signs and fetches one file at a time, rests between them, and names them from the content type", async () => {
  const fn = mediaRoutes();
  const plans = [planFor("m1", "images", "https://cdn.example.org/pic.png"), planFor("m2", "images", "https://cdn.example.org/pic2.png")];
  const pauses = [];
  const { files, stopped } = await collectMedia(plans, {
    auth: AUTH, fetchFn: fn, sleep: instant, pause: async () => pauses.push(1),
  });
  assert.equal(stopped, null);
  assert.deepEqual(pauses, [1]); // one rest between two files, none after the last
  assert.deepEqual(plans[0].record.media, "media/m1.png");
  assert.equal(plans[1].record.media, "media/m2.png"); // content-type "image/png; charset=binary" → png
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "m1.png");
  assert.equal(typeof files[0].crc, "number");
  assert.ok(files[0].blob.size > 0);
  // the POST bodies carried the raw links; the records never did
  const raws = fn.signedCalls.filter((c) => c.url === GET_URL).map((c) => c.body.image_url);
  assert.deepEqual(raws, ["https://cdn.example.org/pic.png", "https://cdn.example.org/pic2.png"]);
  assert.ok(!JSON.stringify(plans.map((p) => p.record)).includes("cdn.example.org"));
});

test("collectMedia: an unusable signed link, a refused fetch and a failing sign call each name their own fixed reason", async () => {
  const fn = mediaRoutes();
  const plans = [
    planFor("m3", "images", "https://cdn.example.org/pic3.png"), // the signed link is an IP literal
    planFor("m4", "images", "https://cdn.example.org/unknown.png"), // the signed host answers 403
  ];
  const { files } = await collectMedia(plans, { auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(plans[0].record.not_captured, MEDIA_LINK_UNUSABLE);
  // the 403's own words ("link expired or gone") never reach the record: the fixed reason does
  assert.equal(plans[1].record.not_captured, MEDIA_FETCH_FAILED);
  assert.ok(!JSON.stringify(plans.map((p) => p.record)).includes("link expired"));
  assert.equal(files.length, 0);
});

test("collectMedia: a host that rejects every call is tried exactly 3 times per file", async () => {
  const urls = [];
  const fn = async (url, init) => {
    if (url === GET_URL) return reply({ image_url: "https://s3-us-west-1.amazonaws.com/replika-content-images/a.png?sig=1" });
    urls.push(url);
    throw new Error("blocked");
  };
  const plans = [planFor("m1", "images", "https://cdn.example.org/a.png")];
  await collectMedia(plans, { auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(urls.length, 3);
  assert.equal(plans[0].record.not_captured, MEDIA_FETCH_FAILED);
});

test("replikaPictureUrl takes Replika's picture bucket and user-media host only", () => {
  const bucket = "https://s3-us-west-1.amazonaws.com/replika-content-images/";
  assert.equal(replikaPictureUrl(`${bucket}a/b.png?X-Amz-Signature=x`), true);
  assert.equal(replikaPictureUrl("https://luka-user-media.s3.us-west-1.amazonaws.com/u/c.jpg"), true);
  assert.equal(replikaPictureUrl("https://s3-us-west-1.amazonaws.com/someone-elses-bucket/b.png"), false); // same host, other bucket
  assert.equal(replikaPictureUrl("https://s3-us-west-1.amazonaws.com/replika-content-images-evil/b.png"), false); // a prefix of the name, not the bucket
  assert.equal(replikaPictureUrl("https://s3-us-west-1.amazonaws.com/x/../replika-content-images/b.png"), true); // URL() resolves the dots first
  assert.equal(replikaPictureUrl("https://s3-us-west-2.amazonaws.com/replika-content-images/b.png"), false);
  assert.equal(replikaPictureUrl("https://evil.luka-user-media.s3.us-west-1.amazonaws.com/c.jpg"), false);
  assert.equal(replikaPictureUrl(`http://s3-us-west-1.amazonaws.com/replika-content-images/b.png`), false);
  assert.equal(replikaPictureUrl(`https://s3-us-west-1.amazonaws.com:8443/replika-content-images/b.png`), false);
  assert.equal(replikaPictureUrl(`https://s3-us-west-1.amazonaws.com:443/replika-content-images/b.png`), true); // the default port: URL() drops it
  assert.equal(replikaPictureUrl(`https://u:p@s3-us-west-1.amazonaws.com/replika-content-images/b.png`), false);
  assert.equal(replikaPictureUrl("https://memes.example.org/b.png"), false);
  assert.equal(replikaPictureUrl("not a url"), false);
});

test("collectMedia: a signed picture link outside Replika's storage is never fetched; pictures refuse redirects, voice clips follow them", async () => {
  const fetched = [];
  const fn = async (url, init) => {
    if (url === GET_URL) {
      const raw = JSON.parse(init.body).image_url;
      return reply({ image_url: raw.includes("stray") ? "https://memes.example.org/stray.png" : "https://s3-us-west-1.amazonaws.com/replika-content-images/ok.png" });
    }
    fetched.push({ url, redirect: init && init.redirect });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  };
  const plans = [
    planFor("m1", "images", "https://cdn.example.org/stray.png"),
    planFor("m2", "images", "https://cdn.example.org/ok.png"),
    planFor("v1", "voice_message", "https://cdn.example.org/voice.m4a"),
  ];
  const { files } = await collectMedia(plans, { auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(plans[0].record.not_captured, MEDIA_HOST_NOT_REPLIKA);
  assert.ok(!plans[0].record.media);
  assert.equal(plans[1].record.media, "media/m2.png");
  assert.equal(files.length, 2);
  assert.deepEqual(fetched, [
    { url: "https://s3-us-west-1.amazonaws.com/replika-content-images/ok.png", redirect: "error" },
    { url: "https://cdn.example.org/voice.m4a", redirect: "follow" },
  ]);
});

test("collectMedia: a picture whose fetch is refused for its redirect is not captured, and a voice clip before it doesn't loosen its mode", async () => {
  const signed = "https://s3-us-west-1.amazonaws.com/replika-content-images/moved.png?X-Amz-Signature=keep-me";
  const fetched = [];
  const fn = async (url, init) => {
    if (url === GET_URL) return reply({ image_url: JSON.parse(init.body).image_url.includes("moved") ? signed : "https://s3-us-west-1.amazonaws.com/replika-content-images/ok.png" });
    fetched.push({ url, redirect: init && init.redirect });
    if (url === signed && init.redirect === "error") throw new TypeError("Failed to fetch"); // what fetch does on a redirect it may not follow
    return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
  };
  const plans = [
    planFor("v1", "voice_message", "https://cdn.example.org/voice.m4a"),
    planFor("m1", "images", "https://cdn.example.org/moved.png"),
    planFor("m2", "images", "https://cdn.example.org/ok.png"),
  ];
  const { files } = await collectMedia(plans, { auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(plans[1].record.not_captured, MEDIA_FETCH_FAILED);
  assert.ok(!plans[1].record.media);
  assert.equal(plans[2].record.media, "media/m2.png"); // the next picture still runs
  assert.equal(files.length, 2);
  assert.deepEqual(fetched.map((f) => f.redirect), ["follow", "error", "error", "error", "error"]); // voice, 3 tries of m1, m2
  assert.equal(fetched[1].url, signed); // the signed link, query and all, is what gets fetched
});

test("collectMedia: a voice clip is fetched by its own link with no sign call, and lands as .m4a", async () => {
  const fn = mediaRoutes();
  const plans = [planFor("v1", "voice_message", "https://cdn.example.org/voice.m4a")];
  const { files } = await collectMedia(plans, { auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(plans[0].record.media, "media/v1.m4a");
  assert.equal(files[0].name, "v1.m4a");
  // no sign call happened: the voice link went straight to fetchFile
  assert.ok(!fn.signedCalls.some((c) => c.url === GET_URL), "a voice clip is never signed");
});

test("collectMedia: a network failure on the sign call names the fixed network reason, not the fetch's message", async () => {
  const fn = fakeFetch(() => { throw new Error(`socket hangup with fake-token-1234 at ${GET_URL}`); });
  const plans = [planFor("m5", "images", "https://cdn.example.org/pic.png")];
  const { stopped } = await collectMedia(plans, { auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(stopped, null);
  assert.equal(plans[0].record.not_captured, "network error");
  assert.ok(!JSON.stringify(plans.map((p) => p.record)).includes("fake-token-1234"));
});

test("collectMedia: a SignedOut from the sign call ends the step with the reason; what follows keeps it", async () => {
  const fn = mediaRoutes();
  const plans = [
    planFor("m1", "images", "https://cdn.example.org/pic.png"), // captured
    planFor("m6", "images", "https://cdn.example.org/signedout.png"), // the sign call answers 401
  ];
  const { files, stopped } = await collectMedia(plans, { auth: AUTH, fetchFn: fn, sleep: instant, pause: instant });
  assert.equal(files.length, 1);
  assert.match(stopped, /sign in again/);
  assert.equal(plans[0].record.media, "media/m1.png");
  assert.match(plans[1].record.not_captured, /sign in again/);
});

// ---------- the save's own names and lines ----------

test("saveName is local time to the second; downloadOptions pins uniquify so a re-run never overwrites", () => {
  assert.equal(saveName(new Date(2026, 10, 25, 14, 30, 5)), "replika-2026-11-25-143005.zip");
  assert.equal(saveName(new Date(2026, 0, 2, 3, 4, 5)), "replika-2026-01-02-030405.zip");
  assert.deepEqual(downloadOptions("replika-x.zip"), { filename: "replika-x.zip", conflictAction: "uniquify" });
  // a second later the name differs: two saves land beside each other, never on top
  assert.notEqual(saveName(new Date(2026, 10, 25, 14, 30, 5)), saveName(new Date(2026, 10, 25, 14, 30, 6)));
});

test("problems lists each partial reason and counts the not-captured media by reason", () => {
  const data = {
    status: { chat: "complete", diary: DIARY_PARTIAL, memories: "complete", media: "complete" },
    messages: [
      { id: "a", not_captured: MEDIA_FETCH_FAILED },
      { id: "b", not_captured: MEDIA_FETCH_FAILED },
      { id: "c", not_captured: MEDIA_LINK_UNUSABLE },
      { id: "d" },
    ],
  };
  assert.deepEqual(problems(data), [
    `Diary: ${DIARY_PARTIAL}`,
    `2 item(s) not saved: ${MEDIA_FETCH_FAILED}`,
    `1 item(s) not saved: ${MEDIA_LINK_UNUSABLE}`,
  ]);
  assert.deepEqual(problems({ status: {}, messages: [] }), []);
});

test("endLine says what was saved and appends (partial: …) with the warn flag when a status isn't complete", () => {
  const clean = { counts: { messages: 4, diary: 2, memories: 3, media: 1 }, status: { chat: "complete", diary: "complete", memories: "complete", media: "complete" } };
  assert.deepEqual(endLine({ filename: "replika-x.zip", data: clean }),
    { text: "Saved replika-x.zip: 4 messages, 2 diary entries, 3 memories, 1 pictures and voice clips", warn: false });
  const partial = { ...clean, status: { ...clean.status, memories: MEMORY_V15_PARTIAL, media: MEDIA_FETCH_FAILED } };
  const end = endLine({ filename: "replika-x.zip", data: partial });
  assert.equal(end.warn, true);
  assert.ok(end.text.endsWith(`(partial: ${MEMORY_V15_PARTIAL}; ${MEDIA_FETCH_FAILED})`));
  const twice = endLine({ filename: "x.zip", data: { counts: clean.counts, status: { chat: "complete", diary: DIARY_PARTIAL, memories: DIARY_PARTIAL, media: "complete" } } });
  assert.equal(twice.text.split("(partial: ")[1].split(DIARY_PARTIAL).length, 2); // the reason appears once
});

test("endLine counts the not-captured media: a warn, inside the partial parenthesis or its own", () => {
  const ok = { counts: { messages: 4, diary: 0, memories: 0, media: 1 }, status: { chat: "complete", diary: "complete", memories: "complete", media: "complete" } };
  const alone = endLine({ filename: "x.zip", data: { ...ok, messages: [{ id: "a", not_captured: MEDIA_FETCH_FAILED }, { id: "b" }] } });
  assert.equal(alone.warn, true);
  assert.ok(alone.text.endsWith("1 pictures and voice clips (1 item(s) not saved)"), alone.text);
  const both = endLine({ filename: "x.zip", data: { ...ok, status: { ...ok.status, diary: DIARY_PARTIAL }, messages: [{ id: "a", not_captured: "r" }, { id: "b", not_captured: "r" }] } });
  assert.equal(both.warn, true);
  assert.ok(both.text.endsWith(`(partial: ${DIARY_PARTIAL}; 2 item(s) not saved)`), both.text);
  assert.equal(endLine({ filename: "x.zip", data: { ...ok, messages: [{ id: "b" }] } }).warn, false);
});

test("problems shows the unsaved-field tally per kind: up to 20 paths, then 'and N more'", () => {
  const many = {};
  for (let i = 0; i < 23; i++) many[`f${i}`] = 1;
  const lines = problems({
    status: {}, messages: [],
    unsaved_fields: { message: { "meta.leak": 1, "content.extra": 2 }, diary: {}, fact: many },
  });
  assert.deepEqual(lines, [
    "Fields Leket didn't save (message): meta.leak, content.extra",
    `Fields Leket didn't save (fact): ${Object.keys(many).slice(0, 20).join(", ")} and 3 more`,
  ]);
});

test("record id and at are copied only as a string or a finite number; kind and type only as a short plain name", () => {
  const obj = { secret: "x" };
  const m = buildMessage({ id: obj, content: { type: "text", text: "t" }, meta: { nature: "Robot", timestamp: obj } }).record;
  assert.equal(m.id, null);
  assert.equal(m.at, null);
  const n = buildMessage({ id: 7, content: { type: "text", text: "t" }, meta: { nature: "Robot", timestamp: NaN } }).record;
  assert.equal(n.id, 7);
  assert.equal(n.at, null);
  assert.equal(buildMessage({ id: "a", content: { type: obj }, meta: {} }).record.kind, "unknown");
  assert.equal(buildMessage({ id: "a", content: { type: "k".repeat(80) }, meta: {} }).record.kind, "unknown");
  const d = buildDiary({ date: obj, entries: [{ id: obj, timestamp: obj, text: obj }] }, { title: obj }).record;
  assert.deepEqual([d.date, d.title, d.entries[0].id, d.entries[0].at, d.entries[0].text], [null, null, null, null, null]);
  const d2 = buildDiary({ date: "2026-02-01", entries: [{ id: 3, timestamp: "t", text: "x" }] }, { title: "T" }).record;
  assert.deepEqual([d2.date, d2.title, d2.entries[0].id, d2.entries[0].at], ["2026-02-01", "T", 3, "t"]);
  const f = buildFact({ id: obj, creation_timestamp: obj, text: "x" }, null);
  assert.deepEqual([f.id, f.at], [null, null]);
  assert.equal(buildFact({ id: "f1", creation_timestamp: 5, text: "x" }, null).id, "f1");
});

// ---------- render ----------

test("render: the page is self-contained, esc'd, light and dark, and names the speakers", () => {
  const data = {
    saved_at: "2026-06-05T12:00:00Z",
    leket_version: "0.4.0",
    names: { you: "Ada Example", replika: "Echo" },
    status: { chat: "complete", diary: "complete", memories: "complete", media: "complete" },
    counts: { messages: 2, diary: 1, memories: 2, media: 2 },
    messages: [
      { id: "m1", at: "2026-06-01T10:00:00Z", from: "you", kind: "text", text: "a <bold> & \"quoted\" message" },
      { id: "m2", at: "2026-06-02T10:00:00Z", from: "replika", kind: "images", media: "media/m2.png" },
      { id: "m3", at: "2026-06-03T10:00:00Z", from: "you", kind: "voice_message", media: "media/m3.m4a" },
      { id: "m4", at: "2026-06-04T10:00:00Z", from: "unknown", kind: "sticker", not_captured: "Leket doesn't read sticker messages yet" },
      { id: "m5", at: "2026-06-05T10:00:00Z", from: "replika", kind: "images", not_captured: MEDIA_FETCH_FAILED },
    ],
    diary: [{ date: "2026-02-01", title: "A <b>title</b>", entries: [
      { id: "e1", at: "2026-02-01T09:00:00Z", text: "a diary day", images: [
        { kind: "images", id: "e1-0", media: "media/e1-0.png" },
        { kind: "images", id: "e1-1", not_captured: MEDIA_FETCH_FAILED },
      ] },
    ] }],
    memories: {
      facts: [{ at: "2026-01-05T00:00:00Z", text: "likes tea", about: null }],
      about_you: [{ id: "f2", at: "2026-01-06T00:00:00Z", text: "has a sister", about: "you" }],
      about_replika: [],
    },
  };
  const html = render(data);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("Ada Example") && html.includes("Echo"));
  assert.ok(html.includes("a &lt;bold&gt; &amp; &quot;quoted&quot; message"), "every API string goes through esc");
  assert.ok(!html.includes("<bold>"));
  assert.ok(!html.includes("<script"), "no script anywhere");
  assert.ok(!/(src|href)="https?:/.test(html), "no remote URL anywhere");
  assert.ok(html.includes('<img loading="lazy" src="media/m2.png"'), "the picture is inline");
  assert.ok(/alt="picture from Echo, /.test(html), "the alt names the speaker and the date");
  assert.ok(html.includes('<audio controls src="media/m3.m4a"></audio>'), "the voice clip has its player");
  assert.ok(html.includes("voice clip from Ada Example"), "and its text label");
  assert.ok(html.includes("Leket doesn&#39;t read sticker messages yet"), "not_captured shows with its reason, esc'd");
  assert.ok(html.includes("picture not saved"), "a failed picture says so in words");
  // the diary day: its title (esc'd) with the date as the head, its text, its saved picture and its not-saved line
  assert.ok(html.includes('<span class="name">A &lt;b&gt;title&lt;/b&gt;</span><span class="time">2026-02-01</span>'), "the diary day's head");
  assert.ok(html.includes("a diary day"));
  assert.ok(html.includes('<img loading="lazy" src="media/e1-0.png" alt="picture from the diary, 2026-02-01">'), "a diary picture is inline");
  assert.ok(html.includes(`picture not saved: ${MEDIA_FETCH_FAILED}`), "a diary picture that failed says so");
  assert.ok(render({ ...data, diary: [{ date: "2026-02-02", title: null, entries: [] }] }).includes('<span class="name">diary entry</span><span class="time">2026-02-02</span>'), "an untitled day is a diary entry");
  assert.ok(html.includes("prefers-color-scheme: dark"), "light and dark via the media query");
  assert.ok(html.includes("Complete — 2 here."), "each section says its status in words");
  // a partial section says so in words, not only colour
  const partialHtml = render({ ...data, status: { ...data.status, diary: DIARY_PARTIAL } });
  assert.ok(partialHtml.includes(`Saved partway (${DIARY_PARTIAL}) — `));
  // the media step: a partial one shows in the header with its escaped reason; a complete one adds nothing
  const mediaHtml = render({ ...data, status: { ...data.status, media: "some <b>pictures</b> not saved" } });
  assert.ok(mediaHtml.includes('<p class="status warn">Saved partway (some &lt;b&gt;pictures&lt;/b&gt; not saved).</p></header>'), "media partial shows in the header, esc'd");
  const completeHtml = render({ ...data, status: { ...data.status, media: "complete" } });
  const header = completeHtml.slice(completeHtml.indexOf("<header>"), completeHtml.indexOf("</header>"));
  assert.ok(!header.includes('class="status'), "a complete media step adds no status line to the header");
});

// ---------- buildZip ----------

test("buildZip packs data.json, index.html and the media files, and python3 can read it", async () => {
  const data = {
    saved_at: "2026-06-05T12:00:00Z", leket_version: "0.4.0",
    names: { you: "Ada Example", replika: "Echo" },
    status: { chat: "complete", diary: "complete", memories: "complete", media: "complete" },
    counts: { messages: 1, diary: 0, memories: 0, media: 1 },
    unsaved_fields: { message: {}, diary: {}, fact: {} },
    messages: [{ id: "m1", at: "2026-06-01T10:00:00Z", from: "you", kind: "images", media: "media/m1.png" }],
    diary: [], memories: { facts: [], about_you: [], about_replika: [] },
  };
  const parts = buildZip(data, [{ name: "m1.png", blob: new Blob([PNG]), crc: crc32(PNG) }]);
  assert.equal(parts.length, 1);
  const dir = mkdtempSync(join(tmpdir(), "leket-replika-"));
  try {
    const file = join(dir, "replika-test.zip");
    writeFileSync(file, Buffer.from(await parts[0].arrayBuffer()));
    const out = JSON.parse(execFileSync("python3", ["-I", "-c",
      "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({'names': z.namelist(), 'png': list(z.read('media/m1.png')), 'crc': z.getinfo('media/m1.png').CRC}))",
      file], { encoding: "utf8" }));
    assert.deepEqual(out.names, ["data.json", "index.html", "media/m1.png"]);
    assert.deepEqual(out.png, [...PNG]);
    assert.equal(out.crc, crc32(PNG)); // the real crc, so python's read verifies it
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the full run ----------

// The six strings a real run must never write anywhere. The raw fixtures below carry
// them in message fields, unknown extra fields, error bodies and a rejecting fetch.
const LEAKS = [
  AUTH.authToken, AUTH.userId, AUTH.deviceId, AUTH.chatId,
  "https://s3-us-west-1.amazonaws.com/replika-content-images/pic?sig=leak-sig-xyz",
  "https://cdn.example.org/voice.m4a",
  "https://cdn.example.org/key-url.png", // carried as an object KEY, below
  "https://cdn.example.org/diary-pic.png", // a diary picture's raw link
  "https://s3-us-west-1.amazonaws.com/replika-content-images/diary-sig?sig=leak-diary-xyz", // and the signed one
];

function leakRunRoutes() {
  return fakeFetch((url, init) => {
    if (url === LIST_URL()) return reply([{ ...li("2026-02-02"), secret_note: AUTH.authToken }, li("2026-02-01", "First")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) {
      return reply({ date: "2026-02-01", error_body: AUTH.deviceId, entries: [{ id: "e1", timestamp: "2026-02-01T09:00:00Z", text: "a diary day",
        images: [{ url: "https://cdn.example.org/diary-pic.png", blurred: false, is_romantic: false }] }] });
    }
    if (url === DAY_URL("2026-02-02")) {
      return reply({ date: "2026-02-02", trace: AUTH.chatId, entries: [{ id: "e2", timestamp: "2026-02-02T09:00:00Z", text: "second", images: [] }] });
    }
    if (url === MEMORY_14) return reply({ facts: [{ text: "likes tea", creation_timestamp: "2026-01-05T00:00:00Z", internal: AUTH.userId }] });
    if (url === MEMORY_15) return reply({ detail: `denied for ${AUTH.authToken}` }, 500); // an error body carrying a secret
    if (url === GET_URL) {
      const raw = init.body ? JSON.parse(init.body).image_url : null;
      if (raw === "https://cdn.example.org/captured.png") return reply({ image_url: "https://s3-us-west-1.amazonaws.com/replika-content-images/pic?sig=leak-sig-xyz" });
      if (raw === "https://cdn.example.org/diary-pic.png") return reply({ image_url: "https://s3-us-west-1.amazonaws.com/replika-content-images/diary-sig?sig=leak-diary-xyz" });
      return reply({ image_url: "https://s3-us-west-1.amazonaws.com/replika-content-images/refused.png?sig=x" });
    }
    if (url === "https://s3-us-west-1.amazonaws.com/replika-content-images/pic?sig=leak-sig-xyz") return bytes(PNG, "image/png");
    if (url === "https://s3-us-west-1.amazonaws.com/replika-content-images/diary-sig?sig=leak-diary-xyz") return bytes(PNG, "image/png");
    // a voice clip is fetched by its own link, unsigned; the host refuses it with a secret in the body
    if (url === "https://cdn.example.org/voice.m4a") return reply({ detail: AUTH.deviceId }, 403);
    if (url === "https://s3-us-west-1.amazonaws.com/replika-content-images/refused.png?sig=x") return reply({ detail: AUTH.deviceId }, 403);
    throw new Error(`unexpected fetch ${url}`);
  });
}

// the history batches, newest-first as the API sends them, carrying secrets in known
// and unknown fields alike
const leakBatches = [
  [
    { id: "m3", content: { type: "text", text: "newest" }, meta: { nature: "Robot", timestamp: "2026-06-03T10:00:00Z", leak: AUTH.authToken,
      // secrets as object KEYS: the tally must write them as *
      attachments: { "https://cdn.example.org/key-url.png": 1, [AUTH.authToken]: 2, [AUTH.userId]: 3 } } },
    { id: "m2", content: { type: "text", text: "middle" }, meta: { nature: "Customer", timestamp: "2026-06-02T10:00:00Z", nested: { deep: AUTH.userId } } },
    { id: "m1", content: { type: "images", text: "https://cdn.example.org/refused.png" }, meta: { nature: "Robot", timestamp: "2026-06-01T10:00:00Z", reactions: ["❤", 2] } },
    { id: "m1a", content: { type: "images", text: "https://cdn.example.org/captured.png" }, meta: { nature: "Robot", timestamp: "2026-05-31T10:00:00Z" } },
  ],
  [
    { id: "m0", content: { type: "voice_message", voice_message_url: "https://cdn.example.org/voice.m4a" }, meta: { nature: "Customer", timestamp: "2026-05-30T10:00:00Z" } },
  ],
  [],
];

test("a full run saves everything it read, with one picture captured and two named as not captured", async () => {
  const Socket = fakeSocketClass(leakBatches);
  const fetchFn = leakRunRoutes();
  const steps = [];
  const { data, parts, filename } = await runSave({
    auth: AUTH,
    leketVersion: "0.4.0",
    now: new Date(2026, 10, 25, 14, 30, 5),
    fetchFn,
    sleep: instant,
    WebSocketCtor: Socket,
    timeoutMs: 1000,
    pause: instant,
    onStep: (s) => steps.push(s),
  });
  assert.deepEqual(steps, ["chat", "diary", "memories", "media"], "the four steps run in order");
  assert.equal(filename, "replika-2026-11-25-143005.zip");
  assert.equal(parts.length, 1);
  assert.deepEqual(data.counts, { messages: 5, diary: 2, memories: 1, media: 2 });
  assert.equal(data.status.chat, "complete");
  assert.equal(data.status.diary, "complete");
  assert.equal(data.status.memories, MEMORY_V15_PARTIAL); // the 500 on the newer list
  assert.equal(data.status.media, "complete");
  assert.deepEqual(data.names, { you: "Ada Example", replika: "Echo" });
  const byId = new Map(data.messages.map((m) => [m.id, m]));
  assert.deepEqual(data.messages.map((m) => m.id), ["m0", "m1a", "m1", "m2", "m3"]); // oldest first
  assert.equal(byId.get("m1a").media, "media/m1a.png");
  assert.equal(byId.get("m1").not_captured, MEDIA_FETCH_FAILED); // the 403 on the signed host
  assert.equal(byId.get("m0").not_captured, MEDIA_FETCH_FAILED); // its own link, and the host refused
  assert.deepEqual(byId.get("m1").reactions, ["❤", 2]);
  assert.deepEqual(data.unsaved_fields.message, { "meta.leak": 1, "meta.attachments.*": 3, "meta.nested.deep": 1 });
  assert.deepEqual(data.unsaved_fields.diary_list, { "diary_entry_id": 2, "image_count": 2, "read": 2, "secret_note": 1 });
  // the day with no pictures carries an empty images[], which counts as nothing
  assert.deepEqual(data.unsaved_fields.diary, { "error_body": 1, "trace": 1 });
  // the diary picture was saved like a chat picture: its record carries `media`, never the link
  assert.deepEqual(data.diary.map((d) => d.date), ["2026-02-01", "2026-02-02"]);
  assert.deepEqual(data.diary[0].title, "First");
  assert.deepEqual(data.diary[0].entries[0].images, [{ kind: "images", id: "e1-0", blurred: false, is_romantic: false, media: "media/e1-0.png" }]);
  assert.deepEqual(data.unsaved_fields.fact, { "internal": 1 });
  // the run really did carry the secrets: the socket requests held the auth triple
  const sent = Socket.sockets[0].sent[0];
  assert.equal(sent.auth.auth_token, AUTH.authToken);
  assert.equal(sent.auth.user_id, AUTH.userId);
  // and the tally holds paths only, never the values behind them
  assert.ok(!JSON.stringify(data.unsaved_fields).includes("fake-token-1234"));
});

test("the leak test: none of the secrets reach the data, the page, any reason, the problem lines or the console", async () => {
  const Socket = fakeSocketClass(leakBatches);
  const fetchFn = leakRunRoutes();
  // also make the refused picture's sign call reject with a secret-carrying Error, as
  // the task's leak vectors ask: the fixed "network error" must be all that survives
  const base = fetchFn;
  const rejecting = async (url, init) => {
    if (url === GET_URL && init && init.body && init.body.includes("refused.png")) {
      throw new Error(`sign call failed for ${AUTH.authToken} at ${init.body}`);
    }
    return base(url, init);
  };
  rejecting.calls = base.calls;
  const logs = [];
  const realConsole = {};
  for (const k of ["log", "warn", "error", "info", "debug"]) {
    realConsole[k] = console[k];
    console[k] = (...a) => logs.push([k, ...a]);
  }
  let data, parts, filename;
  try {
    ({ data, parts, filename } = await runSave({
      auth: AUTH, leketVersion: "0.4.0", now: new Date(2026, 10, 25, 14, 30, 5),
      fetchFn: rejecting, sleep: instant, WebSocketCtor: Socket, timeoutMs: 1000, pause: instant,
    }));
  } finally {
    for (const k of ["log", "warn", "error", "info", "debug"]) console[k] = realConsole[k];
  }
  const jsonString = JSON.stringify(data);
  const html = render(data);
  const lines = problems(data);
  const end = endLine({ filename, data });
  const reasons = [
    data.status.chat, data.status.diary, data.status.memories, data.status.media,
    ...data.messages.flatMap((m) => [m.not_captured]),
    ...data.diary.flatMap((d) => d.entries.flatMap((e) => e.images.map((img) => img.not_captured))),
  ].filter(Boolean);
  // the raw run really carried every secret: the voice's sign call rejected with one
  assert.ok(rejecting.calls.some((c) => c.url === GET_URL), "the sign call was attempted");
  const everything = [jsonString, html, ...lines, end.text, ...reasons];
  for (const secret of LEAKS) {
    for (const place of everything) {
      assert.ok(!place.includes(secret), `the secret ${JSON.stringify(secret.slice(0, 24))}… leaked into output`);
    }
  }
  assert.deepEqual(logs, [], "the module logs nothing at all");
  // the outputs are still whole: the captured picture is there, the two failures named
  assert.equal(data.messages.find((m) => m.id === "m1a").media, "media/m1a.png");
  assert.equal(data.messages.find((m) => m.id === "m1").not_captured, "network error"); // the sign call rejected
  assert.equal(data.messages.find((m) => m.id === "m0").not_captured, MEDIA_FETCH_FAILED); // the voice host refused
  assert.equal(data.status.memories, MEMORY_V15_PARTIAL);
  assert.ok(lines.some((l) => l.includes("Memories: ")));
  // the tally is non-empty and shown (paths only), so the leak check above covered those lines
  assert.ok(lines.some((l) => l.startsWith("Fields Leket didn't save (message): ") && l.includes("meta.attachments.*")),
    `the tally line is missing: ${JSON.stringify(lines)}`);
});

test("the zip of the full run carries no secret in any file (python3 reads it back)", async () => {
  const Socket = fakeSocketClass(leakBatches);
  const { data, parts } = await runSave({
    auth: AUTH, leketVersion: "0.4.0", now: new Date(2026, 10, 25, 14, 30, 5),
    fetchFn: leakRunRoutes(), sleep: instant, WebSocketCtor: Socket, timeoutMs: 1000, pause: instant,
  });
  assert.equal(parts.length, 1);
  const dir = mkdtempSync(join(tmpdir(), "leket-replika-"));
  try {
    const file = join(dir, "replika-leak.zip");
    writeFileSync(file, Buffer.from(await parts[0].blob.arrayBuffer()));
    const out = JSON.parse(execFileSync("python3", ["-I", "-c",
      "import json,sys,zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({n: z.read(n).decode('utf-8', 'replace') for n in z.namelist()}))",
      file], { encoding: "utf8" }));
    const parsed = JSON.parse(out["data.json"]);
    assert.equal(parsed.counts.messages, 5);
    assert.equal(parsed.status.chat, "complete");
    assert.equal(parsed.diary[0].entries[0].images[0].media, "media/e1-0.png");
    assert.ok("media/e1-0.png" in out, "the diary picture is in media/ in the zip");
    assert.ok(out["index.html"].includes("Ada Example"));
    for (const secret of LEAKS) {
      for (const [name, text] of Object.entries(out)) {
        assert.ok(!text.includes(secret), `${name} carries the secret ${secret.slice(0, 24)}…`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a SignedOut on the diary stops the remaining steps but still saves the chat", async () => {
  const Socket = fakeSocketClass(leakBatches);
  const fetchFn = fakeFetch((url, init) => {
    if (url.startsWith(DIARY_LIST_URL)) return reply({}, 401);
    // nothing after the diary may be fetched at all
    throw new Error(`a refused save must not fetch ${url}`);
  });
  const { data } = await runSave({
    auth: AUTH, leketVersion: "0.4.0", now: new Date(2026, 10, 25, 14, 30, 5),
    fetchFn, sleep: instant, WebSocketCtor: Socket, timeoutMs: 1000, pause: instant,
  });
  const signedOutMessage = "Replika answered 401/403: sign in again on Replika and rerun";
  assert.equal(data.status.chat, "complete");
  assert.equal(data.status.diary, signedOutMessage);
  assert.equal(data.status.memories, signedOutMessage);
  assert.equal(data.status.media, signedOutMessage);
  assert.equal(data.counts.messages, 5); // the chat was still read and saved
  assert.equal(data.counts.diary, 0);
  const end = endLine({ filename: "x.zip", data });
  assert.equal(end.warn, true);
  assert.ok(end.text.includes("(partial: "));
  assert.equal(end.text.split(signedOutMessage).length, 2); // the reason appears once
});

test("(c) a diary picture ends up in media/ in the zip with `media` set, and its raw link appears nowhere in data.json or index.html", async () => {
  const raw = "https://cdn.example.org/diary-only.png";
  const signed = "https://s3-us-west-1.amazonaws.com/replika-content-images/diary-only?sig=leak-only-xyz";
  const fetchFn = fakeFetch((url, init) => {
    if (url === LIST_URL()) return reply([li("2026-02-01", "First")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) return reply({ date: "2026-02-01", entries: [{ id: "e1", timestamp: "t", text: "hello", images: [{ url: raw, blurred: true, is_romantic: false }] }] });
    if (url === MEMORY_14) return reply({ facts: [] });
    if (url === MEMORY_15) return reply({ customer_facts: [], robot_facts: [] });
    if (url === GET_URL) return JSON.parse(init.body).image_url === raw ? reply({ image_url: signed }) : reply({}, 404);
    if (url === signed) return bytes(PNG, "image/png");
    throw new Error(`unexpected fetch ${url}`);
  });
  const { data, parts } = await runSave({
    auth: AUTH, now: new Date(2026, 10, 25, 14, 30, 5), fetchFn, sleep: instant,
    WebSocketCtor: fakeSocketClass([[]]), timeoutMs: 1000, pause: instant,
  });
  assert.equal(data.counts.media, 1, "a diary picture counts as media");
  assert.equal(data.counts.diary, 1);
  const img = data.diary[0].entries[0].images[0];
  assert.deepEqual(img, { kind: "images", id: "e1-0", blurred: true, is_romantic: false, media: "media/e1-0.png" });
  const dir = mkdtempSync(join(tmpdir(), "leket-replika-"));
  try {
    const file = join(dir, "replika-diary.zip");
    writeFileSync(file, Buffer.from(await parts[0].blob.arrayBuffer()));
    const out = JSON.parse(execFileSync("python3", ["-I", "-c",
      "import json,sys,zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({'names': z.namelist(), 'data': z.read('data.json').decode('utf-8'), 'html': z.read('index.html').decode('utf-8'), 'png': list(z.read('media/e1-0.png'))}))",
      file], { encoding: "utf8" }));
    assert.ok(out.names.includes("media/e1-0.png"));
    assert.deepEqual(out.png, [...PNG]);
    for (const secret of [raw, signed, "leak-only-xyz", ...LEAKS]) {
      assert.ok(!out.data.includes(secret) && !out.html.includes(secret), `a link leaked: ${secret.slice(0, 30)}`);
    }
    assert.ok(out.html.includes('<img loading="lazy" src="media/e1-0.png"'), "index.html shows the picture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(d) a diary picture whose sign call fails gets a fixed not_captured, shown and counted", async () => {
  const fetchFn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) return reply({ date: "2026-02-01", entries: [{ id: "e1", text: "hello", images: [{ url: "https://cdn.example.org/diary-fail.png" }, { blurred: false }] }] });
    if (url === MEMORY_14) return reply({ facts: [] });
    if (url === MEMORY_15) return reply({ customer_facts: [], robot_facts: [] });
    if (url === GET_URL) return reply({ detail: AUTH.authToken }, 404);
    throw new Error(`unexpected fetch ${url}`);
  });
  const { data } = await runSave({
    auth: AUTH, now: new Date(2026, 10, 25, 14, 30, 5), fetchFn, sleep: instant,
    WebSocketCtor: fakeSocketClass([[]]), timeoutMs: 1000, pause: instant,
  });
  const [failed, unusable] = data.diary[0].entries[0].images;
  assert.equal(failed.media, undefined);
  assert.equal(failed.not_captured, "Replika answered HTTP 404"); // the fixed text, never the body
  assert.equal(unusable.not_captured, MEDIA_LINK_UNUSABLE);
  assert.equal(data.counts.media, 0);
  assert.ok(!JSON.stringify(data).includes(AUTH.authToken));
  assert.ok(render(data).includes("picture not saved: Replika answered HTTP 404"));
  assert.ok(problems(data).some((l) => l.startsWith("1 item(s) not saved: Replika answered HTTP 404")), JSON.stringify(problems(data)));
  assert.ok(endLine({ filename: "x.zip", data }).text.includes("2 item(s) not saved"));
});

test("a chat that stops early keeps its messages, names the reason, and the rest still saves", async () => {
  const Socket = fakeSocketClass([
    [msg("m1", "2026-06-01T10:00:00Z")],
    "close", // the socket dies after the first batch
  ]);
  const fetchFn = fakeFetch((url) => {
    if (url.startsWith(DIARY_LIST_URL)) return reply([]);
    if (url === MEMORY_14) return reply({ facts: [] });
    if (url === MEMORY_15) return reply({ customer_facts: [], robot_facts: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
  const { data } = await runSave({
    auth: AUTH, leketVersion: "0.4.0", now: new Date(2026, 10, 25, 14, 30, 5),
    fetchFn, sleep: instant, WebSocketCtor: Socket, timeoutMs: 1000, pause: instant,
  });
  assert.equal(data.status.chat, HISTORY_CLOSED);
  assert.equal(data.counts.messages, 1); // what the socket delivered before dying
  assert.equal(data.status.diary, "complete");
  assert.equal(data.status.memories, "complete");
});

test("an empty run — no messages, no diary, no memories — still saves a zip", async () => {
  const Socket = fakeSocketClass([[]]);
  const fetchFn = fakeFetch((url) => {
    if (url.startsWith(DIARY_LIST_URL)) return reply([]);
    if (url === MEMORY_14) return reply({ facts: [] });
    if (url === MEMORY_15) return reply({ customer_facts: [], robot_facts: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
  const { data, parts, filename } = await runSave({
    auth: { ...AUTH, userName: null, botName: null }, leketVersion: "0.4.0", now: new Date(2026, 10, 25, 14, 30, 5),
    fetchFn, sleep: instant, WebSocketCtor: Socket, timeoutMs: 1000, pause: instant,
  });
  assert.deepEqual(data.counts, { messages: 0, diary: 0, memories: 0, media: 0 });
  assert.deepEqual(data.names, { you: "You", replika: "Replika" });
  assert.equal(data.status.chat, "complete");
  assert.equal(parts.length, 1);
  assert.equal(filename, "replika-2026-11-25-143005.zip");
  const html = render(data);
  assert.ok(html.includes("No messages came back for this save."));
});

test("a voice clip whose link is unusable says voice clip, not picture, in its reason", async () => {
  const at = { nature: "Robot", timestamp: "2026-06-01T00:00:00Z" };
  assert.equal(buildMessage({ id: "v0", content: { type: "voice_message" }, meta: at }).record.not_captured, MEDIA_VOICE_LINK_UNUSABLE);
  assert.equal(buildMessage({ id: "i0", content: { type: "images" }, meta: at }).record.not_captured, MEDIA_LINK_UNUSABLE);
  const plans = [planFor("v1", "voice_message", "http://cdn.example.org/clip.m4a")]; // not https
  const fetchFn = fakeFetch(() => { throw new Error("no fetch expected"); });
  await collectMedia(plans, { auth: AUTH, fetchFn, sleep: instant, pause: instant });
  assert.equal(plans[0].record.not_captured, MEDIA_VOICE_LINK_UNUSABLE);
  assert.equal(fetchFn.calls.length, 0);
});

test("render escapes a speaker name exactly once in the memory headings", () => {
  const html = render({
    names: { you: "Ada & Bo", replika: "<Echo>" }, status: {}, counts: {},
    messages: [], diary: [], memories: { facts: [], about_you: [], about_replika: [] },
  });
  assert.ok(html.includes("<h3>About Ada &amp; Bo</h3>"));
  assert.ok(html.includes("<h3>About &lt;Echo&gt;</h3>"));
  assert.ok(!html.includes("&amp;amp;") && !html.includes("&amp;lt;"));
});

// ---------- an unexpected throw never puts its text in an output ----------

const THROWN = "quokka-trace-7731"; // distinctive, and not key-shaped

test("(b) an unexpected throw in readDiary gives the fixed STEP_FAILED reason and its text reaches no output", async () => {
  const fetchFn = fakeFetch((url) => {
    // a list answer whose item throws when read: nothing readDiary catches itself
    if (url === LIST_URL()) return () => ({ ok: true, status: 200, json: async () => [{ get date() { throw new Error(THROWN); } }] });
    if (url === MEMORY_14) return reply({ facts: [] });
    if (url === MEMORY_15) return reply({ customer_facts: [], robot_facts: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
  const { data } = await runSave({
    auth: AUTH, now: new Date(2026, 10, 25, 14, 30, 5), fetchFn, sleep: instant,
    WebSocketCtor: fakeSocketClass([[]]), timeoutMs: 1000, pause: instant,
  });
  assert.equal(data.status.diary, STEP_FAILED);
  assert.equal(data.status.memories, "complete"); // the next step still ran
  assert.ok(!JSON.stringify(data).includes(THROWN));
  assert.ok(!render(data).includes(THROWN));
  assert.ok(!problems(data).join("\n").includes(THROWN));
  assert.ok(!endLine({ filename: "x.zip", data }).text.includes(THROWN));
});

test("(a) a plain Error thrown by the sign call gives MEDIA_SIGN_FAILED and its text reaches no output", async () => {
  const fetchFn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) return reply({ date: "2026-02-01", entries: [{ id: "e1", text: "hi", images: [{ url: "https://cdn.example.org/sign-throw.png" }] }] });
    if (url === MEMORY_14) return reply({ facts: [] });
    if (url === MEMORY_15) return reply({ customer_facts: [], robot_facts: [] });
    // a sign reply whose read throws something that is not an ApiError
    if (url === GET_URL) return () => ({ get ok() { throw new Error(THROWN); } });
    throw new Error(`unexpected fetch ${url}`);
  });
  const { data } = await runSave({
    auth: AUTH, now: new Date(2026, 10, 25, 14, 30, 5), fetchFn, sleep: instant,
    WebSocketCtor: fakeSocketClass([[]]), timeoutMs: 1000, pause: instant,
  });
  assert.equal(data.diary[0].entries[0].images[0].not_captured, MEDIA_SIGN_FAILED);
  assert.ok(!JSON.stringify(data).includes(THROWN));
  assert.ok(!render(data).includes(THROWN));
});

test("problems labels the diary list's unsaved fields apart from the days'", () => {
  const lines = problems({ unsaved_fields: { message: {}, diary_list: { read: 1 }, diary: { "entries[].diary_id": 1 }, fact: {} } });
  assert.deepEqual(lines, [
    "Fields Leket didn't save (diary list): read",
    "Fields Leket didn't save (diary): entries[].diary_id",
  ]);
});

test("runSave: counts diary entries, not days, and tallies the v3 memory list's persons", async () => {
  const fetchFn = fakeFetch((url) => {
    if (url === LIST_URL()) return reply([li("2026-02-01")]);
    if (url === LIST_URL("2026-02-01")) return reply([]);
    if (url === DAY_URL("2026-02-01")) {
      return reply({ date: "2026-02-01", entries: [{ id: "e1", timestamp: "t", text: "a", images: [] }, { id: "e2", timestamp: "t", text: "b", images: [] }] });
    }
    if (url === MEMORY_14) return reply({ facts: [] });
    if (url === MEMORY_15) return reply({ customer_facts: [], robot_facts: [], persons: [{ id: "p1", name: "Someone" }] });
    throw new Error(`unexpected fetch ${url}`);
  });
  const { data } = await runSave({
    auth: AUTH, now: new Date(2026, 10, 25, 14, 30, 5), fetchFn, sleep: instant,
    WebSocketCtor: fakeSocketClass([[]]), timeoutMs: 1000, pause: instant,
  });
  assert.equal(data.diary.length, 1);
  assert.equal(data.counts.diary, 2);
  assert.deepEqual(data.unsaved_fields.person, { id: 1, name: 1 });
  assert.equal(JSON.stringify(data).includes("Someone"), false, "a person's fields are tallied by name only");
});

test("readMemories: the older v1.4 list answering 404 is no older facts, not a partial", async () => {
  const fn = fakeFetch((url) => (url === MEMORY_14 ? reply({}, 404) : reply({ customer_facts: [{ text: "x" }], robot_facts: [] })));
  const out = await readMemories({ auth: AUTH, fetchFn: fn, sleep: instant });
  assert.equal(out.partial, null);
  assert.equal(out.customerFacts.length, 1);
  const fn500 = fakeFetch((url) => (url === MEMORY_14 ? reply({}, 500) : reply({ customer_facts: [], robot_facts: [] })));
  assert.equal((await readMemories({ auth: AUTH, fetchFn: fn500, sleep: instant })).partial, MEMORY_V14_PARTIAL);
});

test("builders keep the run-1 fields in their plain types only", () => {
  const { record } = buildMessage({
    id: "m1", meta: { nature: "Robot", timestamp: "t" }, content: { type: "text", text: "now", originalText: "before" },
    avatarEmotion: { name: "happy" }, is_romantic: false, blurred: "yes",
  });
  assert.equal(record.original_text, "before");
  assert.equal(record.emotion, "happy");
  assert.equal(record.is_romantic, false);
  assert.equal("blurred" in record, false, "a non-boolean flag is dropped");
  assert.equal(buildMessage({ meta: {}, content: { type: "text" }, avatarEmotion: { name: { x: 1 } } }).record.emotion, undefined);
  const day = buildDiary({ date: "2026-02-01", entries: [{ id: "e1", text: "a", reaction: "love", images: [] }, { id: "e2", reaction: { o: 1 }, images: [] }] }, null);
  assert.equal(day.record.entries[0].reaction, "love");
  assert.equal("reaction" in day.record.entries[1], false);
  const fact = buildFact({ id: 1, text: "t", category_id: 7, is_user_edited: true }, "you");
  assert.equal(fact.category_id, 7);
  assert.equal(fact.edited, true);
  assert.equal("edited" in buildFact({ text: "t", is_user_edited: "no" }, null), false);
});
