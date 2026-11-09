// The claude-sessions module's pure halves, ported from the console scripts
// dev-docs/browser/claude-sessions-rename.js and claude-sessions-delete.js — the scripts
// are the spec. Everything runs against an injected fetch stand-in: no test may open a
// socket, and the scripts' proven guards (first-rename-stops, first-delete-verified-gone,
// confirm-count-matches) are pinned here one by one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// a red line under every test, like reddit.test.js: an un-injected fetch is a bug
globalThis.fetch = async () => { throw new Error("no network in tests: inject a fetch stand-in"); };

const { parseRenames, sid, orderRenames, renameAll, currentTitles } = await import("../src/modules/claude-sessions/rename.js");
const { listSessions } = await import("../src/modules/claude-sessions/listing.js");
const { checkPrefix, findHits, deleteGuard, confirmHits, deleteAll } = await import("../src/modules/claude-sessions/delete.js");

// a stand-in fetch that routes on method + pathname, and remembers every call. A route
// answers with { status?, json?, text? }; no status means 200 OK.
const apiFetch = (routes) => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts, method: opts.method || "GET" });
    const u = new URL(url);
    const route = routes.find(([m, p]) => (opts.method || "GET") === m && u.pathname === p);
    if (!route) throw new Error(`no stand-in for ${(opts.method || "GET")} ${url}`);
    const out = await route[2](u, opts);
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      json: async () => (out.json !== undefined ? out.json : JSON.parse(out.text ?? "{}")),
      text: async () => out.text ?? JSON.stringify(out.json ?? {}),
    };
  };
  return { calls, fetch };
};

const session = (id, title) => ({ id, title });

// --- listing.js: cursor paging across active, paused, archived

test("one page per status with no cursor stops: one fetch per status, absolute URL", async () => {
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions", (u) => {
      const st = u.searchParams.get("statuses");
      return { json: { data: [session(`${st}-1`, "a")], next_cursor: null } };
    }],
  ]);
  const sessions = await listSessions({ fetch });
  assert.deepEqual([...sessions.keys()], ["active-1", "paused-1", "archived-1"]);
  assert.equal(calls.length, 3, "one fetch per status, then the missing cursor stops");
  for (const [i, st] of ["active", "paused", "archived"].entries()) {
    assert.equal(calls[i].url, `https://claude.ai/v1/code/sessions?statuses=${st}&limit=50`,
      "the fetch is absolute (an extension page's origin is chrome-extension://) and capped at 50");
    assert.ok(calls[i].opts.signal instanceof AbortSignal, "the fetch carries an abort timeout");
    assert.deepEqual(calls[i].opts, {
      credentials: "include",
      headers: { "anthropic-version": "2023-06-01" },
      signal: calls[i].opts.signal,
    }, "the login and version header ride along with the timeout signal");
  }
  assert.notEqual(calls[0].opts.signal, calls[1].opts.signal, "a fresh timeout signal per fetch");
});

test("a listing fetch that rejects with a TimeoutError DOMException surfaces an error", async () => {
  const fetch = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  await assert.rejects(
    listSessions({ fetch }),
    (e) => e.name === "TimeoutError" && /timed? ?out/i.test(e.message),
  );
});

test("a page with items and a next_cursor continues: the next fetch carries the cursor", async () => {
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions", (u) => {
      const st = u.searchParams.get("statuses");
      const cursor = u.searchParams.get("cursor");
      if (!cursor) return { json: { data: [session(`${st}-1`, "a")], next_cursor: `cur-${st}-2` } };
      if (cursor === `cur-${st}-2`) return { json: { data: [session(`${st}-2`, "b")], next_cursor: "" } };
      throw new Error(`unexpected cursor ${cursor}`);
    }],
  ]);
  const sessions = await listSessions({ fetch });
  assert.equal(calls.length, 6, "two pages per status");
  assert.equal(calls[1].url, "https://claude.ai/v1/code/sessions?statuses=active&limit=50&cursor=cur-active-2");
  assert.ok(sessions.has("active-2"), "the second page's items joined");
});

test("a repeating cursor stops instead of looping forever", async () => {
  // the scripts' do/while would spin forever if the server kept handing the same
  // cursor back; the port must notice and stop
  let spins = 0;
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions", () => {
      spins++;
      return { json: { data: [session(`s-${spins}`, "a")], next_cursor: "the-same-cursor" } };
    }],
  ]);
  const sessions = await listSessions({ fetch });
  assert.ok(calls.length < 10, `stopped after ${calls.length} calls, not forever`);
  assert.ok(sessions.size >= 1, "what arrived before the repeat is kept");
});

