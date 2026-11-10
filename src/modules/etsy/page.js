// The Etsy conversations page: one section over the module's pure logic. Every rule lives
// in messages.js / registry.js — this file only wires inputs, the button, progress and
// the failure list. The page fetches Etsy itself with the login (credentials: include)
// riding the manifest's etsy.com host permission; the popup passes the matched tab's id
// as a query, so the ids box can prefill from the open /messages/<id> tab.
import { parseIds, ignoredTokens, ignoredLine, collectConversations, serializePayload, outputName, finishMessage, failureLines, counted } from "./messages.js";
import { trackDownload } from "../../lib/download.js";

const $ = (id) => document.getElementById(id);

const line = $("etsy-status"), bar = $("etsy-bar"), fails = $("etsy-fails");
const say = (text, cls = "") => { line.textContent = text; line.className = cls; line.hidden = false; };
const progress = (done, total) => { bar.max = total || 1; bar.value = done; bar.hidden = !total; };
const failures = (items) => fails.replaceChildren(...items.map((t) => {
  const li = document.createElement("li");
  li.textContent = t;
  return li;
}));

// the popup matched an etsy.com tab and passed its id as a query. Chrome is touched only
// inside this function, and any failure leaves the box empty — the ids advice covers the
// empty box, so a gone or tabless open just starts from a blank one. The tab's pathname
// is kept for the click flow too: an emptied box falls back to the same conversation.
let tabPathname = "";
const prefill = async () => {
  try {
    const raw = new URLSearchParams(location.search).get("tab");
    const tabId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (tabId == null) return;
    const tab = await chrome.tabs.get(tabId);
    tabPathname = new URL(tab.url).pathname;
    const ids = parseIds("", tabPathname);
    if (ids.length) $("ids").value = ids.join(", ");
  } catch { /* no tab to prefill from: the box stays empty */ }
};

// a button sleeps while its run is in flight, so a double click can't double-download
const busy = async (button, run) => {
  button.disabled = true;
  try {
    await run();
  } finally {
    button.disabled = false;
  }
};

// runs are one-at-a-time in practice, but a no-word save outlives its click: a second
// run must not have the first run's late end overwrite its line, so every run carries
// a sequence number
let runSeq = 0;

$("etsy-run").addEventListener("click", (e) => busy(e.target, async () => {
  const seq = ++runSeq;
  failures([]);
  // read every input once, before any await — an empty box falls back to the conversation
  // the popup was opened on
  const box = $("ids").value;
  const ignored = ignoredTokens(box);
  if (ignored.length) {
    // a typo'd or foreign token stops the run: dropped silently, the rest would save
    // under a green line that never mentions the conversation that was meant
    say(ignoredLine(ignored), "warn");
    return;
  }
  const ids = parseIds(box, tabPathname);
  if (!ids.length) {
    say("No conversation ids given.", "warn");
    return;
  }
  try {
    progress(0, ids.length);
    const conversations = await collectConversations(ids, {
      onProgress: (i, total, id, seenSize) => {
        progress(i - 1, total);
        say(`Conversation ${i}/${total} (${id}): ${counted(seenSize, "message")} — keep this tab open.`);
      },
    });
    progress(ids.length, ids.length);
    say("Saving…");
    const json = serializePayload(conversations);
    const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const filename = outputName();
    const finish = (saved) => {
      const done = finishMessage({ saved, conversations, filename, seq, runSeq });
      if (!done) return;
      failures(failureLines(conversations));
      say(done.text, done.cls);
    };
    let saved;
    try {
      saved = await trackDownload(chrome.downloads, {
        url: blobUrl,
        filename,
        saveAs: false,
        // a same-day save replaces the earlier file of the day
        conflictAction: "overwrite",
      }, {
        // a save with no word in 15 minutes may still be reading the blob URL: free it
        // only once the download truly ends; finishMessage drops a stale run's late end
        // (stale run → null) so a second run keeps the line
        onLate: (ok) => { URL.revokeObjectURL(blobUrl); finish(ok); },
      });
    } catch (err) {
      // a refused download started nothing and watches nothing: the URL is freed here
      URL.revokeObjectURL(blobUrl);
      throw err;
    }
    if (saved !== null) URL.revokeObjectURL(blobUrl);
    finish(saved);
  } catch (err) {
    say((err && err.message) || String(err), "warn");
  }
}));

prefill();
