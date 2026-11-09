// The rename half, ported from dev-docs/browser/claude-sessions-rename.js — the script
// is the spec. The web UI renames with PUT /v1/code/sessions/session_<id>, body {title};
// GET on the same URL wraps the session in `response_shape`. Every rename is read back,
// and the first one must be a real change: a session that already has its target title
// would read back "correctly" even if the PUT did nothing, so the first rename is the
// proof the PUT works. A failure at index 0 stops the whole list — nothing else changed.
import { API_ORIGIN } from "./listing.js";
import { assignedJson } from "../../lib/paste.js";

// ids may start with cse_ or session_ (the same session: the list API says cse_, the
// rename URL session_) — or nothing at all
export const sid = (id) => "session_" + String(id).replace(/^(cse_|session_)/, "");

// The paste payload in any shape Deck's generators give her: the whole generated file
// (the `window.CLAUDE_RENAMES = [...];` line, then the console rename script), just that
// line, or the bare JSON array of [id, title] pairs — assignedJson strips the first two.
// Junk gets an error that says what to paste — the page has no console to decode a raw
// SyntaxError in.
export function parseRenames(text) {
  const t = assignedJson(text, "CLAUDE_RENAMES");
  let list;
  try {
    list = JSON.parse(t);
  } catch {
    throw new Error("Couldn't parse the rename list. Paste the generated file as-is, the whole window.CLAUDE_RENAMES = [...]; line, or the bare JSON array of [id, title] pairs.");
  }
  const ok = Array.isArray(list)
    && list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string");
  if (!ok) throw new Error("The rename list isn't [[id, title], ...] pairs. Paste the generated file as-is, the whole window.CLAUDE_RENAMES = [...]; line, or the bare JSON array.");
  // an id goes straight into the session URL, so anything that isn't a session id — a
  // path traversal, a stray paste, an injection — is refused here, before any fetch
  const bad = list.find((e) => !/^(?:cse_|session_)?[A-Za-z0-9_-]+$/.test(e[0]));
  if (bad) {
    throw new Error(`"${bad[0]}" doesn't look like a session id. Ids are letters, digits, "-" and "_", optionally starting with cse_ or session_ — paste the generated file as-is.`);
  }
  if (!list.length) throw new Error("The rename list is empty — paste the generated file: the bare JSON array of [id, title] pairs.");
  // one session listed twice would be renamed twice, the later title silently winning;
  // cse_X and session_X are the same session
  const seen = new Set();
  for (const [id] of list) {
    if (seen.has(sid(id))) throw new Error(`"${id}" is listed twice (cse_ and session_ forms are the same session). Each session goes in the list once — regenerate it.`);
    seen.add(sid(id));
  }
  return list;
}

// Each entry's current title, read live like the script's first loop does — the keys are
// the ids exactly as the list carries them, which is what orderRenames looks up.
export async function currentTitles(list, { fetch: doFetch = fetch, timeoutMs = 60_000 } = {}) {
  const headers = { "anthropic-version": "2023-06-01" };
  const titles = new Map();
  for (const [id] of list) {
    const r = await doFetch(`${API_ORIGIN}/v1/code/sessions/${encodeURIComponent(sid(id))}`, {
      credentials: "include", headers, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`read ${r.status} (for ${id})`);
    const title = (await r.json()).response_shape?.title;
    // strict, like the script's titleOf: a read this run can't verify stops everything
    // BEFORE any rename goes out — storing null here would promote the entry and PUT
    // it anyway, and then the read-back could never prove the rename took
    if (typeof title !== "string") throw new Error("read: no response_shape.title (the API shape changed)");
    titles.set(id, title);
  }
  return titles;
}

// The script's unshift/splice reorder as a pure function: the first entry whose current
// title differs from its target moves to the front, the rest keep their order. When
// every entry is already at target there is nothing to change — running would "prove"
// nothing, so that is a refusal (null), not a pass. currentTitles is a Map keyed by the
// ids as they appear in the list.
export function orderRenames(list, currentTitles) {
  for (let k = 0; k < list.length; k++) {
    if (currentTitles.get(list[k][0]) !== list[k][1]) {
      return [list[k], ...list.slice(0, k), ...list.slice(k + 1)];
    }
  }
  return null;
}

// The run: PUT {title}, then GET and require response_shape.title === target. A failure
// at index 0 (after orderRenames) stops the whole list — nothing else was changed. A
// later one is recorded and the run goes on; when it may still have taken (no answer, or
// accepted but the read-back failed or differed) its line says so and it counts in
// `uncertain`, apart from the refusals.
export async function renameAll(list, { fetch: doFetch = fetch, timeoutMs = 60_000, onProgress } = {}) {
  const headers = { "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const titleOf = async (id) => {
    const r = await doFetch(`${API_ORIGIN}/v1/code/sessions/${encodeURIComponent(sid(id))}`, {
      credentials: "include", headers, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`read ${r.status}`);
    const title = (await r.json()).response_shape?.title;
    if (typeof title !== "string") throw new Error("read: no response_shape.title (the API shape changed)");
    return title;
  };
  // three outcomes, for the first rename's stop line and every later line: refused (a non-OK answer: it
  // didn't take), unanswered (the PUT threw or timed out: it may have reached the
  // server), and accepted but unverified (2xx, then the read-back failed or differed)
  const rename = async (id, title) => {
    let r;
    try {
      r = await doFetch(`${API_ORIGIN}/v1/code/sessions/${encodeURIComponent(sid(id))}`, {
        method: "PUT", credentials: "include", headers, body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      e.unanswered = true;
      throw e;
    }
    if (!r.ok) throw new Error(`rename ${r.status}: ${(await r.text()).slice(0, 200)}`);
    try {
      const now = await titleOf(id);
      if (now !== title) throw new Error(`read back "${now}"`);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      e.accepted = true;
      throw e;
    }
  };
  const failed = [];
  let ok = 0;
  // later renames that may still have taken (no answer, or accepted but unverified):
  // their lines say so themselves, and the page counts them apart from the refusals
  let uncertain = 0;
  for (const [i, [id, title]] of list.entries()) {
    try {
      await rename(id, title);
      ok++;
    } catch (err) {
      if (i > 0 && (err.accepted || err.unanswered)) {
        uncertain++;
        failed.push(err.accepted
          ? `${id}: accepted, but its check failed (${err.message}) — it may have taken (the server can also normalise a title); check that session`
          : `${id}: no answer (${err.message}) — it may have taken; check that session`);
      } else {
        failed.push(`${id}: ${err.message}`);
      }
      if (i === 0) {
        return { ok, failed, stopped: true,
          error: err.accepted
            ? `Stopped: the first rename was accepted, but its check failed (${err.message}) — it may have taken (the server can also normalise a title); check that session. Nothing else was changed.`
            : err.unanswered
              ? `Stopped: the first rename got no answer (${err.message}) — it may have taken; check that session. Nothing else was changed.`
              : `Stopped: the first rename didn't take (${err.message}). Nothing else was changed.` };
      }
    }
    if (onProgress) onProgress(i + 1, list.length);
  }
  return { ok, failed, uncertain, stopped: false };
}
