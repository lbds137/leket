// The session listing, ported from the console scripts (claude-sessions-delete.js is the
// spec): every status walked in order, pages of 50 followed by cursor, deduped by id.
// One guard the scripts lack: a server that keeps handing back the same cursor would
// spin a do/while forever, so a repeating cursor stops the walk.
export const API_ORIGIN = "https://claude.ai";
export const STATUSES = ["active", "paused", "archived"];
export const LIST_LIMIT = 50;

export async function listSessions({ fetch: doFetch = fetch, statuses = STATUSES, limit = LIST_LIMIT, timeoutMs = 60_000 } = {}) {
  const headers = { "anthropic-version": "2023-06-01" };
  const sessions = new Map();
  for (const st of statuses) {
    // cursors belong to one status's walk: the same opaque string can mean a different
    // page under the next status, so the repeat check resets per status
    const seenCursors = new Set();
    let cursor = null;
    do {
      // a cursor that already ran must not run again: stop rather than loop forever
      if (cursor != null && seenCursors.has(cursor)) break;
      if (cursor != null) seenCursors.add(cursor);
      const url = `${API_ORIGIN}/v1/code/sessions?statuses=${st}&limit=${limit}`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const r = await doFetch(url, { credentials: "include", headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`Listing ${st} sessions failed: HTTP ${r.status}.`);
      const j = await r.json();
      // no data array (an error body, a renamed field) must not read as "no sessions"
      if (!Array.isArray(j?.data)) throw new Error(`Listing ${st} sessions failed: no data list (the API shape changed).`);
      for (const s of j.data) sessions.set(s.id, s);
      // the script's rule: an empty page ends the walk whatever cursor came with it
      cursor = j.data.length ? j.next_cursor : null;
    } while (cursor);
  }
  return sessions;
}