test("a repeating cursor stops EXACTLY at 2 calls per status, 6 total", async () => {
  // the trace: the first fetch hands back the cursor (call 1), the second runs with it
  // (call 2), and the break fires on the iteration after the cursor is seen twice — so
  // each status costs exactly 2 calls, and the walk moves on to the next status
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions", () => ({ json: { data: [session("dup", "a")], next_cursor: "the-same-cursor" } })],
  ]);
  const sessions = await listSessions({ fetch });
  assert.equal(calls.length, 6, "2 calls per status × 3 statuses, no more");
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get("statuses")),
    ["active", "active", "paused", "paused", "archived", "archived"],
    "each status is walked twice, then the repeating cursor stops it");
  assert.equal(sessions.get("dup").title, "a", "what arrived is kept");
});

test("an empty page (no items) stops even if a cursor came with it", async () => {
  // the script's rule: cursor = data.length ? next_cursor : null — an empty page ends
  // the walk whatever the cursor says
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions", (u) => u.searchParams.get("cursor")
      ? { json: { data: [], next_cursor: "never-followed" } }
      : { json: { data: [session("only-one", "a")], next_cursor: "never-followed" } }],
  ]);
  await listSessions({ fetch });
  assert.equal(calls.length, 6, "two fetches per status: the first page, then the empty one — and the cursor it carried is never followed (a third fetch per status would be 9)");
});

test("sessions seen under one status are not listed twice under another", async () => {
  const { fetch } = apiFetch([
    ["GET", "/v1/code/sessions", (u) => {
      const st = u.searchParams.get("statuses");
      return { json: { data: [session("shared-id", `titled in ${st}`), session(`${st}-own`, "x")], next_cursor: null } };
    }],
  ]);
  const sessions = await listSessions({ fetch });
  assert.equal(sessions.size, 4, "3 own + 1 shared, deduped by id");
  assert.ok(sessions.has("shared-id"), "the shared id is in the map once (the script's Map.set: a later status overwrites, the id never duplicates)");
});

test("a listing page without a data array stops the walk naming the shape, never a green empty list", async () => {
  // an error body, a renamed field or null data would otherwise read as "0 sessions"
  for (const body of [{}, { data: null }, { error: { type: "x" } }, { sessions: [session("a", "t")] }, { data: "nope" }]) {
    const { fetch } = apiFetch([["GET", "/v1/code/sessions", () => ({ json: body })]]);
    await assert.rejects(listSessions({ fetch }), /Listing (active|paused|archived) sessions failed: no data list \(the API shape changed\)/,
      JSON.stringify(body));
  }
});

// --- rename.js: parsing, id normalization, ordering, the run

test("parseRenames refuses an id listed twice, cse_ and session_ forms counting as the same session", () => {
  for (const pair of [["cse_abc", "cse_abc"], ["cse_abc", "session_abc"], ["abc", "session_abc"]]) {
    assert.throws(() => parseRenames(JSON.stringify([[pair[0], "One"], ["cse_other", "x"], [pair[1], "Two"]])),
      (e) => e.message.includes(pair[1]) && /twice|more than once/.test(e.message), pair.join(" / "));
  }
  // positive control: distinct ids still parse
  assert.equal(parseRenames('[["cse_abc","One"],["cse_abd","Two"]]').length, 2);
});

test("parseRenames takes the bare JSON array", () => {
  const list = parseRenames('[["cse_abc","New title"],["session_def","Other"]]');
  assert.deepEqual(list, [["cse_abc", "New title"], ["session_def", "Other"]]);
});

test("parseRenames takes the whole pasted window.CLAUDE_RENAMES line", () => {
  const line = 'window.CLAUDE_RENAMES = [["cse_abc","New title"],["session_def","Other"]];';
  assert.deepEqual(parseRenames(line), [["cse_abc", "New title"], ["session_def", "Other"]]);
  // and without the trailing semicolon
  assert.deepEqual(parseRenames(line.slice(0, -1)), [["cse_abc", "New title"], ["session_def", "Other"]]);
});

test("parseRenames takes the whole generated file pasted as-is: the line, then the script", () => {
  // the shape dev-docs/browser/claude-sessions-rename.js's header names: the list line,
  // then the script, whose own `;` line ends and RENAMES mention must not leak in
  const script = "(async () => {\n  const list = window.CLAUDE_RENAMES || [];\n  console.log(list.length);\n})();\n";
  const file = `window.CLAUDE_RENAMES = [["cse_abc","New title"],["session_def","Other"]];\n${script}`;
  assert.deepEqual(parseRenames(file), [["cse_abc", "New title"], ["session_def", "Other"]]);
  assert.deepEqual(parseRenames(file.replace(/\n/g, "\r\n")), [["cse_abc", "New title"], ["session_def", "Other"]]);
});

test("parseRenames refuses junk with a message that says what to paste", () => {
  for (const junk of ["not json at all", '{"a":1}', "[]", '[["one-element"]]', '[["id", 42]]']) {
    assert.throws(() => parseRenames(junk), /window\.CLAUDE_RENAMES|bare JSON array|\[id, title\]/, junk);
  }
});

