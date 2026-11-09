// The claude-sessions export command's pure half, ported from the console script
// dev-docs/browser/claude-sessions-export.js — the script is the spec. Everything runs
// against an injected fetch stand-in: no test may open a socket, and the invariants the
// design doc names (parts split only at session boundaries; a half-fetched session's
// lines are discarded; the done marker is written last) are pinned here one by one.
import { test } from "node:test";
import assert from "node:assert/strict";

// a red line under every test, like claude-chat.test.js: an un-injected fetch is a bug
globalThis.fetch = async () => { throw new Error("no network in tests: inject a fetch stand-in"); };

const { runKey, parseKnown, parseResume, exportSessions }
  = await import("../src/modules/claude-sessions/export.js");

// stand-in fetch keyed by full URL, remembering every call — the per-file copy of the
// pattern in test/claude-chat.test.js (its wiggleFetch). A route is a function of the
// page index (how many calls this URL has already answered) returning
// { status?, data, next_cursor }; a thrown route fails that one fetch.
const standIn = (routes) => {
  const calls = [];
  const counts = new Map();
  // the calls ride ON the function (fetch.calls), so a test passes the function itself
  // as the injected fetch and reads the same calls back off it — never a wrapper object
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const route = routes[url];
    if (!route) throw new Error(`no stand-in for ${url}`);
    const n = counts.get(url) || 0;
    counts.set(url, n + 1);
    const out = route(n);
    const status = out.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => out };
  };
  fetch.calls = calls;
  return fetch;
};

// one listed session; extra fields (last_event_at, updated_at) ride along for the
// incremental rules
const sessionsOf = (...items) => new Map(items.map((s) => [s.id, s]));
const listed = (id, title, extra = {}) => ({ id, title, ...extra });

// one event exactly as the events endpoint carries it
const ev = (payload, seq = 1) => ({ payload, event_type: "message", created_at: "2026-01-01T00:00:00Z", sequence_num: seq });

// the driver the tests use: fixed run, collecting callbacks. onFlush/onMarker can be
// overridden per call through opts.
const collect = async (sessions, opts = {}) => {
  const parts = [], markers = [], progress = [];
  const result = await exportSessions(sessions, {
    fetch: opts.fetch,
    known: opts.known || {},
    skip: opts.skip || [],
    partStart: opts.partStart ?? 0,
    run: opts.run || "2026-11-05T1412",
    threshold: opts.threshold,
    timeoutMs: opts.timeoutMs,
    onFlush: opts.onFlush || (async (lines, name) => parts.push({ lines, name })),
    onMarker: opts.onMarker || (async (payload, name) => markers.push({ payload, name })),
    onProgress: (d, t, e, f) => progress.push([d, t, e, f]),
  });
  return { parts, markers, progress, result, calls: opts.fetch ? opts.fetch.calls : [] };
};

// an empty events page: the walk ends at once
const noEvents = { data: [], next_cursor: null };
const ROUTES_NONE = new Proxy({}, { get: () => () => noEvents });

// --- runKey

test("runKey is YYYY-MM-DDTHHMM UTC with the colon stripped", () => {
  assert.equal(runKey(new Date("2026-11-05T14:12:00Z")), "2026-11-05T1412");
  // two runs on one day differ by the minute, never share names
  assert.notEqual(runKey(new Date("2026-11-05T14:12:00Z")), runKey(new Date("2026-11-05T14:13:00Z")));
});

// --- parseKnown

test("parseKnown round-trips the bare JSON object", () => {
  const known = { abc: "2026-01-01T00:00:00Z", def: "2026-02-02T12:30:00Z" };
  assert.deepEqual(parseKnown(JSON.stringify(known)), known);
});

test("parseKnown round-trips the whole window.CLAUDE_EXPORT_KNOWN line", () => {
  const known = { abc: "2026-01-01T00:00:00Z" };
  const line = `window.CLAUDE_EXPORT_KNOWN = ${JSON.stringify(known)};`;
  assert.deepEqual(parseKnown(line), known);
  // the trailing semicolon is optional
  assert.deepEqual(parseKnown(line.slice(0, -1)), known);
});

