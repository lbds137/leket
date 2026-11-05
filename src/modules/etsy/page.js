// The Etsy conversations page: one section over the module's pure logic. Every rule lives
// in messages.js / registry.js — this file only wires inputs, the button, progress and
// the failure list. The page fetches Etsy itself with the login (credentials: include)
// riding the manifest's etsy.com host permission; the popup passes the matched tab's id
// as a query, so the ids box can prefill from the open /messages/<id> tab.
import { parseIds, collectConversations, serializePayload, outputName } from "./messages.js";
import { makeRedact } from "./redact.js";
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
// empty box, so a gone or tabless open just starts from a blank one.
const prefill = async () => {
  try {
    const raw = new URLSearchParams(location.search).get("tab");
    const tabId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (tabId == null) return;
    const tab = await chrome.tabs.get(tabId);
    const ids = parseIds("", new URL(tab.url).pathname);
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
  // read every input once, before any await
  const ids = parseIds($("ids").value);
  if (!ids.length) {
    say("No conversation ids given.", "warn");
    return;
  }
  try {
    // the redaction config, read once before any fetch: on, or one of the two loud off
    // states — neither off state is silent (an unguarded export must never pass for a
    // guarded one)
    const stored = (await chrome.storage.local.get("etsyRedact")).etsyRedact;
    let redact;
    let redactState;
    if (stored && ["name", "short", "firstSounds"].every((k) => typeof stored[k] === "string" && stored[k])) {
      redact = makeRedact(stored);
      redactState = "on";
      say("Redact: on.");
    } else if (stored) {
      redactState = "off (etsyRedact config incomplete)";
      say("Redact: off — config incomplete (needs name, short, firstSounds); the export is unredacted.", "warn");
    } else {
      redactState = "off (no etsyRedact config)";
      say("Redact: off — no etsyRedact config; the export is unredacted.", "warn");
    }

    progress(0, ids.length);
    const conversations = await collectConversations(ids, {
      onProgress: (i, total, id, seenSize) => {
        progress(i - 1, total);
        say(`Conversation ${i}/${total} (${id}): ${seenSize} messages — keep this tab open.`);
      },
    });
    progress(ids.length, ids.length);
    say("Saving…");
    const json = serializePayload(conversations, { redact, redactState });
    const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const filename = outputName();
    const failed = conversations.filter((c) => c.error);
    const total = conversations.reduce((s, c) => s + c.messages.length, 0);
    // what the run says at the end, from what actually happened: a download Chrome
    // interrupted or refused is not a Done, however green the collection was; the ok
    // class needs no errors AND redact on — an unguarded export never looks clean
    const finish = (saved) => {
      failures(failed.map((c) => `${c.id}: ${c.error}`));
      if (saved === true) {
        say(`Saved ${conversations.length} conversations, ${total} messages`
          + (failed.length ? `, ${failed.length} with errors (listed in the file)` : "")
          + `. Redact: ${redactState}.`,
        failed.length || redactState !== "on" ? "warn" : "ok");
      } else if (saved === false) {
        say(`The download didn't finish — Chrome interrupted or refused it, and ${filename} was not saved. See Chrome's downloads.`, "warn");
      } else {
        say("No word from Chrome in 15 minutes — the save may still be running; keep this tab open and this line will say how it ends.", "warn");
      }
    };
    const saved = await trackDownload(chrome.downloads, { url: blobUrl, filename, saveAs: false, conflictAction: "overwrite" }, {
      // a save with no word in 15 minutes may still be reading the blob URL: free it
      // only once the download truly ends; its end is said only if this run is still
      // the latest — a no-word save outlives its click, and a second run owns the line
      onLate: (ok) => { URL.revokeObjectURL(blobUrl); if (seq === runSeq) finish(ok); },
    });
    if (saved !== null) URL.revokeObjectURL(blobUrl);
    finish(saved);
  } catch (err) {
    say((err && err.message) || String(err), "warn");
  }
}));

prefill();
