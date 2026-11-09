// The Etsy conversations page: one section over the module's pure logic. Every rule lives
// in messages.js / registry.js — this file only wires inputs, the button, progress and
// the failure list. The page fetches Etsy itself with the login (credentials: include)
// riding the manifest's etsy.com host permission; the popup passes the matched tab's id
// as a query, so the ids box can prefill from the open /messages/<id> tab.
import { parseIds, collectConversations, serializePayload, outputName, redactSetup, parsesAsJson, finishMessage, failureLines, conflictActionFor, counted } from "./messages.js";
import { trackDownload } from "../../lib/download.js";

const $ = (id) => document.getElementById(id);

const line = $("etsy-status"), bar = $("etsy-bar"), fails = $("etsy-fails");
const redactLine = $("etsy-redact");
const say = (text, cls = "") => { line.textContent = text; line.className = cls; line.hidden = false; };
// the redact state's own line: it persists through the progress narration, so the state
// and its collision note stay visible for the whole run no matter what the status line
// is saying at the moment
const sayRedact = (text, cls = "") => { redactLine.textContent = text; redactLine.className = cls; redactLine.hidden = false; };
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
  // a new run starts with no redact line: an earlier run's line never sits beside this
  // run's error
  redactLine.hidden = true;
  // read every input once, before any await — an empty box falls back to the conversation
  // the popup was opened on
  const ids = parseIds($("ids").value, tabPathname);
  if (!ids.length) {
    say("No conversation ids given.", "warn");
    return;
  }
  try {
    // the redaction config, read once before any fetch: the pure decision hands back on,
    // or one of the two loud off states — neither off state is silent (an unguarded
    // export must never pass for a guarded one)
    const stored = (await chrome.storage.local.get("etsyRedact")).etsyRedact;
    const { redactState, redact, line: redactNote } = redactSetup(stored);
    sayRedact(redactNote.text, redactNote.cls);

    progress(0, ids.length);
    const conversations = await collectConversations(ids, {
      onProgress: (i, total, id, seenSize) => {
        progress(i - 1, total);
        say(`Conversation ${i}/${total} (${id}): ${counted(seenSize, "message")} — keep this tab open.`);
      },
    });
    progress(ids.length, ids.length);
    say("Saving…");
    // whole-blob redaction: up to 8 passes on the main thread — a large export sits on "Saving…" a while
    const json = serializePayload(conversations, { redact, redactState });
    // the redacted output is checked before success is claimed: a file that would not
    // parse never rides a green line or overwrites a same-day good export, though the
    // download itself still runs
    const sound = parsesAsJson(json);
    const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const filename = outputName();
    const finish = (saved) => {
      const done = finishMessage({ saved, conversations, filename, redactState, sound, seq, runSeq });
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
        conflictAction: conflictActionFor(sound),
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
    // no export came of this run, so there is nothing for a redact line to describe
    redactLine.hidden = true;
    say((err && err.message) || String(err), "warn");
  }
}));

prefill();