// the shape claude-sessions-split --incremental-js writes: the known line, then the
// export script verbatim — a script whose own text has `;` line ends, braces and even
// another CLAUDE_EXPORT_KNOWN mention, none of which may leak into the parse
const SCRIPT_TAIL = [
  "(async () => {",
  "  const known = window.CLAUDE_EXPORT_KNOWN || {};",
  '  const skip = new Set(); // {"not": "json"};',
  "  console.log(Object.keys(known).length);",
  "})();",
  "",
].join("\n");

test("parseKnown takes the whole generated file pasted as-is: the line, then the script", () => {
  const known = { abc: "2026-01-01T00:00:00Z", def: "2026-02-02T12:30:00Z" };
  const file = `window.CLAUDE_EXPORT_KNOWN = ${JSON.stringify(known)};\n${SCRIPT_TAIL}`;
  assert.deepEqual(parseKnown(file), known);
  // a Windows clipboard's CRLF, and stray spaces before the line end, cut the same way
  assert.deepEqual(parseKnown(file.replace(/\n/g, "\r\n")), known);
  assert.deepEqual(parseKnown(file.replace(";\n", "; \t\n")), known);
});

test("parseKnown keeps refusing a generated file whose known line is junk", () => {
  assert.throws(() => parseKnown(`window.CLAUDE_EXPORT_KNOWN = [1, 2];\n${SCRIPT_TAIL}`), /CLAUDE_EXPORT_KNOWN/);
  assert.throws(() => parseKnown(`window.CLAUDE_EXPORT_KNOWN = {broken;\n${SCRIPT_TAIL}`), /CLAUDE_EXPORT_KNOWN/);
});

test("parseKnown takes blank as an empty map", () => {
  assert.deepEqual(parseKnown(""), {});
  assert.deepEqual(parseKnown("   \n  "), {});
});

test("parseKnown refuses junk with a message naming the two accepted shapes", () => {
  // a JSON array would "work" over Object.keys but is not the emitted shape; a bare
  // number or string, a null, and another window assignment are junk all the same
  for (const junk of ["[]", "5", '"5"', "null", "window.FOO = 1", "not json"]) {
    assert.throws(() => parseKnown(junk), /CLAUDE_EXPORT_KNOWN/, junk);
  }
});

// --- parseResume

test("parseResume takes the bare skip-id array as skip only", () => {
  assert.deepEqual(parseResume('["a","b"]'), { skip: ["a", "b"], partStart: 0 });
});

test("parseResume takes the full two-statement line in both orders, semicolons optional", () => {
  for (const line of [
    'window.CLAUDE_EXPORT_SKIP = ["a"]; window.CLAUDE_EXPORT_PART_START = 3;',
    'window.CLAUDE_EXPORT_PART_START = 3; window.CLAUDE_EXPORT_SKIP = ["a"];',
    'window.CLAUDE_EXPORT_SKIP = ["a"]; window.CLAUDE_EXPORT_PART_START = 3',
    'window.CLAUDE_EXPORT_SKIP = ["a"]  window.CLAUDE_EXPORT_PART_START = 3;',
  ]) {
    assert.deepEqual(parseResume(line), { skip: ["a"], partStart: 3 }, line);
  }
});

test("parseResume takes either statement alone", () => {
  assert.deepEqual(parseResume('window.CLAUDE_EXPORT_SKIP = ["a"];'), { skip: ["a"], partStart: 0 });
  assert.deepEqual(parseResume('window.CLAUDE_EXPORT_PART_START = 3;'), { skip: [], partStart: 3 });
  assert.deepEqual(parseResume('window.CLAUDE_EXPORT_PART_START = 3'), { skip: [], partStart: 3 });
});

test("parseResume takes blank as nothing to skip and part 0", () => {
  assert.deepEqual(parseResume(""), { skip: [], partStart: 0 });
  assert.deepEqual(parseResume("  \n "), { skip: [], partStart: 0 });
});

test("parseResume refuses junk, and a bare number is junk — PART_START travels in the line form", () => {
  for (const junk of ["not json at all", "5", '"5"', "{}", "window.OTHER = 1;"]) {
    assert.throws(() => parseResume(junk), /CLAUDE_EXPORT_SKIP|bare/, junk);
  }
});