test("parseRenames rejects an id that isn't a session id, naming it and the shape", () => {
  // a traversal or an injection pasted as an id must never reach the session URL:
  // parseRenames is the one place every paste id can be stopped
  for (const bad of ["x/../../api/foo", "drop table; --"]) {
    assert.throws(() => parseRenames(`[["${bad}", "New title"]]`),
      (e) => e.message.includes(bad) && /cse_|session_|letters|digits/.test(e.message),
      `the id ${JSON.stringify(bad)} had to be refused, named in the error`);
  }
});

test("a well-formed id's session URL is byte-identical (encodeURIComponent is a no-op on it)", async () => {
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions/session_abc123", () => ({ json: { response_shape: { title: "t" } } })],
  ]);
  await currentTitles([["cse_abc123", "T"]], { fetch });
  assert.equal(calls[0].url, "https://claude.ai/v1/code/sessions/session_abc123",
    "the URL is exactly the plain one — no percent-encoding appears for a normal id");
});

test("sid normalizes cse_ and session_ forms to the rename URL's session_ form", () => {
  assert.equal(sid("cse_abc123"), "session_abc123");
  assert.equal(sid("session_abc123"), "session_abc123");
  assert.equal(sid("abc123"), "session_abc123");
});

test("orderRenames moves the first entry that still needs its rename to the front", () => {
  const list = [["a", "T1"], ["b", "T2"], ["c", "T3"]];
  // a is already at target, b is not: b moves to the front, the rest keep their order
  const ordered = orderRenames(list, new Map([["a", "T1"], ["b", "old"], ["c", "T3"]]));
  assert.deepEqual(ordered, [["b", "T2"], ["a", "T1"], ["c", "T3"]]);
});

test("orderRenames leaves an already-ordered list alone when the head is a real change", () => {
  const list = [["a", "T1"], ["b", "T2"]];
  const ordered = orderRenames(list, new Map([["a", "old"], ["b", "T2"]]));
  assert.deepEqual(ordered, list);
});

test("orderRenames reports nothing-to-change when every entry is already at target", () => {
  const list = [["a", "T1"], ["b", "T2"]];
  // the first rename is the proof the PUT works, so an all-at-target list must not run
  assert.equal(orderRenames(list, new Map([["a", "T1"], ["b", "T2"]])), null);
});

test("renameAll renames each session with a PUT and reads it back before counting it", async () => {
  const titles = new Map([["session_a", "old a"], ["session_b", "old b"]]);
  const { calls, fetch } = apiFetch([
    ["PUT", "/v1/code/sessions/session_a", (u, opts) => {
      assert.equal(JSON.parse(opts.body).title, "New a");
      titles.set("session_a", "New a");
      return {};
    }],
    ["PUT", "/v1/code/sessions/session_b", (u, opts) => {
      titles.set("session_b", "New b");
      return {};
    }],
    ["GET", "/v1/code/sessions/session_a", () => ({ json: { response_shape: { title: titles.get("session_a") } } })],
    ["GET", "/v1/code/sessions/session_b", () => ({ json: { response_shape: { title: titles.get("session_b") } } })],
  ]);
  const done = await renameAll([["cse_a", "New a"], ["session_b", "New b"]], { fetch });
  assert.equal(done.stopped, false);
  assert.equal(done.ok, 2);
  assert.deepEqual(done.failed, []);
  assert.equal(calls.length, 4, "a PUT and a read-back per rename");
  assert.equal(calls[0].url, "https://claude.ai/v1/code/sessions/session_a");
  assert.equal(calls[0].opts.credentials, "include");
  assert.equal(calls[2].opts.headers["anthropic-version"], "2023-06-01");
  assert.ok(calls.every((c) => c.opts.signal instanceof AbortSignal), "every rename/read fetch carries a timeout signal");
  assert.equal(new Set(calls.map((c) => c.opts.signal)).size, calls.length, "a fresh timeout signal per fetch");
});

test("a read-back that shows the old title fails that rename", async () => {
  const { fetch } = apiFetch([
    ["PUT", "/v1/code/sessions/session_a", () => ({})],
    ["GET", "/v1/code/sessions/session_a", () => ({ json: { response_shape: { title: "still the old one" } } })],
  ]);
  const done = await renameAll([["cse_a", "New a"]], { fetch });
  assert.equal(done.ok, 0);
  assert.match(done.failed[0], /read back "still the old one"/);
});

