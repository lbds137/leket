# Etsy script spec

Received from Jackalope 2026-11-04 (jackalope-pyra HEAD bbaaedb,
`scripts/collect/etsy_conversations_console.js`, 213 lines), with its personal-data
lines flagged out. This file is the port spec for `src/modules/etsy/messages.js`;
the scripts are the spec — tuning comes later, on evidence. Any change the Etsy
logic gets here goes back to Jackalope as a diff, same as the Discord collector.

## What Jackalope flagged out, and what this file does about it

- **L9**, a pointer to a practitioner's session notes — a real person's name.
  Dropped; the header now says the notification emails carry the ids.
- **L29-136**, the deadname guard block — not included. Its `NAME`/`SHORT`
  literals and its first-letter mishearing set belong to one person, and this repo
  carries no personal data. Leket ships the guard as the pluggable `redact(text)`
  hook described below; L50-125 of the block (the heard/misheard/split/
  visibleSpans/spans/once machinery) is generic once those are parameters.
- **L194**, the method string, named the other repo and its runner; genericized below.

## The redact(text) hook

Runs over the whole serialized JSON, not per field — which is why it must also
catch `\n` and `\uXXXX` escapes, not just bare text. Config: a name (lowercase),
a short form with its first-letter class, and a mishearing set (first-letter
mishearings, plus a fold of letter variants to i); the three build one regex.
Empty config: `redact` is the identity, nothing is redacted. The literals stay
out of this repo; they are wired per install, outside it.

## The script

L1-28 and L137-213 verbatim, with the two flagged spots marked inline. The guard
block sits where the marker is.

```js
// Etsy conversation collector: paste into Chrome DevTools (F12 > Console) on any etsy.com
// page while logged in. Works for any shop.
//
// For each conversation id it pages through Etsy's own read-only endpoint (the one the
// messages page uses) and keeps every message object as Etsy returns it: both sides, the
// HTML text, create_date, sender_id and images[].image_data.url. It then downloads one
// file, etsy-conversations-<date>.json, with the deadname redacted. Ids come from IDS
// below, else from the open conversation's address (etsy.com/messages/<id>), else a prompt.
// The Etsy notification emails in Gmail carry the ids.
(async () => {
  const IDS = [];
  const PAUSE_MS = 400;

  let ids = IDS.map(String);
  if (!ids.length) {
    const m = location.pathname.match(/\/messages\/(\d+)/);
    const given = prompt("Conversation ids (comma or space separated):", m ? m[1] : "");
    ids = (given || "").split(/[\s,]+/).filter((x) => /^\d+$/.test(x));
  }
  if (!ids.length) return alert("No conversation ids given.");

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;background:#111;color:#eee;" +
    "font:13px sans-serif;padding:8px 10px;border-radius:6px;border:1px solid #555;max-width:360px";
  document.body.appendChild(panel);
  const say = (t) => (panel.textContent = t);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // [L29-136: the deadname guard block, `const redactDeadname = (() => { … })();` —
  //  elided here; in Leket it is the redact(text) hook above]

  // Every object carrying a conversation_message_id, wherever Etsy nests it.
  const messagesIn = (node, out = []) => {
    if (Array.isArray(node)) node.forEach((x) => messagesIn(x, out));
    else if (node && typeof node === "object") {
      if (node.conversation_message_id != null) out.push(node);
      else Object.values(node).forEach((x) => messagesIn(x, out));
    }
    return out;
  };

  const conversations = [];
  for (const [n, id] of ids.entries()) {
    const seen = new Map();
    const convo = { id, url: `https://www.etsy.com/messages/${id}`, pages: 0, messages: [] };
    let offset = 0;
    let stale = 0;
    try {
      while (convo.pages < 400) {
        say(`Conversation ${n + 1}/${ids.length} (${id}): ${seen.size} messages`);
        const r = await fetch(
          `/api/v3/ajax/member/conversations/detail/${id}/message-list` +
            `?offset=${offset}&fetch_older=true&load_shop_convos=false`,
          { credentials: "same-origin", headers: { accept: "application/json" } },
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
        await sleep(PAUSE_MS);
      }
    } catch (e) {
      convo.error = String(e.message || e);
    }
    convo.messages = [...seen.values()].sort(
      (a, b) => (a.create_date || 0) - (b.create_date || 0) || (a.message_order || 0) - (b.message_order || 0),
    );
    conversations.push(convo);
    await sleep(PAUSE_MS);
  }

  let json = JSON.stringify(
    {
      source: "etsy",
      extracted_at: new Date().toISOString(),
      // [L194 genericized: the original named the other repo and its runner]
      method:
        "Collected with Leket's Etsy module on etsy.com. " +
        "Each conversation was paged through /api/v3/ajax/member/conversations/detail/<id>/message-list " +
        "(offset, fetch_older=true) and deduped on conversation_message_id; message objects are as Etsy returned them.",
      conversations,
    },
    null,
    1,
  );
  json = redactDeadname(json); // in Leket: the redact(text) hook, identity when unconfigured
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `etsy-conversations-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  const total = conversations.reduce((s, c) => s + c.messages.length, 0);
  const errors = conversations.filter((c) => c.error).length;
  say(`Saved ${conversations.length} conversations, ${total} messages` +
    (errors ? `, ${errors} with errors (listed in the file)` : "") + ". You can close this panel by reloading.");
})();
```

## Jackalope's notes for the port

1. The redaction runs over the whole serialized JSON, so the hook must handle JSON
   escapes (`\n`, `\uXXXX`), not just bare text.
2. This script calls Etsy's endpoint directly with `fetch`; the Discord collector
   only reads what the page has already loaded. The Etsy module is the one module
   with its own API calls, and its pacing is the script's flat 400 ms pause — older
   than the Discord module's jittered rests, kept as-is.
3. The paste-in scripts are run by hand; an installed extension is the same model
   (the tab's own session, `credentials` included, no copied tokens).

## Where the port departs from the script

The script above stays as received. These are the port's departures; under the
header's rule each one goes to Jackalope as a diff. Entries without a version
predate this list.

- **Per-request timeout** (`AbortSignal.timeout`, 60 s). A stalled request or body
  read ends its conversation as "timed out after N s at offset X", not as a sign-out.
- **The payload names its redact state** (`redact: "on"` or the reason it's off).
  `serializePayload` refuses a state that contradicts the guard it was handed
  (0.3.16).
- **The redacted output must parse** before success is claimed. An unsound file
  lands beside the day's earlier export, not over it.
- **A collision warning** when the configured name also matches Etsy's own words or
  the export's field names.
- **Capped walks are marked** (0.3.16). A conversation the 400-page cap stopped gets
  `truncated: true`; the key is absent otherwise, so an uncapped file keeps the
  script's shape. It warns and is listed.
- **Empty answers warn** (0.3.16). An id that returns no messages and no error says
  "wrong id?" instead of ending green.