test("parseResume refuses junk inside a matched window.CLAUDE_EXPORT_SKIP = [...]", () => {
  assert.throws(() => parseResume("window.CLAUDE_EXPORT_SKIP = [not json];"), /CLAUDE_EXPORT_SKIP|bare/);
  // non-string ids would never match a session id at skip.has() — junk, not a partial pass
  assert.throws(() => parseResume("window.CLAUDE_EXPORT_SKIP = [1, 2];"), /CLAUDE_EXPORT_SKIP|bare/);
});

// --- the incremental rules (the script's lines 50–59)

test("incremental: activity <= seen skips the session unchanged, and it is not fetched", async () => {
  const fetch = standIn(ROUTES_NONE);
  const { result, calls } = await collect(
    sessionsOf(listed("session_old", "o", { last_event_at: "2025-06-01T00:00:00Z" })),
    { fetch, known: { old: "2026-01-01T00:00:00Z" } },
  );
  assert.equal(result.unchanged, 1);
  assert.equal(calls.length, 0, "a skipped session fetches nothing");
});

test("incremental: an id missing from known is fetched and not counted unchanged", async () => {
  const fetch = standIn(ROUTES_NONE);
  const { result, calls } = await collect(
    sessionsOf(listed("session_new", "n")),
    { fetch, known: { other: "2026-01-01T00:00:00Z" } },
  );
  assert.equal(result.unchanged, 0);
  assert.equal(calls.length, 1, "a session the archive lacks is always fetched");
  assert.match(calls[0].url, /session_new\/events/);
});

test("incremental: seen set but no activity field re-fetches and counts noActivityField", async () => {
  const fetch = standIn(ROUTES_NONE);
  const { result, calls } = await collect(
    sessionsOf(listed("session_nofield", "f")),
    { fetch, known: { nofield: "2026-01-01T00:00:00Z" } },
  );
  assert.equal(result.noActivityField, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(calls.length, 1, "a session with no activity field is re-fetched, not skipped");
});

test("incremental: activity > seen is fetched and not counted unchanged", async () => {
  const fetch = standIn(ROUTES_NONE);
  const { result, calls } = await collect(
    sessionsOf(listed("session_later", "l", { last_event_at: "2026-06-01T00:00:00Z" })),
    { fetch, known: { later: "2026-01-01T00:00:00Z" } },
  );
  assert.equal(result.unchanged, 0);
  assert.equal(calls.length, 1, "newer activity than the archive is fetched");
});

// --- Invariant 1: parts split only at session boundaries, strict > threshold

// a payload padded until the session's single event line is the wanted length — the
// exact bytes the flush check sees, since partBytes counts line.length
const lineOf = (payload, id, title) =>
  JSON.stringify({ ...payload, _session: id, _title: title, _event_type: "message", _created_at: "2026-01-01T00:00:00Z", _seq: 1 }) + "\n";
const payloadOfLength = (want, id, title) => {
  for (let pad = 0; ; pad++) {
    const payload = { p: "x".repeat(pad) };
    if (lineOf(payload, id, title).length === want) return payload;
    if (pad > 500) throw new Error(`no payload makes a ${want}-byte line`);
  }
};
const oneEventSession = (id, title, want) => ({
  id, title,
  _payload: payloadOfLength(want, id, title),
});
const routesOneEvent = (sessions) => Object.fromEntries(sessions.map((s) =>
  [`https://claude.ai/v1/code/sessions/${encodeURIComponent(s.id)}/events?limit=500`,
    () => ({ data: [ev(s._payload)], next_cursor: null })]));

test("Invariant 1: three ~200-unit sessions at threshold 300 make two parts, whole sessions, titles first in part 1", async () => {
  const sessions = sessionsOf(...["A", "B", "C"].map((id) => oneEventSession(id, `t${id}`, 200)));
  const fetch = standIn(routesOneEvent([...sessions.values()]));
  const { parts } = await collect(sessions, { fetch, threshold: 300 });
  assert.equal(parts.length, 2, `parts: ${parts.map((p) => p.name).join(", ")}`);
  assert.equal(parts[0].lines.length, 3, "part 1: titles + A + B");
  assert.deepEqual(JSON.parse(parts[0].lines[0])._titles, { A: "tA", B: "tB", C: "tC" });
  assert.match(parts[0].lines[1], /"_session":"A"/);
  assert.match(parts[0].lines[2], /"_session":"B"/);
  assert.equal(parts[1].lines.length, 1, "part 2: C alone");
  assert.match(parts[1].lines[0], /"_session":"C"/);
  // the titles line rides only in part 1
  assert.equal(parts[1].lines.some((l) => l.includes("_titles")), false);
});

test("Invariant 1: partBytes exactly at threshold is not a flush (strict >)", async () => {
  // S's single event line lands partBytes at exactly 150, and a second session follows:
  // strict > must not flush at S (a >= run would cut S off alone into its own part, then
  // T into a second). T lifts partBytes to 350 > 150, so T's own boundary flush writes
  // the one part, S and T together; the final flush then finds the buffer empty
  const s = oneEventSession("S", "t", 150), t = oneEventSession("T", "u", 200);
  const fetch = standIn(routesOneEvent([s, t]));
  const { parts } = await collect(sessionsOf(s, t), { fetch, threshold: 150 });
  assert.equal(parts.length, 1, "exactly-at-threshold must not flush at S");
  assert.equal(parts[0].lines.length, 3, "titles + both events, together in the one part");
  assert.match(parts[0].lines[2], /"_session":"T"/);
});

test("Invariant 1: a flush never runs mid-session or on a skipped session's iteration", async () => {
  // A alone reaches the threshold (400 > 300) and flushes as its part; B is skipped —
  // its iteration costs no fetch and no flush check; C lands below and rides the final flush
  const a = oneEventSession("A", "tA", 400), c = oneEventSession("C", "tC", 200);
  const sessions = sessionsOf(a, listed("B", "tB"), c);
  const fetch = standIn(routesOneEvent([a, c]));
  const { parts, calls } = await collect(sessions, { fetch, threshold: 300, skip: ["B"] });
  assert.equal(calls.length, 2, "only A and C are fetched");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.lines.length), [2, 1]); // titles+A | C
  assert.match(parts[0].lines[1], /"_session":"A"/);
  assert.match(parts[1].lines[0], /"_session":"C"/);
});