test("a failed first rename (PUT refused, or PUT unanswered) stops the whole list: nothing else is attempted", async () => {
  const puts = [];
  const { fetch } = apiFetch([
    ["PUT", "/v1/code/sessions/session_a", () => ({ status: 500, text: "server exploded" })],
    ["PUT", "/v1/code/sessions/session_b", (u, opts) => { puts.push(u.pathname); return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => ({ status: 500 })],
    ["GET", "/v1/code/sessions/session_b", () => ({ json: { response_shape: { title: "New b" } } })],
  ]);
  const done = await renameAll([["cse_a", "New a"], ["session_b", "New b"]], { fetch });
  assert.equal(done.stopped, true, "the first rename's failure stops the list");
  assert.equal(done.error, "Stopped: the first rename didn't take (rename 500: server exploded). Nothing else was changed.");
  assert.deepEqual(done.failed, ["cse_a: rename 500: server exploded"]);
  assert.deepEqual(puts, [], "session_b was never touched");
  assert.equal(done.ok, 0);

  const thrown = await renameAll([["cse_a", "New a"], ["session_b", "New b"]], {
    fetch: async () => { throw new Error("network down"); },
  });
  assert.equal(thrown.stopped, true);
  // a PUT that throws may still have reached the server: no "didn't take" claim
  assert.equal(thrown.error, "Stopped: the first rename got no answer (network down) — it may have taken; check that session. Nothing else was changed.");
  assert.deepEqual(thrown.failed, ["cse_a: network down"]);
  assert.equal(thrown.ok, 0);
});

test("a read-back MISMATCH or throw at index 0 after a 2xx PUT stops with the accepted-but-check-failed message", async () => {
  const puts = [];
  const { fetch } = apiFetch([
    ["PUT", "/v1/code/sessions/session_a", () => { puts.push("a"); return {}; }],
    ["PUT", "/v1/code/sessions/session_b", () => { puts.push("b"); return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => ({ json: { response_shape: { title: "old a" } } })],
    ["GET", "/v1/code/sessions/session_b", () => ({ json: { response_shape: { title: "New b" } } })],
  ]);
  const done = await renameAll([["cse_a", "New a"], ["session_b", "New b"]], { fetch });
  assert.equal(done.stopped, true, "the first rename's read-back mismatch stops the list");
  assert.equal(
    done.error,
    'Stopped: the first rename was accepted, but its check failed (read back "old a") — it may have taken (the server can also normalise a title); check that session. Nothing else was changed.',
  );
  assert.deepEqual(done.failed, ['cse_a: read back "old a"']);
  assert.deepEqual(puts, ["a"], "session_b's PUT never fired");
  assert.equal(done.ok, 0);

  const checkThrew = await renameAll([["cse_a", "New a"], ["session_b", "New b"]], {
    fetch: apiFetch([
      ["PUT", "/v1/code/sessions/session_a", () => ({})],
      ["GET", "/v1/code/sessions/session_a", () => { throw new Error("read-back boom"); }],
    ]).fetch,
  });
  assert.equal(checkThrew.stopped, true);
  assert.equal(
    checkThrew.error,
    "Stopped: the first rename was accepted, but its check failed (read-back boom) — it may have taken (the server can also normalise a title); check that session. Nothing else was changed.",
  );
  assert.deepEqual(checkThrew.failed, ["cse_a: read-back boom"]);
  assert.equal(checkThrew.ok, 0);
});

test("a later rename with no answer or an unverified check says it may have taken; a refusal doesn't", async () => {
  const { fetch } = apiFetch([
    ["PUT", "/v1/code/sessions/session_a", () => ({})],
    ["GET", "/v1/code/sessions/session_a", () => ({ json: { response_shape: { title: "New a" } } })],
    ["PUT", "/v1/code/sessions/session_b", () => { throw new Error("network down"); }],
    ["PUT", "/v1/code/sessions/session_c", () => ({})],
    ["GET", "/v1/code/sessions/session_c", () => ({ json: { response_shape: { title: "old c" } } })],
    ["PUT", "/v1/code/sessions/session_d", () => ({ status: 500, text: "nope" })],
  ]);
  const done = await renameAll([["cse_a", "New a"], ["cse_b", "New b"], ["cse_c", "New c"], ["cse_d", "New d"]], { fetch });
  assert.equal(done.stopped, false);
  assert.equal(done.ok, 1);
  assert.deepEqual(done.failed, [
    "cse_b: no answer (network down) — it may have taken; check that session",
    'cse_c: accepted, but its check failed (read back "old c") — it may have taken (the server can also normalise a title); check that session',
    "cse_d: rename 500: nope",
  ]);
  assert.equal(done.uncertain, 2);
});

test("currentTitles reads each entry's title live, keyed by the id the list carries", async () => {
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions/session_a", () => ({ json: { response_shape: { title: "now a" } } })],
    ["GET", "/v1/code/sessions/session_b", () => ({ json: { response_shape: { title: "now b" } } })],
  ]);
  const titles = await currentTitles([["cse_a", "T1"], ["session_b", "T2"]], { fetch });
  assert.equal(titles.get("cse_a"), "now a");
  assert.equal(titles.get("session_b"), "now b");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
  assert.notEqual(calls[0].opts.signal, calls[1].opts.signal, "a fresh timeout signal per fetch");
});

