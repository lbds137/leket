// The claude-sessions export page's narration module (src/modules/claude-sessions/
// narration.js): the resume line's template, the rebuild math for a silent part that
// landed late, the run's final line, and what a late end says. Pure strings and data in,
// strings and data out — the page's note hook and final print are thin callers.
import { test } from "node:test";
import assert from "node:assert/strict";

const { resumeLine, resumeSessions, finalLine, lateNote } =
  await import("../src/modules/claude-sessions/narration.js");

// A stopped run's record as page.js keeps it: the name, flush state and session ids of the
// part that stopped the run (never its lines), plus the stop message the run's status
// line carries (late notes append to it)
const stoppedRun = () => ({
  name: "claude-sessions-R-part02.jsonl",
  ids: ["cse_2", "cse_3"],
  state: { savedIds: ["cse_1"], partStart: 2 },
  message: "Part claude-sessions-R-part02.jsonl got no word from Chrome in 15 minutes — the run stopped, so no done marker sits over an unsettled part. If this part lands late, it will say so here. To resume, paste the resume line below into the resume box.",
  cls: "warn",
});

test("resumeLine is the console's paste-ready line", () => {
  assert.equal(
    resumeLine({ savedIds: ["cse_1", "cse_2"], partStart: 3 }),
    'window.CLAUDE_EXPORT_SKIP = ["cse_1","cse_2"]; window.CLAUDE_EXPORT_PART_START = 3;',
  );
});

test("resumeSessions seeds the chain, unions the landed part's sessions, and numbers past it", () => {
  const out = resumeSessions(stoppedRun().state, stoppedRun().ids);
  // the seeded skip ids stay first; the part's own session ids join in flush order
  assert.deepEqual(out.savedIds, ["cse_1", "cse_2", "cse_3"]);
  // the stopped part landed: numbering continues past it
  assert.equal(out.partStart, 3);
});

test("resumeSessions adds each id once: one already in the chain, or repeated, joins no second time", () => {
  const out = resumeSessions({ savedIds: ["cse_2"], partStart: 0 }, ["cse_2", "cse_9", "cse_9"]);
  assert.deepEqual(out.savedIds, ["cse_2", "cse_9"]);
});

test("resumeSessions leaves its inputs untouched", () => {
  const state = { savedIds: ["cse_1"], partStart: 1 };
  resumeSessions(state, ["cse_2"]);
  assert.deepEqual(state, { savedIds: ["cse_1"], partStart: 1 });
});

test("resumeSessions with no ids keeps the seeded chain and still numbers past the part", () => {
  const out = resumeSessions({ savedIds: ["cse_1"], partStart: 5 }, []);
  assert.deepEqual(out.savedIds, ["cse_1"]);
  assert.equal(out.partStart, 6);
});

test("finalLine says the plain done line, ok when nothing failed", () => {
  const out = finalLine({
    markerFailed: false, markerPending: false, failedCount: 0,
    totals: { sessions: 4, events: 90, parts: 2, mb: "12.3" }, run: "R",
  });
  assert.equal(out.text, "Done: 4 sessions, 90 events, 2 part file(s), 12.3 MB.");
  assert.equal(out.cls, "ok");
});

test("finalLine appends the failed count and warns", () => {
  const out = finalLine({
    markerFailed: false, markerPending: false, failedCount: 2,
    totals: { sessions: 4, events: 90, parts: 2, mb: "12.3" }, run: "R",
  });
  assert.equal(out.text, "Done: 4 sessions, 90 events, 2 part file(s), 12.3 MB. 2 failed — listed below.");
  assert.equal(out.cls, "warn");
});

test("finalLine says the marker-failed variant", () => {
  const out = finalLine({
    markerFailed: true, markerPending: false, failedCount: 0,
    totals: { sessions: 4, events: 90, parts: 2, mb: "12.3" }, run: "R",
  });
  assert.equal(out.text, "Done: 4 sessions, 90 events, 2 part file(s), 12.3 MB. But the done marker (claude-sessions-R-done.json) didn't finish saving — bin/claude-sessions-weekly waits for it; see Chrome's downloads. The parts are on disk.");
  assert.equal(out.cls, "warn");
});

test("finalLine says the marker-pending variant, and it warns (a late end must be able to better it)", () => {
  const out = finalLine({
    markerFailed: false, markerPending: true, failedCount: 0,
    totals: { sessions: 4, events: 90, parts: 2, mb: "12.3" }, run: "R",
  });
  assert.equal(out.text, "Done: 4 sessions, 90 events, 2 part file(s), 12.3 MB. The parts are on disk, but the done marker (claude-sessions-R-done.json) is still saving — bin/claude-sessions-weekly waits for it. If it lands late, this line will say so.");
  assert.equal(out.cls, "warn");
});