// --- Invariant 2: a failed session contributes zero lines

test("Invariant 2: a session whose events page 2 throws lands in failed with zero lines, and the walk continues", async () => {
  const b = oneEventSession("B", "tB", 200);
  const sessions = sessionsOf(listed("A", "tA"), b);
  const fetch = standIn({
    "https://claude.ai/v1/code/sessions/A/events?limit=500": () =>
      ({ data: [ev({ p: "a1" }), ev({ p: "a2" })], next_cursor: "c1" }),
    "https://claude.ai/v1/code/sessions/A/events?limit=500&cursor=c1": () => { throw new Error("HTTP 503"); },
    ...routesOneEvent([b]),
  });
  const { parts, result } = await collect(sessions, { fetch, threshold: 1000 });
  assert.deepEqual(result.failed, ["A: HTTP 503"]);
  const allLines = parts.flatMap((p) => p.lines);
  assert.equal(allLines.some((l) => l.includes('"_session":"A"')), false, "no line from the failed session");
  assert.equal(allLines.some((l) => /"_session":"B"/.test(l)), true, "the later session's lines are present");
  assert.equal(result.events, 1, "only the completed session's events count");
});

test("a hung events page ends as a timeout: the session fails, the run goes on to the marker", async () => {
  const b = oneEventSession("B", "tB", 200);
  const hung = (u, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
  });
  // page 1 answers, page 2 hangs: the message names the page that hung
  const first = standIn({
    ...routesOneEvent([b]),
    "https://claude.ai/v1/code/sessions/A/events?limit=500": () => ({ data: [ev({ p: 1 })], next_cursor: "c1" }),
  });
  const fetch = (u, opts) => (u.includes("/sessions/A/") && u.includes("cursor=") ? hung(u, opts) : first(u, opts));
  const { parts, markers, result } = await collect(sessionsOf(listed("A", "tA"), b), { fetch, timeoutMs: 1 });
  assert.deepEqual(result.failed, ["A: events page 2 timed out after 0.001 s"]);
  assert.equal(parts.flatMap((p) => p.lines).some((l) => l.includes('"_session":"A"')), false, "page 1's lines are discarded with the session");
  assert.equal(parts.flatMap((p) => p.lines).some((l) => /"_session":"B"/.test(l)), true, "the next session still lands");
  assert.equal(markers.length, 1, "the run reaches its marker");
});