test("a malformed read throws before any ordering: the script changes nothing when it can't verify a shape", async () => {
  // the script's titleOf throws 'read: no response_shape.title (the API shape changed)'
  // during the ordering loop — no PUT goes out. Storing null instead would promote that
  // entry to first and rename it before the run discovers the read-back can't be verified.
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions/session_a", () => ({ json: { response_shape: {} } })],
    ["PUT", "/v1/code/sessions/session_a", () => { throw new Error("no PUT may happen"); }],
  ]);
  await assert.rejects(currentTitles([["cse_a", "T1"]], { fetch }), /no response_shape\.title/);
  assert.equal(calls.length, 1, "the walk stopped at the bad read; no PUT followed");
});

// --- delete.js: the prefix, the guard, the first-delete read-back

test("a whitespace-only or empty prefix is refused", () => {
  assert.throws(() => checkPrefix(""), /prefix/);
  assert.throws(() => checkPrefix("   "), /prefix/);
  assert.throws(() => checkPrefix(), /prefix/);
  assert.equal(checkPrefix("Test · outbox sync · "), "Test · outbox sync · ",
    "a real prefix passes through untouched, trailing space included");
});

test("findHits matches sessions whose title starts with the prefix", () => {
  const sessions = new Map([
    ["1", session("1", "Test · outbox sync · a")],
    ["2", session("2", "Test · something else")],
    ["3", session("3", "unrelated")],
    ["4", session("4", null)], // a session with no title is no hit
  ]);
  const hits = findHits(sessions, "Test · outbox sync · ");
  assert.deepEqual(hits.map((s) => s.id), ["1"]);
});

test("an empty prefix matches EVERY session — so the refusal must happen at capture, before any await", () => {
  // why the page reads the prefix box once and refuses the empty one before the
  // listing runs: startsWith("") is true for everything, and a mid-run edit to ""
  // would otherwise re-target the delete onto all sessions
  const sessions = new Map([["1", session("1", "a")], ["2", session("2", "b")]]);
  assert.equal(findHits(sessions, "").length, 2);
});