test("a late note for the stopped part that landed appends to the stop message and rebuilds the resume line", () => {
  const out = lateNote({
    marker: false, ok: true, name: "claude-sessions-R-part02.jsonl", size: 1048576,
    stopped: stoppedRun(), doneLine: null, savedMB: 0, run: "R", failedCount: 0,
  });
  assert.equal(out.text, `${stoppedRun().message} The silent part (claude-sessions-R-part02.jsonl) landed — the resume line below is updated.`);
  assert.equal(out.cls, "warn");
  assert.equal(out.resume, 'window.CLAUDE_EXPORT_SKIP = ["cse_1","cse_2","cse_3"]; window.CLAUDE_EXPORT_PART_START = 3;',
    "the rebuilt line names what is now on disk: seeded ids, the landed part's sessions, numbering past it");
});

test("a late note for the stopped part that didn't finish appends and the resume line stands", () => {
  const out = lateNote({
    marker: false, ok: false, name: "claude-sessions-R-part02.jsonl", size: 1048576,
    stopped: stoppedRun(), doneLine: null, savedMB: 0, run: "R", failedCount: 0,
  });
  assert.equal(out.text, `${stoppedRun().message} The silent part (claude-sessions-R-part02.jsonl) didn't finish — the resume line below stands.`);
  assert.equal(out.cls, "warn");
  assert.equal(out.resume, null);
});

test("a late note for a different part appends only — the resume line is not rebuilt", () => {
  // an earlier silent part's late end after a later stop: its sessions are not among the
  // stopped part's ids, so the chain view must not claim them
  const ok = lateNote({
    marker: false, ok: true, name: "claude-sessions-R-part01.jsonl", size: 1048576,
    stopped: stoppedRun(), doneLine: null, savedMB: 0, run: "R", failedCount: 0,
  });
  assert.equal(ok.text, `${stoppedRun().message} The silent part (claude-sessions-R-part01.jsonl) landed too — the resume line below doesn't include it.`);
  assert.equal(ok.resume, null, "narration only: the resume line stays as written at the stop");
  const bad = lateNote({
    marker: false, ok: false, name: "claude-sessions-R-part01.jsonl", size: 1048576,
    stopped: stoppedRun(), doneLine: null, savedMB: 0, run: "R", failedCount: 0,
  });
  assert.equal(bad.text, `${stoppedRun().message} The silent part (claude-sessions-R-part01.jsonl) didn't finish — the resume line below stands.`);
  assert.equal(bad.resume, null);
});

test("a late marker end appends to the retained done line, ok-class when nothing failed", () => {
  const doneLine = "Done: 4 sessions, 90 events, 2 part file(s), 12.3 MB.";
  const out = lateNote({
    marker: true, ok: true, name: "claude-sessions-R-done.json", size: 40,
    stopped: null, doneLine, savedMB: 12.3, run: "R", failedCount: 0,
  });
  assert.equal(out.text, `${doneLine} The done marker (claude-sessions-R-done.json) landed late.`);
  assert.equal(out.cls, "ok");
});

test("a late marker end appends to the retained done line and warns when sessions failed", () => {
  const doneLine = "Done: 4 sessions, 90 events, 2 part file(s), 12.3 MB. 2 failed — listed below.";
  const out = lateNote({
    marker: true, ok: true, name: "claude-sessions-R-done.json", size: 40,
    stopped: null, doneLine, savedMB: 12.3, run: "R", failedCount: 2,
  });
  assert.equal(out.text, `${doneLine} The done marker (claude-sessions-R-done.json) landed late.`);
  assert.equal(out.cls, "warn");
});

test("a late marker end that didn't finish appends its warning to the retained done line", () => {
  const doneLine = "Done: 4 sessions, 90 events, 2 part file(s), 12.3 MB.";
  const out = lateNote({
    marker: true, ok: false, name: "claude-sessions-R-done.json", size: 40,
    stopped: null, doneLine, savedMB: 12.3, run: "R", failedCount: 0,
  });
  assert.equal(out.text, `${doneLine} The done marker (claude-sessions-R-done.json) landed late but didn't finish — bin/claude-sessions-weekly waits for it; see Chrome's downloads.`);
  assert.equal(out.cls, "warn");
});

test("a late marker end without a retained done line says today's late-marker lines", () => {
  const ok = lateNote({
    marker: true, ok: true, name: "claude-sessions-R-done.json", size: 40,
    stopped: null, doneLine: null, savedMB: 12.3, run: "R", failedCount: 0,
  });
  assert.equal(ok.text, "The done marker (claude-sessions-R-done.json) landed late.");
  assert.equal(ok.cls, "");
  const bad = lateNote({
    marker: true, ok: false, name: "claude-sessions-R-done.json", size: 40,
    stopped: null, doneLine: null, savedMB: 12.3, run: "R", failedCount: 0,
  });
  assert.equal(bad.text, "The done marker (claude-sessions-R-done.json) landed late but didn't finish — bin/claude-sessions-weekly waits for it; see Chrome's downloads.");
  assert.equal(bad.cls, "warn");
  assert.equal(ok.resume, null);
  assert.equal(bad.resume, null);
});

