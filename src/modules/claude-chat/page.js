// The chat-outputs page: one section over the module's pure logic. Every guard lives
// in outputs.js / registry.js — this file only wires inputs, the button, progress and
// the failure list. Unlike the sessions page, this one does NOT fetch claude.ai
// itself as the matched tab: it injects readOrgPath into the claude.ai tab the popup
// matched (the probe reads that tab's resource timeline) and runs the fetches from
// here, where the manifest's claude.ai host permission carries the login.
import { match } from "../registry.js";
import { parseChats, collectChats, readOrgPath, absolutizeOrgPath, outputsName } from "./outputs.js";
import { trackDownload } from "../../lib/download.js";

const $ = (id) => document.getElementById(id);

const line = $("outputs-status"), bar = $("outputs-bar"), fails = $("outputs-failures");
const say = (text, cls = "") => { line.textContent = text; line.className = cls; line.hidden = false; };
const progress = (done, total) => { bar.max = total || 1; bar.value = done; bar.hidden = !total; };
const failures = (items) => fails.replaceChildren(...items.map((t) => {
  const li = document.createElement("li");
  li.textContent = t;
  return li;
}));

// the popup matched a claude.ai tab and passed its id as a query. Missing or garbage:
// this page has no tab to probe, so it must not run — close it and start from the popup.
const rawTab = new URLSearchParams(location.search).get("tab");
const tabId = rawTab && /^\d+$/.test(rawTab) ? Number(rawTab) : null;
if (tabId == null) {
  say("This page was opened without a claude.ai chat tab: close it, open a claude.ai chat, click the toolbar button, and start again.", "warn");
}

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

$("outputs-run").addEventListener("click", (e) => busy(e.target, async () => {
  const seq = ++runSeq;
  failures([]);
  if (tabId == null) {
    say("This page was opened without a claude.ai chat tab: close it, open a claude.ai chat, click the toolbar button, and start again.", "warn");
    return;
  }
  try {
    const chats = parseChats($("chats").value);
    say("Checking the claude.ai tab…");
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      say("The claude.ai tab is gone — open a chat there, click the toolbar button, and start again.", "warn");
      return;
    }
    // the tab may have navigated since the popup matched it; the probe and the
    // fetches only make sense on a claude.ai chat page
    const mod = match(tab.url);
    if (!mod || mod.id !== "claude-chat") {
      say("This tab is no longer on a claude.ai chat — go back to a chat there, click the toolbar button, and start again.", "warn");
      return;
    }
    say("Looking for the organization id on the claude.ai tab…");
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readOrgPath });
    const orgPath = injection && injection.result;
    if (!orgPath) {
      say("No organization id seen on the claude.ai tab yet — open a chat there, let it load, and run again.", "warn");
      return;
    }
    // the probe returns a relative /api/... prefix — correct only on the claude.ai
    // tab, where the script ran; these fetches go out from THIS page
    const org = absolutizeOrgPath(tab.url, orgPath);
    progress(0, chats.length);
    say(`Reading ${chats.length} chat(s)… keep this tab open.`);
    const done = await collectChats(chats, {
      orgPath: org,
      onProgress: (d, t, n) => { progress(d, t); say(`Chat ${d} of ${t} — ${n} files so far… keep this tab open.`); },
    });
    say("Saving…");
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(done.results)], { type: "application/json" }));
    const filename = outputsName();
    const failedChats = done.results.filter((r) => r.error);
    // what the run says at the end, from what actually happened: a download Chrome
    // interrupted or refused is not a Done, however green the collection was, and
    // failed chats are named either way
    const finish = (saved) => {
      failures(failedChats.map((r) => `${r.chat}: ${r.error}`));
      if (saved === true) {
        say(`Done: ${chats.length} chats, ${done.fileCount} files saved to ${filename}.`
          + (failedChats.length ? ` ${failedChats.length} chat(s) failed — their entries carry an "error".` : ""),
          failedChats.length ? "warn" : "ok");
      } else if (saved === false) {
        say(`The download didn't finish — Chrome interrupted or refused it, and ${filename} was not saved. See Chrome's downloads.`, "warn");
      } else {
        say("No word from Chrome in 15 minutes — the save may still be running; keep this tab open and this line will say how it ends.", "warn");
      }
    };
    // a same-day re-save replaces the day's file, like every other module's save: with
    // Chrome's default (uniquify) it would land as "<name> (1).json" beside the stale one
    const saved = await trackDownload(chrome.downloads, { url: blobUrl, filename, conflictAction: "overwrite" }, {
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
