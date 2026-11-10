// The Etsy module's pure half, ported from the console script in docs/etsy-script-spec.md
// — the script is the spec. No chrome, no document, no Blob: the page (page.js) is the
// seam, everything here runs under node; fetch and sleep are injectable opts.
// Leket saves the conversations as Etsy returned them: hiding a name is the job of
// whoever reads the file, not of the export.

const messagesIn = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((x) => messagesIn(x, out));
  else if (node && typeof node === "object") {
    if (node.conversation_message_id != null) out.push(node);
    else Object.values(node).forEach((x) => messagesIn(x, out));
  }
  return out;
};

// A token is a bare id or a conversation link (an etsy.com host, or none, then
// /messages/<id>, any query or fragment). Tokens split on whitespace; commas split a
// token unless the whole token is one link, so a comma in a link's query can't split off
// a stray id. A pasted sentence's wrapping punctuation — (link). <link> "77"; and curly
// quotes — is trimmed first, so a box of punctuation alone holds no tokens.
const unwrap = (t) => t.replace(/^[(<"'“‘[]+/, "").replace(/[.,;:)>"'”’\]]+$/, "");
const idOf = (token) => /^\d+$/.test(token) ? token
  : (token.match(/^(?:(?:https?:\/\/)?(?:[\w-]+\.)*etsy\.com)?\/messages\/(\d+)(?:[/?#]|$)/i) || [])[1] || null;
const tokensOf = (text) => (text || "").split(/\s+/).map(unwrap)
  .flatMap((t) => t.includes("/") && idOf(t) ? [t] : t.split(",").map(unwrap)).filter(Boolean);
// ids from the box, else the open conversation's address (etsy.com/messages/<id>), else
// nothing — the caller narrates the stop (the console's prompt, then alert). The first
// of each id is kept, so a repeat is not exported twice. Only a box with no tokens
// (empty, whitespace, bare commas or punctuation) falls back to the tab: a box of junk
// alone never exports the open tab (the page refuses the junk by name before this runs).
const parseIds = (text, pathname = "") => {
  const tokens = tokensOf(text);
  if (tokens.length) return [...new Set(tokens.map(idOf).filter(Boolean))];
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

const serializePayload = (conversations, { extractedAt = new Date().toISOString() } = {}) =>
  JSON.stringify(
    {
      source: "etsy",
      extracted_at: extractedAt,
      method:
        "Collected with Leket's Etsy module on etsy.com. " +
        "Each conversation was paged through /api/v3/ajax/member/conversations/detail/<id>/message-list " +
        "(offset, fetch_older=true) and deduped on conversation_message_id; message objects are as Etsy returned them.",
      conversations,
    },
    null,
    1,
  );

const outputName = (date = new Date()) => `etsy-conversations-${date.toISOString().slice(0, 10)}.json`;

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
// what the page says when a download settles (in time or late): a download Chrome
// interrupted or refused is not a Saved, however green the collection was; the ok
// class needs no conversation errors, empty answers or capped walks. When seq and
// runSeq are given (the late-finish path), a stale run's end returns null so a later
// run keeps the status line.
const finishMessage = ({ saved, conversations = [], filename, seq, runSeq }) => {
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
        + ".",
      cls: failed || empty || truncated ? "warn" : "ok",
    };
  }
  if (saved === false) {
    return {
      text: `The download didn't finish — Chrome interrupted or refused it, and ${filename} was not saved. See Chrome's downloads.`,
      cls: "warn",
    };
  }
  return {
    text: "No word from Chrome in 15 minutes — the save may still be running; keep this tab open and this line will say how it ends.",
    cls: "warn",
  };
};

export { messagesIn, parseIds, ignoredTokens, ignoredLine, collectConversations, serializePayload, outputName, finishMessage, failureLines, counted };