test("page.js captures the prefix, confirm count and storedDryRun before the first await in delete-run", () => {
  const src = readFileSync(new URL("../src/modules/claude-sessions/page.js", import.meta.url), "utf8");
  // the handler itself, not the dry run's busy([…, $("delete-run")]) argument
  const from = src.indexOf('$("delete-run").addEventListener');
  assert.notEqual(from, -1, "found the delete-run handler");
  const to = src.indexOf("}));", from);
  assert.notEqual(to, -1, "found the end of the delete-run handler");
  // line comments dropped: the handler's own comment talks about "await"
  const slice = src.slice(from, to).replace(/\/\/.*$/gm, "");
  const firstAwait = slice.search(/\bawait\b/);
  assert.notEqual(firstAwait, -1, "the handler awaits");
  for (const expr of ['checkPrefix($("prefix").value)', '$("delete-confirm").value', "storedDryRun"]) {
    const pos = slice.indexOf(expr);
    assert.ok(pos !== -1 && pos < firstAwait, `${expr} must appear before the first await`);
  }
  // the capture is what the check uses: storedDryRun is read once, and confirmHits
  // takes the captured copy, never a post-await read of the live variable
  assert.equal(slice.split("storedDryRun").length - 1, 1, "storedDryRun is read exactly once");
  assert.match(slice, /confirmHits\(dry,/);
});

test("deleteGuard refuses when the typed count differs from the current count, naming both", () => {
  const hits = [session("1", "a"), session("2", "b"), session("3", "c")];
  for (const typed of ["2", "4", "", "two", "  "]) {
    const trimmed = typed.trim();
    assert.throws(() => deleteGuard(hits, typed),
      (e) => e.message.includes("3") && (trimmed ? e.message.includes(trimmed) : e.message.includes("nothing")),
      `typed ${JSON.stringify(typed)} had to be refused, naming both counts`);
  }
  assert.doesNotThrow(() => deleteGuard(hits, "3"));
  assert.doesNotThrow(() => deleteGuard(hits, 3));
});

test("deleteGuard accepts only plain decimal digits: 0x10 and 1e2 refuse even at the right value", () => {
  // Number() reads "0x10" as 16 and "1e2" as 100 — so to catch them, the fixture's hit
  // count must equal what Number() would make of them; anything less refuses anyway and
  // proves nothing about the digit shape
  const hits16 = Array.from({ length: 16 }, (_, i) => session(`cse_${i}`, `p · ${i}`));
  const hits100 = Array.from({ length: 100 }, (_, i) => session(`cse_${i}`, `p · ${i}`));
  for (const [hits, typed] of [[hits16, "0x10"], [hits100, "1e2"]]) {
    assert.throws(() => deleteGuard(hits, typed),
      (e) => e.message.includes(typed) && e.message.includes(String(hits.length)),
      `typed ${JSON.stringify(typed)} had to be refused, naming both counts`);
  }
});

test("deleteGuard refuses a decimal point: 1.5 is not a count of sessions", () => {
  const hits = [session("1", "a")];
  assert.throws(() => deleteGuard(hits, "1.5"),
    (e) => e.message.includes("1.5") && /but 1 session match(es)? now/.test(e.message),
    "the refusal names the typed string and the real hit count");
});

test("deleteGuard reads leading zeros as their decimal: 007 equals 7", () => {
  const hits = Array.from({ length: 7 }, (_, i) => session(`cse_${i}`, `p · ${i}`));
  assert.doesNotThrow(() => deleteGuard(hits, "007"));
});

test("confirmHits refuses with no stored dry run at all", () => {
  const hits = [session("1", "a")];
  assert.throws(() => confirmHits(null, "p", hits, "1"), /dry run first/);
});

test("confirmHits refuses a prefix edited after the dry run, naming both prefixes", () => {
  const hits = [session("1", "b · x")];
  assert.throws(() => confirmHits({ prefix: "a", ids: ["1"] }, "b", hits, "1"),
    (e) => e.message.includes('"a"') && e.message.includes('"b"'),
    "the refusal names the dry run's prefix and the box's current one");
});

test("confirmHits refuses a changed hit list even when the count is the same", () => {
  // the exact case the count-only guard missed: a session matching the prefix was
  // created (or renamed in) since the dry run, so both lists have 2 ids — but they
  // are different ones, and the count check alone would have deleted the newcomer
  const stored = { prefix: "p", ids: ["1", "2"] };
  const hits = [session("1", "p a"), session("3", "p c")];
  assert.throws(() => confirmHits(stored, "p", hits, "2"),
    (e) => e.message.includes("2 then") && e.message.includes("2 now"),
    "the refusal names both counts even though they coincide");
});

test("confirmHits passes a full match with the typed count", () => {
  const stored = { prefix: "p", ids: ["1", "2"] };
  const hits = [session("2", "p b"), session("1", "p a")]; // listing order may differ
  assert.doesNotThrow(() => confirmHits(stored, "p", hits, "2"));
  assert.doesNotThrow(() => confirmHits(stored, "p", hits, 2));
});

test("confirmHits still refuses a wrong typed count on a full match", () => {
  const stored = { prefix: "p", ids: ["1", "2"] };
  const hits = [session("1", "p a"), session("2", "p b")];
  assert.throws(() => confirmHits(stored, "p", hits, "3"), /2 sessions? match now/);
});

test("the first delete is verified present (200), deleted, and verified gone (404) before the rest run", async () => {
  const goneIds = new Set();
  const firstGets = [];
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b"), session("cse_c", "p · c")];
  const { calls, fetch } = apiFetch([
    ["DELETE", "/v1/code/sessions/session_a", () => { goneIds.add("a"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_b", () => { goneIds.add("b"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_c", () => { goneIds.add("c"); return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => {
      const status = goneIds.has("a") ? 404 : 200;
      firstGets.push(status);
      return status === 404 ? { status: 404 } : { status: 200, json: {} };
    }],
    ["GET", "/v1/code/sessions/session_b", () => goneIds.has("b") ? { status: 404 } : { json: {} }],
    ["GET", "/v1/code/sessions/session_c", () => goneIds.has("c") ? { status: 404 } : { json: {} }],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.equal(done.stopped, false);
  assert.equal(done.deleted, 3);
  assert.deepEqual(done.failed, []);
  // hits[0] runs GET(200) → DELETE → GET(404) in that order before the second delete goes out
  assert.deepEqual(calls.slice(0, 4).map((c) => [c.method, new URL(c.url).pathname]), [
    ["GET", "/v1/code/sessions/session_a"],
    ["DELETE", "/v1/code/sessions/session_a"],
    ["GET", "/v1/code/sessions/session_a"],
    ["DELETE", "/v1/code/sessions/session_b"],
  ]);
  assert.deepEqual(firstGets, [200, 404]);
  assert.equal(calls[1].opts.credentials, "include", "the login rides along on the delete");
  assert.equal(calls[1].opts.headers["anthropic-version"], "2023-06-01", "the delete carries the version header");
  assert.ok(calls.every((c) => c.opts.signal instanceof AbortSignal), "every fetch carries a timeout signal");
  assert.equal(new Set(calls.map((c) => c.opts.signal)).size, calls.length, "a fresh timeout signal per fetch");
});

test("a precheck 404 before the first delete deletes nothing (no DELETE call made)", async () => {
  const deletes = [];
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b")];
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions/session_a", () => ({ status: 404 })],
    ["DELETE", "/v1/code/sessions/session_a", () => { deletes.push("a"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_b", () => { deletes.push("b"); return {}; }],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.deepEqual(done, {
    deleted: 0,
    failed: [],
    stopped: true,
    error: "The first session didn't read as present before the delete (answered 404), so a 404 afterwards would prove nothing: stopped, nothing deleted.",
  });
  assert.deepEqual(deletes, [], "no DELETE call was made");
  assert.equal(calls.length, 1);
});

test("a precheck that answers 500 deletes nothing: only a 200 counts as present", async () => {
  const deletes = [];
  const { fetch } = apiFetch([
    ["GET", "/v1/code/sessions/session_a", () => ({ status: 500, text: "boom" })],
    ["DELETE", "/v1/code/sessions/session_a", () => { deletes.push("a"); return {}; }],
  ]);
  const done = await deleteAll([session("cse_a", "p · a")], { fetch });
  assert.equal(done.stopped, true);
  assert.match(done.error, /answered 500/);
  assert.deepEqual(deletes, []);
});

test("a DELETE with no answer is never a plain failure: it may have been deleted", async () => {
  // first hit: the run stops, saying the delete may have happened
  const first = await deleteAll([session("cse_a", "p · a"), session("cse_b", "p · b")], {
    fetch: apiFetch([
      ["GET", "/v1/code/sessions/session_a", () => ({})],
      ["DELETE", "/v1/code/sessions/session_a", () => { throw new DOMException("The operation timed out.", "TimeoutError"); }],
    ]).fetch,
  });
  assert.equal(first.stopped, true);
  assert.equal(first.deleted, 0);
  assert.equal(first.error, "First delete got no answer (The operation timed out.) — it may have been deleted: stopped, nothing else deleted — check the session list before running again.");
  // a later hit: recorded with the same caveat, and the run goes on
  let gone = false;
  const later = await deleteAll([session("cse_a", "p · a"), session("cse_b", "p · b"), session("cse_c", "p · c")], {
    fetch: apiFetch([
      ["DELETE", "/v1/code/sessions/session_a", () => { gone = true; return {}; }],
      ["GET", "/v1/code/sessions/session_a", () => gone ? { status: 404 } : {}],
      ["DELETE", "/v1/code/sessions/session_b", () => { throw new Error("network down"); }],
      ["DELETE", "/v1/code/sessions/session_c", () => ({})],
    ]).fetch,
  });
  assert.equal(later.stopped, false);
  assert.equal(later.deleted, 2);
  assert.deepEqual(later.failed, ["p · b: no answer (network down) — it may have been deleted"]);
});

test("later DELETEs with no answer are counted apart from the refusals", async () => {
  let gone = false;
  const done = await deleteAll([session("cse_a", "p · a"), session("cse_b", "p · b"), session("cse_c", "p · c")], {
    fetch: apiFetch([
      ["DELETE", "/v1/code/sessions/session_a", () => { gone = true; return {}; }],
      ["GET", "/v1/code/sessions/session_a", () => gone ? { status: 404 } : {}],
      ["DELETE", "/v1/code/sessions/session_b", () => { throw new Error("network down"); }],
      ["DELETE", "/v1/code/sessions/session_c", () => ({ status: 403, text: "no" })],
    ]).fetch,
  });
  assert.equal(done.failed.length, 2);
  assert.equal(done.unanswered, 1, "only the thrown DELETE may have happened; the 403 didn't");
});

test("the precheck and read-back GETs cancel the body they never read", async () => {
  let gone = false;
  const cancelled = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    if (method === "DELETE") { gone = true; return { ok: true, status: 200 }; }
    const status = gone ? 404 : 200;
    return { ok: status < 400, status, body: { cancel: async () => { cancelled.push(status); } } };
  };
  const done = await deleteAll([session("cse_a", "p · a")], { fetch });
  assert.equal(done.deleted, 1);
  assert.deepEqual(cancelled, [200, 404]);
});

test("a precheck GET that throws deletes nothing (no DELETE call made)", async () => {
  const deletes = [];
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b")];
  const { calls, fetch } = apiFetch([
    ["GET", "/v1/code/sessions/session_a", () => { throw new Error("precheck boom"); }],
    ["DELETE", "/v1/code/sessions/session_a", () => { deletes.push("a"); return {}; }],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.deepEqual(done, {
    deleted: 0,
    failed: [],
    stopped: true,
    error: "The first session didn't read as present before the delete (precheck boom), so a 404 afterwards would prove nothing: stopped, nothing deleted.",
  });
  assert.deepEqual(deletes, [], "no DELETE call was made");
  assert.equal(calls.length, 1);
});

test("a read-back GET that THROWS after an OK first delete stops with its own message, deleted 0", async () => {
  const deletes = [];
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b")];
  const { fetch } = apiFetch([
    ["DELETE", "/v1/code/sessions/session_a", () => { deletes.push("a"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_b", () => { deletes.push("b"); return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => {
      if (deletes.includes("a")) throw new Error("read-back boom");
      return {};
    }],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.equal(done.stopped, true);
  assert.equal(done.deleted, 0, "the module promises VERIFIED deletes: an unverified one does not count");
  assert.deepEqual(deletes, ["a"], "nothing else was deleted");
  assert.match(done.error, /read-back failed/);
  assert.match(done.error, /nothing else deleted/);
  assert.match(done.error, /read-back boom/, "the thrown error's own text must reach the message");
  assert.doesNotMatch(done.error, /First delete failed/,
    "the delete succeeded; only the verification failed, and the message must not say otherwise");
});

test("a first delete that reads back alive (not 404) stops everything", async () => {
  const deletes = [];
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b")];
  const { fetch } = apiFetch([
    ["DELETE", "/v1/code/sessions/session_a", () => { deletes.push("a"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_b", () => { deletes.push("b"); return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => ({ json: { response_shape: { title: "still here" } } })],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.equal(done.stopped, true, "an OK first delete with a live read-back stops the run");
  assert.match(done.error, /answered 200, not 404/);
  assert.deepEqual(deletes, ["a"], "nothing else was deleted");
});

test("a read-back that answers a status other than 404 names it: 500 stops the run", async () => {
  const deletes = [];
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b")];
  const { fetch } = apiFetch([
    ["DELETE", "/v1/code/sessions/session_a", () => { deletes.push("a"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_b", () => { deletes.push("b"); return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => deletes.includes("a") ? { status: 500, text: "boom" } : {}],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.equal(done.stopped, true);
  assert.equal(done.deleted, 0);
  assert.deepEqual(deletes, ["a"], "nothing else was deleted");
  assert.match(done.error, /answered 500, not 404/);
});

test("a first delete that fails (non-OK) stops everything", async () => {
  const deletes = [];
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b")];
  const { fetch } = apiFetch([
    ["GET", "/v1/code/sessions/session_a", () => ({})],
    ["DELETE", "/v1/code/sessions/session_a", () => ({ status: 500, text: "no" })],
    ["DELETE", "/v1/code/sessions/session_b", () => { deletes.push("b"); return {}; }],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.equal(done.stopped, true);
  assert.match(done.error, /First delete failed/);
  assert.deepEqual(deletes, []);
});

test("a later delete that fails is recorded, and the rest still run", async () => {
  let gone = false;
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b"), session("cse_c", "p · c")];
  const { fetch } = apiFetch([
    ["DELETE", "/v1/code/sessions/session_a", () => { gone = true; return {}; }],
    ["DELETE", "/v1/code/sessions/session_b", () => ({ status: 409, text: "conflict" })],
    ["DELETE", "/v1/code/sessions/session_c", () => ({})],
    ["GET", "/v1/code/sessions/session_a", () => gone ? { status: 404 } : {}],
  ]);
  const done = await deleteAll(hits, { fetch });
  assert.equal(done.stopped, false);
  assert.equal(done.deleted, 2);
  assert.deepEqual(done.failed, ["p · b: delete 409: conflict"]);
});

test("onProgress counts the verified first delete: the sequence for 3 hits is [1, 2, 3]", async () => {
  const goneIds = new Set();
  const hits = [session("cse_a", "p · a"), session("cse_b", "p · b"), session("cse_c", "p · c")];
  const { fetch } = apiFetch([
    ["DELETE", "/v1/code/sessions/session_a", () => { goneIds.add("a"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_b", () => { goneIds.add("b"); return {}; }],
    ["DELETE", "/v1/code/sessions/session_c", () => { goneIds.add("c"); return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => goneIds.has("a") ? { status: 404 } : { json: {} }],
    ["GET", "/v1/code/sessions/session_b", () => goneIds.has("b") ? { status: 404 } : { json: {} }],
    ["GET", "/v1/code/sessions/session_c", () => goneIds.has("c") ? { status: 404 } : { json: {} }],
  ]);
  const seen = [];
  await deleteAll(hits, { fetch, onProgress: (d, t) => seen.push([d, t]) });
  assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]],
    "the verified first delete counts as progress; the bar never jumps 0 → 2");
});

test("onProgress for a single hit is just [1] — the verified first delete is the whole run", async () => {
  let gone = false;
  const { fetch } = apiFetch([
    ["DELETE", "/v1/code/sessions/session_a", () => { gone = true; return {}; }],
    ["GET", "/v1/code/sessions/session_a", () => gone ? { status: 404 } : {}],
  ]);
  const seen = [];
  await deleteAll([session("cse_a", "p · a")], { fetch, onProgress: (d, t) => seen.push([d, t]) });
  assert.deepEqual(seen, [[1, 1]]);
});

test("an empty hit list deletes nothing", async () => {
  const { calls, fetch } = apiFetch([]);
  const done = await deleteAll([], { fetch });
  // the same shape as a run that deleted: unanswered is there, not left to a default
  assert.deepEqual(done, { deleted: 0, failed: [], unanswered: 0, stopped: false });
  assert.equal(calls.length, 0);
});