test("every events page carries its own fresh timeout signal", async () => {
  const fetch = standIn({
    "https://claude.ai/v1/code/sessions/A/events?limit=500": () => ({ data: [ev({ p: 1 })], next_cursor: "c1" }),
    "https://claude.ai/v1/code/sessions/A/events?limit=500&cursor=c1": () => ({ data: [ev({ p: 2 })], next_cursor: null }),
  });
  await collect(sessionsOf(listed("A", "tA")), { fetch });
  const signals = fetch.calls.map((c) => c.opts.signal);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s instanceof AbortSignal && !s.aborted));
  assert.notEqual(signals[0], signals[1], "a shared signal would time the whole walk, not each page");
});

// --- Invariant 2b: a repeated cursor throws, failing the session

test("Invariant 2b: a repeated cursor throws — the session fails naming the guard, zero lines", async () => {
  const again = () => ({ data: [ev({ p: "a" })], next_cursor: "same" });
  const fetch = standIn({
    "https://claude.ai/v1/code/sessions/A/events?limit=500": again,
    "https://claude.ai/v1/code/sessions/A/events?limit=500&cursor=same": again,
  });
  const { parts, result } = await collect(sessionsOf(listed("A", "tA")), { fetch });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /^A: .*repeated cursor same/);
  const allLines = parts.flatMap((p) => p.lines);
  assert.equal(allLines.some((l) => l.includes('"_session":"A"')), false, "zero lines from the failed session");
  // the walk stopped at the repeat: two pages fetched, the third never went out
  assert.equal(callsOf(fetch, "A").length, 2);
});

test("Invariant 2b positive control: distinct cursors walk every page exactly once", async () => {
  const page = (n) => ({ data: [ev({ p: `a${n}` })], next_cursor: n < 2 ? `c${n + 1}` : null });
  const fetch = standIn({
    "https://claude.ai/v1/code/sessions/A/events?limit=500": () => page(0),
    "https://claude.ai/v1/code/sessions/A/events?limit=500&cursor=c1": () => page(1),
    "https://claude.ai/v1/code/sessions/A/events?limit=500&cursor=c2": () => page(2),
  });
  const { parts, result } = await collect(sessionsOf(listed("A", "tA")), { fetch });
  assert.deepEqual(result.failed, []);
  assert.equal(callsOf(fetch, "A").length, 3, "one call per page, three pages");
  const lines = parts.flatMap((p) => p.lines).filter((l) => !l.includes("_titles"));
  assert.equal(lines.length, 3, "all pages' events are present");
  assert.match(lines[2], /a2/);
});

const callsOf = (fetch, id) => fetch.calls.filter((c) => c.url.includes(`/sessions/${id}/`));

// --- Invariant 3: the marker is written last, and a refused part stops everything

test("Invariant 3: every onFlush precedes the single onMarker, even when the last session fails", async () => {
  const a = oneEventSession("A", "tA", 200);
  const fetch = standIn({
    ...routesOneEvent([a]),
    "https://claude.ai/v1/code/sessions/Z/events?limit=500": () => { throw new Error("HTTP 500"); },
  });
  const log = [];
  await exportSessions(sessionsOf(a, listed("Z", "tZ")), {
    fetch, threshold: 1000, run: "R",
    onFlush: async (lines, name) => log.push(["flush", name]),
    onMarker: async (payload, name) => log.push(["marker", name]),
  });
  const mi = log.findIndex((e) => e[0] === "marker");
  assert.notEqual(mi, -1, "the marker was written");
  assert.equal(log.length, mi + 1, "the marker is last in the log");
  assert.equal(log.filter((e) => e[0] === "marker").length, 1, "exactly one marker");
  assert.ok(log.slice(0, mi).every((e) => e[0] === "flush") && mi > 0, "every earlier entry is a flush");
});

