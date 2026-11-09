// The Etsy module's pure half, ported from the console script in docs/etsy-script-spec.md
// — the script is the spec. No chrome, no document, no Blob: the page (page.js) is the
// seam, everything here runs under node; fetch and sleep are injectable opts.
import { makeRedact } from "./redact.js";

const messagesIn = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((x) => messagesIn(x, out));
  else if (node && typeof node === "object") {
    if (node.conversation_message_id != null) out.push(node);
    else Object.values(node).forEach((x) => messagesIn(x, out));
  }
  return out;
};

// ids from the box, else the open conversation's address (etsy.com/messages/<id>), else
// nothing — the caller narrates the stop (the console's prompt, then alert)
// A token is a bare id or a conversation link (an etsy.com host, or none, then
// /messages/<id>, any query or fragment); the first of each id is kept, so a repeat is
// not exported twice. Tokens split on whitespace; commas split only a token with no "/",
// so a comma in a link's query can't split off a stray id. A pasted sentence's wrapping
// punctuation — (link). <link> "77"; — is trimmed first.
const unwrap = (t) => t.replace(/^[(<"'[]+/, "").replace(/[.,;:)>"'\]]+$/, "");
const tokensOf = (text) => (text || "").split(/\s+/).map(unwrap)
  .flatMap((t) => t.includes("/") ? [t] : t.split(",").map(unwrap)).filter(Boolean);
const idOf = (token) => /^\d+$/.test(token) ? token
  : (token.match(/^(?:(?:https?:\/\/)?(?:[\w-]+\.)*etsy\.com)?\/messages\/(\d+)(?:[/?#]|$)/i) || [])[1] || null;
const parseIds = (text, pathname = "") => {
  const ids = [...new Set(tokensOf(text).map(idOf).filter(Boolean))];
  if (ids.length) return ids;
  const m = pathname.match(/\/messages\/(\d+)/);
  return m ? [m[1]] : [];
};
// the tokens parseIds drops: the page refuses to run on them rather than export a
// partial set under a green line
const ignoredTokens = (text) => tokensOf(text).filter((t) => !idOf(t));
const ignoredLine = (ignored) => "Not a conversation id or link: "
  + ignored.slice(0, 5).map((t) => `"${t}"`).join(", ") + (ignored.length > 5 ? `, and ${ignored.length - 5} more` : "")
  + ". Give ids (123456789) or etsy.com/messages/<id> links, then save again.";

const collectConversations = async (ids, {
  fetch = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pauseMs = 400,
  maxPages = 400,
  timeoutMs = 60_000,
  onProgress,
} = {}) => {
  // a cap below one page would mark every conversation both empty and truncated
  if (!(Number.isInteger(maxPages) && maxPages >= 1)) throw new RangeError(`maxPages must be a whole number of at least 1, got ${maxPages}`);
  const conversations = [];
  for (const [i, id] of ids.entries()) {
    const seen = new Map();
    const convo = { id, url: `https://www.etsy.com/messages/${id}`, pages: 0, messages: [] };
    let offset = 0;
    let stale = 0;
    let signal;
    try {
      for (;;) {
        // the cap ends the walk without an error, but never silently: the file and the
        // page both say older messages may be missing. A conversation whose last page is
        // exactly the cap's is marked too, on purpose: telling the two apart takes one
        // more fetch, and the wording only says "may be missing"
        if (convo.pages >= maxPages) {
          convo.truncated = true;
          break;
        }
        if (onProgress) onProgress(i + 1, ids.length, id, seen.size);
        signal = AbortSignal.timeout(timeoutMs);
        const r = await fetch(
          `https://www.etsy.com/api/v3/ajax/member/conversations/detail/${id}/message-list` +
            `?offset=${offset}&fetch_older=true&load_shop_convos=false`,
          { credentials: "include", headers: { accept: "application/json" }, signal },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status} at offset ${offset}`);
        let data;
        try {
          data = await r.json();
        } catch (e) {
          // the timeout signal also aborts a stalled body read: that is a timeout, not a sign-out
          if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
          throw new Error(`not JSON (signed out of Etsy?) at offset ${offset}`);
        }
        const page = messagesIn(data);
        convo.pages++;
        if (!page.length) break;
        let added = 0;
        for (const m of page) {
          if (!seen.has(m.conversation_message_id)) {
            seen.set(m.conversation_message_id, m);
            added++;
          }
        }
        // Pages overlap, so stop only after two pages in a row bring nothing new.
        stale = added ? 0 : stale + 1;
        if (stale >= 2) break;
        offset += page.length;
        await sleep(pauseMs);
      }
    } catch (e) {
      // only the page's own timeout reads as timed out: a TimeoutError, or an AbortError
      // from a read the timeout signal ended. Any other abort is a stop, not a slow Etsy
      const timedOut = e && (e.name === "TimeoutError" || (e.name === "AbortError" && signal?.reason?.name === "TimeoutError"));
      if (timedOut) {
        convo.error = `timed out after ${timeoutMs / 1000} s at offset ${offset}`;
      } else if (e && e.name === "AbortError") {
        convo.error = `stopped at offset ${offset}`;
      } else {
        convo.error = String((e && e.message) || e);
      }
    }
    convo.messages = [...seen.values()].sort(
      (a, b) => (a.create_date || 0) - (b.create_date || 0) || (a.message_order || 0) - (b.message_order || 0),
    );
    // an answer with no messages and no error says so in the file too, not only on the
    // page; absent otherwise, so a normal conversation keeps the script's shape
    if (!convo.error && !convo.messages.length) convo.empty = true;
    conversations.push(convo);
    await sleep(pauseMs);
  }
  return conversations;
};

// the loud-state decision, pure so it can be pinned: "on" only when the config
// satisfies the guard's own preconditions (lowercase ASCII fields, the short form and
// the first-sound set starting with the name's first letter)
const redactStateFor = (stored) => {
  if (!stored) return "off (no etsyRedact config)";
  const ok =
    ["name", "short", "firstSounds"].every((k) => typeof stored[k] === "string" && /^[a-z]+$/.test(stored[k])) &&
    stored.short[0] === stored.name[0] &&
    stored.firstSounds[0] === stored.name[0];
  return ok ? "on" : "off (etsyRedact config incomplete)";
};

// the module's own constants and JSON key names the whole-blob guard can reach; the
// page warns when a configured name also matches one of these — the rewrite itself is
// by design (the guard's owner ruled it stays whole-blob), the warning is what's new here
const PROBES = [
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
];
const redactionCollisions = (redact) => PROBES.filter((s) => redact(s) !== s);

// the redact state's own line on the page, pure so its wording is pinned: a collision
// rides the "on" line as a warning (narrated, never a failure of the run), and neither
// off state is silent — an unguarded export must never pass for a guarded one
const redactLineFor = (redactState, hits = []) => {
  if (redactState === "on") {
    return hits.length
      ? {
        text: `Redact: on. This name also matches Etsy's own words or the export's field names (${hits.join(", ")}) — those read [redacted] in the export, and a redacted field name changes the file's shape.`,
        cls: "warn",
      }
      : { text: "Redact: on.", cls: "" };
  }
  if (redactState === "off (etsyRedact config incomplete)") {
    return {
      text: "Redact: off — config invalid (needs lowercase name and short sharing the first letter, and firstSounds starting with it); the export is unredacted.",
      cls: "warn",
    };
  }
  if (redactState === "off (no etsyRedact config)") {
    return { text: "Redact: off — no etsyRedact config; the export is unredacted.", cls: "warn" };
  }
  // a state this helper doesn't know yet names itself and warns, claiming nothing about
  // what the export holds — it might be off, or a partial "on" added later
  return { text: `Redact: ${String(redactState)} — this page has no description for that state; check the export before sharing it.`, cls: "warn" };
};

// the page's whole redact setup in one pure step, so the test runs the page's own chain:
// the state, the guard (only when on) and the line that narrates both
const redactSetup = (stored) => {
  const redactState = redactStateFor(stored);
  const redact = redactState === "on" ? makeRedact(stored) : undefined;
  return { redactState, redact, line: redactLineFor(redactState, redact ? redactionCollisions(redact) : []) };
};

const serializePayload = (conversations, opts = {}) => {
  const { extractedAt = new Date().toISOString(), redact = (t) => t } = opts;
  // the payload always names its redact state, and the decision is value-based, not
  // key-presence-based: "on" only when a redact fn was actually passed, the reason it
  // is off otherwise (the page passes both options explicitly; the override covers its
  // "config incomplete" state)
  const hasRedact = typeof opts.redact === "function";
  const redactState = opts.redactState ?? (hasRedact ? "on" : "off (no etsyRedact config)");
  // an override that contradicts the function is a wiring bug: the file would claim a
  // guard that never ran (or hide one that did), so it fails loudly instead of saving
  if ((redactState === "on") !== hasRedact) {
    throw new Error(`redact state "${redactState}" ${hasRedact ? "with" : "without"} a redact function — not saving a mislabelled export`);
  }
  const json = JSON.stringify(
    {
      source: "etsy",
      extracted_at: extractedAt,
      redact: redactState,
      method:
        "Collected with Leket's Etsy module on etsy.com. " +
        "Each conversation was paged through /api/v3/ajax/member/conversations/detail/<id>/message-list " +
        "(offset, fetch_older=true) and deduped on conversation_message_id; message objects are as Etsy returned them.",
      conversations,
    },
    null,
    1,
  );
  return redact(json);
};

// defence in depth over the whole-blob guard: the page checks the redacted output still
// parses before it claims success, so a guard regression never rides a green line.
const parsesAsJson = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const outputName = (date = new Date()) => `etsy-conversations-${date.toISOString().slice(0, 10)}.json`;

// what the page says when a download settles (in time or late): a download Chrome
// interrupted or refused is not a Saved, however green the collection was; the ok
// class needs no conversation errors, empty answers or capped walks AND redact on AND a parseable file — an
// unguarded export or a corrupt one never looks clean. When seq and runSeq are
// given (the late-finish path), a stale run's end returns null so a later run
// keeps the status line.
const UNSOUND = " The redacted file does NOT parse as JSON — do not share it, and report it.";
// an id that answered with nothing, and no error to say why: almost always a wrong id
const isEmpty = (c) => !c.error && !(c.messages && c.messages.length);

// the page's per-conversation list: every conversation that isn't a clean full walk,
// one line each — an error, an empty answer, or a walk the page cap stopped
const failureLines = (conversations = []) => conversations.flatMap((c) => [
  ...(c.error ? [`${c.id}: ${c.error}`] : []),
  ...(isEmpty(c) ? [`${c.id}: no messages — check the id`] : []),
  ...(c.truncated ? [`${c.id}: stopped at the page cap — older messages may be missing`] : []),
]);
const counted = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const finishMessage = ({ saved, conversations = [], filename, redactState, sound = true, seq, runSeq }) => {
  if (seq !== undefined && runSeq !== undefined && seq !== runSeq) return null;
  const failed = conversations.filter((c) => c.error).length;
  const empty = conversations.filter(isEmpty).length;
  const truncated = conversations.filter((c) => c.truncated).length;
  const total = conversations.reduce((s, c) => s + (c.messages ? c.messages.length : 0), 0);
  if (saved === true) {
    return {
      text: `Saved ${counted(conversations.length, "conversation")}, ${counted(total, "message")}`
        + (failed ? `, ${failed} with errors (listed in the file)` : "")
        + (empty ? `, ${empty} with no messages (wrong id?)` : "")
        + (truncated ? `, ${truncated} stopped at the page cap (older messages may be missing)` : "")
        + `. Redact: ${redactState}.`
        + (sound ? "" : UNSOUND + " It was saved beside any earlier export of the day, not over it."),
      cls: failed || empty || truncated || redactState !== "on" || !sound ? "warn" : "ok",
    };
  }
  if (saved === false) {
    return {
      text: `The download didn't finish — Chrome interrupted or refused it, and ${filename} was not saved. See Chrome's downloads. Redact: ${redactState}.`,
      cls: "warn",
    };
  }
  // a no-word save of an unsound file may still land, and its late end may never be
  // said (a newer run owns the line): the do-not-share warning rides this line too
  return {
    text: `No word from Chrome in 15 minutes — the save may still be running; keep this tab open and this line will say how it ends. Redact: ${redactState}.`
      + (sound ? "" : UNSOUND + " It is being saved beside any earlier export of the day, not over it."),
    cls: "warn",
  };
};

// an unparseable export never replaces a same-day good one: it lands beside it
const conflictActionFor = (sound) => (sound ? "overwrite" : "uniquify");

export { messagesIn, parseIds, ignoredTokens, ignoredLine, collectConversations, serializePayload, outputName, redactStateFor, redactionCollisions, redactLineFor, redactSetup, parsesAsJson, finishMessage, failureLines, conflictActionFor, counted };
