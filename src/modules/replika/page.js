// The Replika page: one section over the module's pure logic. Every rule lives in
// api.js / save.js / registry.js — this file only wires inputs, the button, progress
// and the problems list. Like the claude-chat page, it does NOT fetch my.replika.com
// as the matched tab: it injects readReplikaAuth into the tab the popup matched (the
// probe reads that tab's localStorage) and runs every fetch and the WebSocket from
// here, where the manifest's host permissions carry them. Nothing here is ever
// console.log'd: the save's rule is that credentials never reach a console.
import { match } from "../registry.js";
import { readReplikaAuth } from "./api.js";
import { runSave, endLine, problems, downloadOptions } from "./save.js";
import { trackDownload } from "../../lib/download.js";

const $ = (id) => document.getElementById(id);

const line = $("replika-status"), bar = $("replika-bar"), fails = $("replika-problems");
const say = (text, cls = "") => { line.textContent = text; line.className = cls; line.hidden = false; };
const progress = (done, total) => { bar.max = total || 1; bar.value = done; bar.hidden = !total; };
const problemsList = (items) => fails.replaceChildren(...items.map((t) => {
  const li = document.createElement("li");
  li.textContent = t;
  return li;
}));

const NO_TAB = "This page was opened without a my.replika.com tab: close it, open my.replika.com, click the toolbar button, and start again.";
const NOT_SIGNED_IN = "Not signed in on that tab: sign in at my.replika.com, let the chat load, then click Save everything again.";

// the popup matched a my.replika.com tab and passed its id as a query. Missing or
// garbage: this page has no tab to read the login from, so it must not run.
const rawTab = new URLSearchParams(location.search).get("tab");
const tabId = rawTab && /^\d+$/.test(rawTab) ? Number(rawTab) : null;
if (tabId == null) say(NO_TAB, "warn");

// a button sleeps while its run is in flight, so a double click can't double-download
const busy = async (button, run) => {
  button.disabled = true;
  try {
    await run();
  } finally {
    button.disabled = false;
  }
};

// what each step says while it runs; the counts ride the progress callback
const STEP_TEXT = {
  chat: (p) => `Reading the chat history… ${p.count} message(s) so far — keep this tab open.`,
  diary: () => "Reading the diary…",
  memories: () => "Reading the memories…",
  media: (p) => `Fetching pictures and voice clips… ${p.count} of ${p.total}…`,
};

$("replika-run").addEventListener("click", (e) => busy(e.target, async () => {
  if (tabId == null) {
    say(NO_TAB, "warn");
    return;
  }
  try {
    say("Checking the my.replika.com tab…");
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      say("The my.replika.com tab is gone — open it, sign in, click the toolbar button, and start again.", "warn");
      return;
    }
    // the tab may have navigated since the popup matched it; the probe and the fetches
    // only make sense on a signed-in my.replika.com page
    const mod = match(tab.url);
    if (!mod || mod.id !== "replika") {
      say("This tab is no longer on my.replika.com — go back there, sign in, click the toolbar button, and start again.", "warn");
      return;
    }
    say("Reading the sign-in from the my.replika.com tab…");
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readReplikaAuth });
    const probe = injection && injection.result;
    if (!probe || !probe.ok) {
      say(NOT_SIGNED_IN, "warn");
      return;
    }
    progress(0, 1);
    const { data, parts, filename } = await runSave({
      auth: probe.auth,
      leketVersion: chrome.runtime.getManifest().version,
      fetchFn: fetch,
      // the page's own WebSocket, looked up at click time — the smoke swaps this global
      // to script the history socket
      WebSocketCtor: globalThis.WebSocket,
      onStep: (step) => say(STEP_TEXT[step]({ count: 0, total: 1 })),
      onProgress: (p) => {
        if (STEP_TEXT[p.step]) say(STEP_TEXT[p.step](p));
        if (p.total) progress(p.count, p.total);
      },
    });
    say("Saving…");
    progress(0, parts.length);
    let ok = true, noWord = false, landed = 0;
    for (const part of parts) {
      say(`Saving ${part.name}… (${landed + 1} of ${parts.length})`);
      const url = URL.createObjectURL(part.blob);
      let saved;
      try {
        saved = await trackDownload(chrome.downloads, { url, ...downloadOptions(part.name) }, {
          // a save with no word in 15 minutes may still be reading the blob URL: free it
          // only once the download truly ends
          onLate: () => URL.revokeObjectURL(url),
        });
      } catch (err) {
        // a refused download started nothing and watches nothing: the URL is freed here
        URL.revokeObjectURL(url);
        throw err;
      }
      if (saved !== null) URL.revokeObjectURL(url);
      if (saved === false) { ok = false; break; }
      if (saved === null) { noWord = true; break; }
      landed++;
      progress(landed, parts.length);
    }
    if (!ok) {
      say(`The download didn't finish — Chrome interrupted or refused it, and ${filename} was not saved. See Chrome's downloads, then save again.`, "warn");
      return;
    }
    if (noWord) {
      say("No word from Chrome in 15 minutes — the save may still be running; keep this tab open and this line will say how it ends.", "warn");
      return;
    }
    const end = endLine({ filename, data });
    problemsList(problems(data));
    say(end.text, end.warn ? "warn" : "ok");
  } catch (err) {
    say((err && err.message) || String(err), "warn");
  }
}));