test("Invariant 3 stop path: a throwing onFlush rejects the run and no marker is written", async () => {
  const a = oneEventSession("A", "tA", 400);
  const fetch = standIn(routesOneEvent([a]));
  let markers = 0;
  await assert.rejects(
    exportSessions(sessionsOf(a, listed("B", "tB")), {
      fetch, threshold: 300, run: "R",
      onFlush: async () => { throw new Error("part save refused"); },
      onMarker: async () => { markers++; },
    }),
    /part save refused/,
  );
  assert.equal(markers, 0, "the marker is never written after a failed part save");
});

// --- the resume state: onFlush's third arg and the return's savedIds (owner-approved:
// the page builds the resume line from what actually saved)

test("onFlush's third arg carries the state as of before this part: part 2 sees part 1's ids, partStart 1", async () => {
  const a = oneEventSession("A", "tA", 400), b = oneEventSession("B", "tB", 200);
  const fetch = standIn(routesOneEvent([a, b]));
  const states = [];
  await assert.rejects(
    exportSessions(sessionsOf(a, b), {
      fetch, threshold: 300, run: "R",
      onFlush: async (lines, name, state) => {
        states.push(state);
        if (states.length === 2) throw new Error("part save refused");
      },
      onMarker: async () => {},
    }),
    /part save refused/,
  );
  assert.equal(states.length, 2);
  assert.deepEqual(states[0], { savedIds: [], partStart: 0 }, "the first part starts from nothing saved");
  assert.deepEqual(states[1], { savedIds: ["A"], partStart: 1 }, "part 2's state names part 1's ids and count");
});

test("the return's savedIds lists the sessions whose parts resolved, in flush order", async () => {
  const a = oneEventSession("A", "tA", 400), b = oneEventSession("B", "tB", 200), c = oneEventSession("C", "tC", 200);
  const fetch = standIn(routesOneEvent([a, b, c]));
  const { result, parts } = await collect(sessionsOf(a, b, c), { fetch, threshold: 300 });
  assert.equal(parts.length, 2);
  assert.deepEqual(result.savedIds, ["A", "B", "C"]);
});

test("a session whose fetch failed is in no part's ids, no later flush state and not the return's savedIds", async () => {
  // A flushes alone (400 > 300); F's events fetch throws (no stand-in route); B and C
  // then make the second part. F was never on disk, so a resume line naming it would
  // skip it for good.
  const a = oneEventSession("A", "tA", 400), b = oneEventSession("B", "tB", 200), c = oneEventSession("C", "tC", 200);
  const f = listed("F", "tF");
  const fetch = standIn(routesOneEvent([a, b, c]));
  const flushes = [];
  const { result } = await collect(sessionsOf(a, f, b, c), {
    fetch, threshold: 300,
    onFlush: async (lines, name, state, ids) => { flushes.push({ state, ids }); },
  });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /^F: /);
  assert.deepEqual(flushes.map((x) => x.ids), [["A"], ["B", "C"]], "onFlush's fourth arg: each part's own session ids, in flush order");
  assert.deepEqual(flushes[1].state, { savedIds: ["A"], partStart: 1 });
  assert.deepEqual(result.savedIds, ["A", "B", "C"]);
});

test("onFlush's ids name a session with no events too: it was fetched whole, like a saved part promotes it", async () => {
  const e = listed("E", "tE");
  const fetch = standIn({ [`https://claude.ai/v1/code/sessions/E/events?limit=500`]: () => noEvents });
  const flushes = [];
  const { result } = await collect(sessionsOf(e), {
    fetch, onFlush: async (lines, name, state, ids) => { flushes.push(ids); },
  });
  assert.deepEqual(flushes, [["E"]]);
  assert.deepEqual(result.savedIds, ["E"], "the same ids the return promotes");
});

test("an all-skipped run returns savedIds [] — the titles-only part saves, promoting no ids", async () => {
  const fetch = standIn({});
  const { result, parts } = await collect(sessionsOf(listed("S", "tS")), { fetch, skip: ["S"] });
  assert.equal(parts.length, 1);
  assert.deepEqual(result.savedIds, []);
});

