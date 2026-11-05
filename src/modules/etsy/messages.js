// The Etsy module's pure half, ported from the console script in docs/etsy-script-spec.md
// — the script is the spec. No chrome, no document, no Blob: the page (page.js) is the
// seam, everything here runs under node; fetch and sleep are injectable opts.
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
const parseIds = (text, pathname = "") => {
  const ids = (text || "").split(/[\s,]+/).filter((x) => /^\d+$/.test(x));
  if (ids.length) return ids;
  const m = pathname.match(/\/messages\/(\d+)/);
  return m ? [m[1]] : [];
};

const collectConversations = async (ids, {
  fetch = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pauseMs = 400,
  maxPages = 400,
  onProgress,
} = {}) => {
  const conversations = [];
  for (const [i, id] of ids.entries()) {
    const seen = new Map();
    const convo = { id, url: `https://www.etsy.com/messages/${id}`, pages: 0, messages: [] };
    let offset = 0;
    let stale = 0;
    try {
      while (convo.pages < maxPages) {
        if (onProgress) onProgress(i + 1, ids.length, id, seen.size);
        const r = await fetch(
          `https://www.etsy.com/api/v3/ajax/member/conversations/detail/${id}/message-list` +
            `?offset=${offset}&fetch_older=true&load_shop_convos=false`,
          { credentials: "include", headers: { accept: "application/json" } },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status} at offset ${offset}`);
        let data;
        try {
          data = await r.json();
        } catch {
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
      convo.error = String(e.message || e);
    }
    convo.messages = [...seen.values()].sort(
      (a, b) => (a.create_date || 0) - (b.create_date || 0) || (a.message_order || 0) - (b.message_order || 0),
    );
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

// the module's own constants the whole-blob guard can reach; the page warns when a
// configured name also matches one of these — the rewrite itself is by design (the
// guard's owner ruled it stays whole-blob), the warning is what's new here
const PROBES = ["etsy", "www.etsy.com", "https://www.etsy.com/messages/123456"];
const redactionCollisions = (redact) => PROBES.filter((s) => redact(s) !== s);

const serializePayload = (conversations, opts = {}) => {
  const { extractedAt = new Date().toISOString(), redact = (t) => t } = opts;
  // the payload always names its redact state, and the decision is value-based, not
  // key-presence-based: "on" only when a redact fn was actually passed, the reason it
  // is off otherwise (the page passes both options explicitly; the override covers its
  // "config incomplete" state)
  const redactState = opts.redactState ?? (typeof opts.redact === "function" ? "on" : "off (no etsyRedact config)");
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

// the whole-blob guard can corrupt the serialized JSON (a match starting on a JSON
// escape letter leaves a dangling backslash — escalated to the guard's owner). The
// page checks the redacted output before it claims success, and never claims ok when
// the file would not parse.
const parsesAsJson = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const outputName = (date = new Date()) => `etsy-conversations-${date.toISOString().slice(0, 10)}.json`;

export { messagesIn, parseIds, collectConversations, serializePayload, outputName, redactStateFor, redactionCollisions, parsesAsJson };
