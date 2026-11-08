// The export half, ported from dev-docs/browser/claude-sessions-export.js — the script
// is the spec. Lists nothing itself: it takes the session Map listSessions built, fetches
// each session's events, and hands the run's part files (~150 MB each, flushed only at
// session boundaries) and the done marker to callbacks — the page's saves live there, so
// this module stays pure (no chrome, no DOM, no Blob). The invariants the design doc
// names are structural here: a half-fetched session's lines are discarded (the split
// treats each session's lines as whole, so a truncation would corrupt the archive), and
// the marker call sits after the final flush in this function's own control flow.
import { API_ORIGIN } from "./listing.js";
import { assignedJson } from "../../lib/paste.js";

// the run's key, YYYY-MM-DDTHHMM in UTC: two runs on one day never share file names, so
// bin/claude-sessions-weekly splits each run on its own instead of merging them. A
// resumed run (PART_START) takes a fresh run key on purpose — the first run's parts,
// markerless, wait for weekly's 24 h STALE_HOURS fallback and ingest then (weekly's
// ingest step: "no end marker after 24 h; taking the part file(s) as they are"), so
// nothing is orphaned by the new key.
export const runKey = (date = new Date()) => date.toISOString().slice(0, 16).replace(":", "");

const partName = (run, n) => `claude-sessions-${run}-part${String(n).padStart(2, "0")}.jsonl`;
const markerName = (run) => `claude-sessions-${run}-done.json`;

// The incremental payload in any shape Deck's generator gives her: the whole generated
// file (claude-sessions-split --incremental-js writes the `window.CLAUDE_EXPORT_KNOWN =
// {...};` line, then the console export script), just that line, or the bare
// {archived id: its last event time} object — assignedJson strips the first two. Junk
// gets an error that says what to paste; a JSON array, string, number or null container
// is junk too (the run iterates Object.keys of a map, not an array).
export function parseKnown(text) {
  if (!String(text ?? "").trim()) return {};
  const t = assignedJson(text, "CLAUDE_EXPORT_KNOWN");
  let known;
  try {
    known = JSON.parse(t);
  } catch {
    throw new Error("Couldn't parse the known map. Paste the generated file as-is, the whole window.CLAUDE_EXPORT_KNOWN = {...}; line, or the bare {archived id: its last event time} JSON object.");
  }
  if (!known || typeof known !== "object" || Array.isArray(known)) {
    throw new Error("The known map isn't an object. Paste the generated file as-is, the whole window.CLAUDE_EXPORT_KNOWN = {...}; line, or the bare {archived id: its last event time} JSON object.");
  }
  return known;
}

// The resume payload: the console's post-failure line, either statement, either order,
// each optional (`window.CLAUDE_EXPORT_SKIP = [...ids]; window.CLAUDE_EXPORT_PART_START
// = 3;` — `;` separators optional at the end), or the bare skip-id array. Blank pastes
// nothing: a full export. "5" alone is junk — PART_START travels in the line form.
export function parseResume(text) {
  const t = String(text ?? "").trim();
  if (!t) return { skip: [], partStart: 0 };
  const shapes = " Paste the console's resume line (window.CLAUDE_EXPORT_SKIP = [...]; window.CLAUDE_EXPORT_PART_START = N;) or the bare skip-id JSON array.";
  const out = { skip: [], partStart: 0 };
  let matched = false;
  // `\[[^\]]*\]` stops at the first `]`: a skip array containing one would cut the
  // match short — but real session ids (`[A-Za-z0-9_-]`) never contain one, so the
  // generated line is always safe
  const sm = /window\.CLAUDE_EXPORT_SKIP\s*=\s*(\[[^\]]*\])/.exec(t);
  if (sm) {
    matched = true;
    try {
      out.skip = JSON.parse(sm[1]);
    } catch {
      throw new Error("Couldn't parse the skip ids inside window.CLAUDE_EXPORT_SKIP = [...]." + shapes);
    }
    if (!Array.isArray(out.skip) || !out.skip.every((id) => typeof id === "string")) {
      throw new Error("The skip list isn't an array of session ids." + shapes);
    }
  }
  const pm = /window\.CLAUDE_EXPORT_PART_START\s*=\s*(\d+)/.exec(t);
  if (pm) {
    matched = true;
    out.partStart = Number(pm[1]);
  }
  if (!matched) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr) && arr.every((id) => typeof id === "string")) return { skip: arr, partStart: 0 };
    } catch { /* junk below */ }
    throw new Error("Couldn't parse the resume line." + shapes);
  }
  return out;
}