// the flush state is the CHAIN view (what is on disk across the whole run chain): a run
// that is itself a resume must advise the pasted skip and the pasted part numbering, not
// just this run's own promotions — a seedless state would drop X from the resume line
// (refetched, duplicated) and rewind the part numbers (a rerun could overwrite a landed
// part). The return stays run-scoped: its meaning is what THIS run landed.
test("a resumed run's first flush state is the chain view: the pasted skip seeds savedIds, partStart passes through", async () => {
  const a = oneEventSession("A", "tA", 400);
  const fetch = standIn(routesOneEvent([a]));
  const states = [];
  await assert.rejects(
    exportSessions(sessionsOf(listed("X", "tX"), a), {
      fetch, threshold: 300, run: "R", skip: ["X"], partStart: 3,
      onFlush: async (lines, name, state) => { states.push(state); throw new Error("part save refused"); },
      onMarker: async () => {},
    }),
    /part save refused/,
  );
  assert.equal(states.length, 1);
  assert.deepEqual(states[0], { savedIds: ["X"], partStart: 3 },
    "X is already on disk from the earlier run, and the chain's part numbering continues at 3");
});

test("a resumed run's second flush state seeds the chain view with this run's promotion", async () => {
  const a = oneEventSession("A", "tA", 400), b = oneEventSession("B", "tB", 400);
  const fetch = standIn(routesOneEvent([a, b]));
  const states = [];
  await assert.rejects(
    exportSessions(sessionsOf(listed("X", "tX"), a, b), {
      fetch, threshold: 300, run: "R", skip: ["X"], partStart: 3,
      onFlush: async (lines, name, state) => {
        states.push(state);
        if (states.length === 2) throw new Error("part save refused");
      },
      onMarker: async () => {},
    }),
    /part save refused/,
  );
  assert.equal(states.length, 2);
  assert.deepEqual(states[1], { savedIds: ["X", "A"], partStart: 4 },
    "X seeded, A promoted after part 1 resolved, and the part number continues the chain");
});

test("a resumed run's return stays run-scoped: savedIds never names the seeded skip", async () => {
  const a = oneEventSession("A", "tA", 400);
  const fetch = standIn(routesOneEvent([a]));
  const { result } = await collect(
    sessionsOf(listed("X", "tX"), a),
    { fetch, skip: ["X"], partStart: 3, threshold: 300 },
  );
  assert.deepEqual(result.savedIds, ["A"], "the return's meaning is what THIS run landed; X travels only in the flush state");
});

// --- marker payload and filenames

test("marker payload is exact, skipped sessions included in the count; partStart numbers after N", async () => {
  const a = oneEventSession("A", "tA", 200);
  const fetch = standIn(routesOneEvent([a]));
  const { parts, markers } = await collect(
    sessionsOf(a, listed("S", "tS")),
    { fetch, threshold: 300, skip: ["S"], partStart: 3 },
  );
  // S skipped (no fetch), A fetched: one new part, numbered 04 after partStart 3
  assert.deepEqual(markers[0].payload, { parts: 4, sessions: 2, events: 1, failed: 0 });
  assert.equal(markers[0].name, "claude-sessions-2026-11-05T1412-done.json");
  assert.equal(parts[0].name, "claude-sessions-2026-11-05T1412-part04.jsonl");
});

test("filenames: the first part is part01, zero-padded to two digits", async () => {
  const a = oneEventSession("A", "tA", 400), b = oneEventSession("B", "tB", 200);
  const fetch = standIn(routesOneEvent([a, b]));
  const { parts } = await collect(sessionsOf(a, b), { fetch, threshold: 300 });
  assert.equal(parts[0].name, "claude-sessions-2026-11-05T1412-part01.jsonl");
  assert.equal(parts[1].name, "claude-sessions-2026-11-05T1412-part02.jsonl");
});