test("a mid-run late part that landed says the Saved line with the running MB total", () => {
  // savedMB is the page's running total in MB already; size is this part's own bytes
  const out = lateNote({
    marker: false, ok: true, name: "claude-sessions-R-part02.jsonl", size: 524288,
    stopped: null, doneLine: null, savedMB: 1, run: "R", failedCount: 0,
  });
  assert.equal(out.text, "Saved claude-sessions-R-part02.jsonl (1.5 MB, landed late) — keep this tab open.");
  assert.equal(out.cls, "");
  assert.equal(out.resume, null);
});

test("a mid-run late part that didn't finish says the warning line", () => {
  const out = lateNote({
    marker: false, ok: false, name: "claude-sessions-R-part02.jsonl", size: 0,
    stopped: null, doneLine: null, savedMB: 1, run: "R", failedCount: 0,
  });
  assert.equal(out.text, "claude-sessions-R-part02.jsonl landed late but didn't finish — see Chrome's downloads. Keep this tab open.");
  assert.equal(out.cls, "warn");
  assert.equal(out.resume, null);
});

// A stale run's late end never reaches this module: save.js's stillCurrent guard drops
// it page-side before note fires, so narration.js takes no sequence number — it cannot
// be asked about a run that lost the line.

// --- the rename and delete Done lines: a may-have-taken result is never "failed"

test("renameDoneLine: all read back is ok; uncertain results are counted apart from failures", async () => {
  const { renameDoneLine } = await import("../src/modules/claude-sessions/narration.js");
  assert.deepEqual(renameDoneLine({ ok: 3, failed: [], uncertain: 0 }, 3),
    { text: "Done: 3/3 renamed, every one read back.", cls: "ok" });
  // both kinds: one parenthetical, and it says the list holds both kinds
  assert.deepEqual(renameDoneLine({ ok: 1, failed: ["x", "y", "z"], uncertain: 2 }, 4), {
    text: "Done: 1/4 renamed and read back; 1 failed, 2 may have taken (no answer, or unverified — check those sessions; both kinds listed below).",
    cls: "warn",
  });
  assert.equal(renameDoneLine({ ok: 2, failed: ["x"], uncertain: 0 }, 3).text,
    "Done: 2/3 renamed and read back; 1 failed (listed below).");
  // every failure uncertain: no "0 failed" clause
  assert.deepEqual(renameDoneLine({ ok: 1, failed: ["x", "y"], uncertain: 2 }, 3), {
    text: "Done: 1/3 renamed and read back; 2 may have taken (no answer, or unverified — check those sessions; listed below).",
    cls: "warn",
  });
});

test("deleteDoneLine: unanswered deletes are counted apart from failures, and a zero count says nothing", async () => {
  const { deleteDoneLine } = await import("../src/modules/claude-sessions/narration.js");
  assert.deepEqual(deleteDoneLine({ deleted: 3, failed: [], unanswered: 0 }),
    { text: "Done: 3 deleted (the first read back as gone; the rest on the server's OK).", cls: "ok" });
  assert.deepEqual(deleteDoneLine({ deleted: 2, failed: ["b", "c"], unanswered: 1 }), {
    text: "Done: 2 deleted (the first read back as gone; the rest on the server's OK), 1 failed, 1 got no answer (may have been deleted — check the session list).",
    cls: "warn",
  });
  // every failure unanswered: no "0 failed" clause
  assert.deepEqual(deleteDoneLine({ deleted: 1, failed: ["b"], unanswered: 1 }), {
    text: "Done: 1 deleted (the first read back as gone; the rest on the server's OK), 1 got no answer (may have been deleted — check the session list).",
    cls: "warn",
  });
});

test("stopMessage names the part and points at the resume line below, for each way a part stops", async () => {
  const { stopMessage } = await import("../src/modules/claude-sessions/narration.js");
  assert.equal(stopMessage("error", "p01.jsonl", new Error("Invalid filename")),
    "Part p01.jsonl didn't finish — Invalid filename. Nothing more is fetched and no done marker is written. To resume, paste the resume line below into the resume box.");
  assert.equal(stopMessage("refused", "p01.jsonl"),
    "Part p01.jsonl didn't finish — Chrome interrupted or refused the save. Nothing more is fetched and no done marker is written. To resume, paste the resume line below into the resume box.");
  assert.equal(stopMessage("silent", "p01.jsonl"),
    "Part p01.jsonl got no word from Chrome in 15 minutes — the run stopped, so no done marker sits over an unsettled part. If this part lands late, it will say so here. To resume, paste the resume line below into the resume box.");
  // a thrown non-Error still names what was thrown
  assert.match(stopMessage("error", "p01.jsonl", "boom"), /didn't finish — boom\./);
});