// The run. opts:
// - fetch: the events go out through it (the page passes its own);
// - known/skip/partStart: the pasted resume + incremental state (parseKnown/parseResume);
// - run: the run key (defaults to runKey() at call time — the page takes it at click);
// - threshold: the flush check's count, strict > (the script's 150 MB, per the design
//   doc's "the scripts are the spec"). The count is UTF-16 code units (the script's
//   `line.length`), not bytes — a non-ASCII part can land slightly above 150 MB on disk;
// - timeoutMs: each events page's own timeout (a fresh AbortSignal per fetch); a page
//   that times out fails its session like any other thrown fetch;
// - onFlush(lines, name, state): a part save — may throw, and the throw STOPS the run: later
//   sessions are not fetched, the final flush and the marker never run (a hole in the
//   part numbering would make weekly split see a hole as a complete run). state is the
//   save record as of before this part — { savedIds, partStart } — so the page can build
//   its resume line from what actually saved; a part counts only once its save resolves;
// - onMarker(payload, name): the done marker — called last, after the final flush,
//   even when every session failed or was skipped;
// - onProgress(done, total, events, failedCount): done counts skipped sessions too.
export async function exportSessions(sessions, opts = {}) {
  const { fetch: doFetch = fetch, known = {}, skip = [], partStart = 0,
    run = runKey(), threshold = 150 * 1048576, timeoutMs = 60_000, onFlush, onMarker, onProgress } = opts;

  // Incremental pre-pass (the script's lines 50–59): a known session is skipped unless
  // the list shows newer activity; one missing from the archive (new, or failed last
  // time — known lacks it) is always fetched. This mutates skip BEFORE the fetch loop.
  const skipSet = new Set(skip);
  const activity = (s) => Date.parse(s.last_event_at || s.updated_at || "") || 0;
  let unchanged = 0, noActivityField = 0;
  for (const s of sessions.values()) {
    const seen = Date.parse(known[s.id.replace(/^session_/, "")] || "") || 0;
    if (!seen) continue;
    if (!activity(s)) noActivityField++;
    else if (activity(s) <= seen) { skipSet.add(s.id); unchanged++; }
  }

  // One record with every listed session's current title, so the archive's index
  // follows renames even for sessions this run skips. It starts the buffer and does
  // NOT count toward partBytes — the script's exact quirk, ported as-is.
  const titlesLine = JSON.stringify({ _titles: Object.fromEntries([...sessions.values()].map((s) => [s.id, s.title])) }) + "\n";
  let buffer = [titlesLine];
  // what this buffer holds, feeding the flush state's chain view (what is on disk
  // across the whole run chain, pasted skip included): a session's id joins it when its
  // lines join the buffer, once per session, and is promoted into savedIds only when
  // that part's save resolves
  let bufferIds = [];
  let partBytes = 0;
  let partNo = partStart;
  const total = sessions.size;
  let done = 0, events = 0;
  const failed = [];
  // promoted only after a part's onFlush RESOLVES — a refused or silent save promotes
  // nothing, so its part number is not counted and its ids are not advised as saved
  let savedIds = [];
  let savedParts = 0;

  const headers = { "anthropic-version": "2023-06-01" };

  const flush = async () => {
    if (!buffer.length) return;
    const lines = buffer;
    const ids = bufferIds;
    // the strings drop before the save settles: the page's Blob is built from `lines` at
    // the top of onFlush, so they become collectable the moment the Blob exists instead
    // of after the download lands
    buffer = [];
    bufferIds = [];
    partBytes = 0;
    // the CHAIN view as of before this part, for the page's resume line if the save
    // stops the run: the pasted skip (already on disk from the earlier run) seeds
    // savedIds, and partStart + savedParts == partNo continues the chain's numbering
    // (every earlier flush resolved before this one is reached — the flushes are
    // sequential). The run's return.savedIds stays run-scoped below: it means what THIS
    // run landed.
    const state = { savedIds: [...skip, ...savedIds], partStart: partStart + savedParts };
    await onFlush(lines, partName(run, ++partNo), state);
    savedIds.push(...ids);
    savedParts++;
  };

  for (const s of sessions.values()) {
    if (skipSet.has(s.id)) {
      done++;
      if (onProgress) onProgress(done, total, events, failed.length);
      // the script's continue also skips the flush check on skipped iterations
      continue;
    }
    // A session's lines join the part only once ALL its pages arrived: a half-fetched
    // session would replace its complete transcript in the archive (the split treats
    // each session's lines as whole). A thrown page fetch or the repeated-cursor guard
    // below leaves the lines discarded and the session failed; the walk continues.
    const lines = [];
    let cursor = null;
    const seenCursors = new Set();
    let page = 0;
    try {
      do {
        // A cursor that already ran must not run again: throw rather than loop forever.
        // listing.js breaks silently instead — a listing truncation is recoverable on
        // rerun, but a silent break here would join PARTIAL lines into a part, a
        // permanent corruption; so this walk fails the session instead.
        if (cursor != null && seenCursors.has(cursor)) throw new Error(`events walk repeated cursor ${cursor}`);
        if (cursor != null) seenCursors.add(cursor);
        const url = `${API_ORIGIN}/v1/code/sessions/${encodeURIComponent(s.id)}/events?limit=500`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        // a fresh signal per page, as in listing/rename/delete: a hung page fails this
        // session (the catch below) instead of holding the run, and its button, forever
        page++;
        let r, j;
        try {
          r = await doFetch(url, { credentials: "include", headers, signal: AbortSignal.timeout(timeoutMs) });
          if (!r.ok) throw new Error(`events HTTP ${r.status}`);
          // the signal covers the body read too, so a stalled body times out the same way
          j = await r.json();
        } catch (err) {
          // name the page and the limit, like etsy's "timed out after N s at offset";
          // the engine's own wording ("aborted due to timeout") says neither
          if (err?.name === "TimeoutError") throw new Error(`events page ${page} timed out after ${timeoutMs / 1000} s`);
          throw err;
        }
        for (const e of j.data || []) {
          lines.push(JSON.stringify({ ...e.payload, _session: s.id, _title: s.title, _event_type: e.event_type, _created_at: e.created_at, _seq: e.sequence_num }) + "\n");
        }
        // the listing's rule: an empty page ends the walk whatever cursor came with it
        cursor = (j.data || []).length ? j.next_cursor : null;
      } while (cursor);
      for (const line of lines) {
        buffer.push(line);
        partBytes += line.length;
      }
      bufferIds.push(s.id);
      events += lines.length;
    } catch (err) {
      failed.push(`${s.id}: ${err.message}`);
    }
    // strict >: a part at exactly the threshold rides the next flush
    if (partBytes > threshold) await flush();
    done++;
    if (onProgress) onProgress(done, total, events, failed.length);
  }

  // Always, even for an all-skipped run: the buffer still holds the titles line, so the
  // run still writes its titles-only part. Only after this may the marker go out.
  await flush();

  // The end marker: bin/claude-sessions-weekly ingests this run's parts only once it
  // exists, so a pause mid-export never splits half a run — and it sits here, after the
  // final flush, in the control flow itself, not in caller discipline.
  await onMarker({ parts: partNo, sessions: sessions.size, events, failed: failed.length }, markerName(run));

  return { parts: partNo, sessions: sessions.size, events, failed, unchanged, noActivityField, savedIds: [...savedIds] };
}
