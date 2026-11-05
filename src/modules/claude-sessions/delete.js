// The delete half, ported from dev-docs/browser/claude-sessions-delete.js — the script
// is the spec. The delete call (DELETE /v1/code/sessions/session_<id>) was never tried
// before that script, so the port keeps its guard: the FIRST match is deleted, read
// back, and unless the read says it's gone (404) nothing else runs. The confirm is
// bound to the dry run — its prefix, its exact session ids, and the count it printed
// must all still match at delete time — so a list that changed in between deletes
// nothing.
import { API_ORIGIN } from "./listing.js";
import { sid } from "./rename.js";

// The prefix is always the user's own typing — the Deck script's default prefix never
// appears here — so an empty or whitespace-only one is refused, not defaulted.
export function checkPrefix(prefix) {
  if (typeof prefix !== "string" || !prefix.trim()) {
    throw new Error("Type the title prefix first: nothing matches an empty one, and the delete runs on whatever matches.");
  }
  return prefix;
}

// sessions (the listing Map) → the ones whose title starts with the prefix
export function findHits(sessions, prefix) {
  return [...sessions.values()].filter((s) => typeof s.title === "string" && s.title.startsWith(prefix));
}

// The typed confirm count must equal the current hit count, exactly, and be plain
// decimal digits (/^\d+$/): Number() would read "0x10" as 16 or "1e2" as 100, and a
// count nobody would type must not pass. A stale count (the list changed since the dry
// run) refuses. The refusal names both numbers.
export function deleteGuard(hits, confirmCount) {
  const typed = String(confirmCount ?? "").trim();
  const n = Number(typed);
  if (!typed || !/^\d+$/.test(typed) || n !== hits.length) {
    throw new Error(`The confirm count reads "${typed || "nothing"}" but ${hits.length} session${hits.length === 1 ? "" : "s"} match now: nothing deleted. Re-run the dry run.`);
  }
}

// The delete is bound to the dry run, not just to the count: stored is what the dry run
// saw ({ prefix, ids } — or null when it never ran), prefix is the box's current text,
// hits the freshly re-listed matches, typed the confirm count. A prefix edited after the
// dry run, or a hit list that changed since it, refuses — a count alone can't, because
// a new matching session can leave the count unchanged while changing what would die.
export function confirmHits(stored, prefix, hits, typed) {
  if (!stored) {
    throw new Error("Run the dry run first — it prints the count to type.");
  }
  if (stored.prefix !== prefix) {
    throw new Error(`The dry run ran on the prefix "${stored.prefix}"; the box now reads "${prefix}" — re-run the dry run.`);
  }
  const then = [...stored.ids].sort();
  const now = hits.map((s) => s.id).sort();
  if (then.length !== now.length || then.some((id, i) => id !== now[i])) {
    throw new Error(`The matching sessions changed since the dry run (${stored.ids.length} then, ${hits.length} now) — re-run the dry run.`);
  }
  deleteGuard(hits, typed);
}

// The run, in the script's order: delete the first hit, GET it back, and stop unless
// the read says 404. Only then the rest, one at a time — a later failure is recorded,
// it doesn't stop the run.
export async function deleteAll(hits, { fetch: doFetch = fetch, onProgress } = {}) {
  const headers = { "anthropic-version": "2023-06-01" };
  const urlOf = (s) => `${API_ORIGIN}/v1/code/sessions/${encodeURIComponent(sid(s.id))}`;
  const del = async (s) => {
    const r = await doFetch(urlOf(s), { method: "DELETE", credentials: "include", headers });
    if (!r.ok) throw new Error(`delete ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
  if (!hits.length) return { deleted: 0, failed: [], stopped: false };
  try {
    await del(hits[0]);
  } catch (e) {
    return { deleted: 0, failed: [], stopped: true,
      error: `First delete failed (${e.message}): stopped, nothing else deleted.` };
  }
  let readBack;
  try {
    readBack = (await doFetch(urlOf(hits[0]), { credentials: "include", headers })).status;
  } catch (e) {
    return { deleted: 0, failed: [], stopped: true,
      error: `First delete succeeded, but the read-back failed (${e.message}): stopped — check the session list before running again.` };
  }
  if (readBack !== 404) {
    return { deleted: 0, failed: [], stopped: true,
      error: `First delete returned OK but the read-back answered ${readBack}, not 404: stopped, nothing else deleted.` };
  }
  const failed = [];
  let deleted = 1;
  if (onProgress) onProgress(1, hits.length); // the verified first delete counts too: the bar never jumps 0 → 2
  for (let i = 1; i < hits.length; i++) {
    try {
      await del(hits[i]);
      deleted++;
    } catch (e) {
      failed.push(`${hits[i].title}: ${e.message}`);
    }
    if (onProgress) onProgress(i + 1, hits.length);
  }
  return { deleted, failed, stopped: false };
}
