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
        const page = messagesIn(await r.json());
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

const serializePayload = (conversations, opts = {}) => {
  const { extractedAt = new Date().toISOString(), redact = (t) => t } = opts;
  // the payload always names its redact state: "on" when a redact fn was passed, the
  // reason it is off otherwise (the page passes both options explicitly; the override
  // covers its "config incomplete" state)
  const redactState = opts.redactState ?? ("redact" in opts ? "on" : "off (no etsyRedact config)");
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

const outputName = (date = new Date()) => `etsy-conversations-${date.toISOString().slice(0, 10)}.json`;

export { messagesIn, parseIds, collectConversations, serializePayload, outputName };