test("an all-skipped run still writes its titles-only part and the done marker", async () => {
  const fetch = standIn({});
  const { parts, markers } = await collect(sessionsOf(listed("S", "tS")), { fetch, skip: ["S"] });
  assert.equal(fetch.calls.length, 0);
  assert.equal(parts.length, 1);
  assert.equal(JSON.parse(parts[0].lines[0])._titles.S, "tS");
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0].payload, { parts: 1, sessions: 1, events: 0, failed: 0 });
});

// --- the event line and the wire shapes

test("event lines carry the payload at the top level beside the underscore fields", async () => {
  const payload = { type: "user", text: "hi", uuid: "u-1" };
  const fetch = standIn({
    "https://claude.ai/v1/code/sessions/S1/events?limit=500": () =>
      ({ data: [ev(payload, 7)], next_cursor: null }),
  });
  const { parts } = await collect(sessionsOf(listed("S1", "T1")), { fetch });
  const line = parts.flatMap((p) => p.lines).find((l) => !l.includes("_titles"));
  assert.deepEqual(JSON.parse(line), {
    type: "user", text: "hi", uuid: "u-1",
    _session: "S1", _title: "T1", _event_type: "message",
    _created_at: "2026-01-01T00:00:00Z", _seq: 7,
  });
});

test("events URLs are absolute claude.ai, limit=500, cursor encoded, credentials included", async () => {
  const fetch = standIn({
    "https://claude.ai/v1/code/sessions/S%2Fx/events?limit=500": () => ({ data: [ev({ p: 1 })], next_cursor: "cu/rsor" }),
    "https://claude.ai/v1/code/sessions/S%2Fx/events?limit=500&cursor=cu%2Frsor": () => noEvents,
  });
  const { calls } = await collect(sessionsOf(listed("S/x", "t")), { fetch });
  assert.deepEqual(calls.map((c) => c.url), [
    "https://claude.ai/v1/code/sessions/S%2Fx/events?limit=500",
    "https://claude.ai/v1/code/sessions/S%2Fx/events?limit=500&cursor=cu%2Frsor",
  ]);
  for (const c of calls) {
    assert.equal(c.opts.credentials, "include");
    assert.equal(c.opts.headers["anthropic-version"], "2023-06-01");
  }
});

test("an empty events page ends the walk, whatever cursor came with it", async () => {
  const fetch = standIn({
    "https://claude.ai/v1/code/sessions/A/events?limit=500": () => ({ data: [], next_cursor: "decoy" }),
  });
  const { calls, result } = await collect(sessionsOf(listed("A", "tA")), { fetch });
  assert.equal(calls.length, 1, "the decoy cursor is not followed");
  assert.deepEqual(result.failed, []);
});

// --- skipped sessions count toward done/progress and the titles line

test("a skipped session is never fetched, still counted in progress and _titles", async () => {
  const a = oneEventSession("A", "tA", 200);
  const fetch = standIn(routesOneEvent([a]));
  const { parts, progress, result } = await collect(
    sessionsOf(listed("S", "tS"), a),
    { fetch, skip: ["S"], threshold: 1000 },
  );
  assert.equal(fetch.calls.filter((c) => c.url.includes("/sessions/S/")).length, 0);
  assert.match(parts[0].lines[0], /"S":"tS"/, "_titles includes the skipped session");
  assert.equal(result.parts, 1);
  assert.deepEqual(progress, [[1, 2, 0, 0], [2, 2, 1, 0]], "done counts the skipped session too");
});

test("an events page without a data array fails that session naming the shape, so it is not saved as empty", async () => {
  // a green 0-event session would be promoted into the skip list and never re-fetched
  for (const body of [{}, { data: null }, { error: { type: "x" } }]) {
    const b = oneEventSession("B", "tB", 200);
    const fetch = standIn({
      "https://claude.ai/v1/code/sessions/A/events?limit=500": () => body,
      ...routesOneEvent([b]),
    });
    const { result } = await collect(sessionsOf(listed("A", "tA"), b), { fetch, threshold: 1000 });
    assert.equal(result.failed.length, 1, JSON.stringify(body));
    assert.match(result.failed[0], /^A: .*API shape changed/, JSON.stringify(body));
    assert.deepEqual(result.savedIds, ["B"], "the failed session isn't promoted");
  }
});
