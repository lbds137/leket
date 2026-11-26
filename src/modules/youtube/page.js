// The YouTube page: reads the transcript and the comments — replies included — from
// the YouTube tab the popup matched (driveYouTube runs there, injected through
// chrome.scripting: the loading is scroll-driven, so it must happen where the page
// is) and saves the Markdown with its JSON alongside from here, the same pair the
// leket CLI writes. Unlike the claude-chat page there is no button to press: the run
// starts on its own as soon as the page knows its tab, and #run ("Save again")
// repeats it (and gives the smoke harness a listener to wait for). The YouTube tab
// must stay in front while this runs — Chrome throttles timers in a background tab —
// which is why openYouTubePage opened this page inactive.
import { match } from "../registry.js";
import { driveYouTube } from "./driver.js";
import { buildExtract, renderMarkdown, baseName } from "./extract.js";
import { trackDownload } from "../../lib/download.js";

const line = document.getElementById("status");
const say = (text, cls = "") => { line.textContent = text; line.className = cls; line.hidden = false; };

const NO_TAB = "This page was opened without a YouTube video tab: close it, open a YouTube watch page, click the toolbar button, and start again.";

// the popup matched a www.youtube.com/watch tab and passed its id as a query. Missing
// or garbage: this page has no tab to read, so it must not run — close it and start
// from the popup.
const rawTab = new URLSearchParams(location.search).get("tab");
const tabId = rawTab && /^\d+$/.test(rawTab) ? Number(rawTab) : null;
if (tabId == null) say(NO_TAB, "warn");

// one run at a time: the run that starts on load and a "Save again" click must not
// interleave their downloads
let running = false;
// a late download's word reaches the status line only while its run is the newest
let runSeq = 0;
const run = async () => {
  if (running) return;
  running = true;
  const seq = ++runSeq;
  try {
    if (tabId == null) {
      say(NO_TAB, "warn");
      return;
    }
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      say("The YouTube tab is gone — open the video again, click the toolbar button, and start again.", "warn");
      return;
    }
    // the tab may have navigated since the popup matched it; the driver only makes
    // sense on a www.youtube.com watch page
    const mod = match(tab.url);
    if (!mod || mod.id !== "youtube") {
      say("This tab is no longer on a YouTube watch page — go back to the video, click the toolbar button, and start again.", "warn");
      return;
    }
    // the video tab must be in front while the driver scrolls (Chrome throttles a
    // background tab's timers); pressing "Save again" here just put it behind, so it
    // comes forward first
    say("Reading the transcript and comments from the YouTube tab, which Leket brings to the front… keep both tabs open and the video in front. Its own corner panel says how far along it is.");
    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* the injection below reports a tab that's gone */ }
    // the driver ends on its own within its 15-minute budget; a tab that's frozen or
    // discarded never answers, so the page stops waiting a little after that. A late
    // answer is ignored, and the next run's token stops the old driver
    const GIVE_UP_MS = 17 * 60 * 1000;
    let injection;
    try {
      [injection] = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId }, func: driveYouTube }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), GIVE_UP_MS)),
      ]);
    } catch (err) {
      say((err && err.message) === "timeout"
        ? "The YouTube tab stopped answering — reload it, keep it in front, and press Save again."
        : `Leket couldn't read the YouTube tab (${(err && err.message) || err}) — reload the video, keep it in front, and press Save again.`, "warn");
      return;
    }
    const result = injection && injection.result;
    if (!result || !result.metadata) {
      say("Nothing came back from the YouTube tab — keep the video tab in front, reload it, and press Save again.", "warn");
      return;
    }
    if (result.aborted === "video-changed") {
      say("The YouTube tab moved to another video during the save, so nothing was saved — go back to the video and press Save again.", "warn");
      return;
    }
    if (result.aborted === "superseded") {
      say("A newer save took over the YouTube tab, so this one saved nothing — let that one finish.", "warn");
      return;
    }
    const { metadata, transcript = [], comments = [] } = result;
    const replies = comments.reduce((n, c) => n + (c.replies || []).length, 0);
    const extract = buildExtract({ metadata: { ...metadata, source: "leket-extension" }, transcript, comments });
    const base = baseName(metadata.title, metadata.video_id);
    const parts = [
      [`${base}.json`, new Blob([`${JSON.stringify(extract, null, 2)}\n`], { type: "application/json" })],
      [`${base}.md`, new Blob([renderMarkdown(extract)], { type: "text/markdown" })],
    ];
    let failed = null;
    let noWord = false;
    for (const [name, blob] of parts) {
      say(`Saving ${name}…`);
      const url = URL.createObjectURL(blob);
      let saved;
      try {
        // overwrite: a re-save replaces the file instead of landing beside it as "(1)"
        saved = await trackDownload(chrome.downloads, { url, filename: name, conflictAction: "overwrite" }, {
          // a save with no word in 15 minutes may still be reading the blob URL: free
          // it only once the download truly ends
          // it only once the download truly ends, and say how it ended if no newer run
          // has taken over the status line
          onLate: (ok) => {
            URL.revokeObjectURL(url);
            if (seq !== runSeq) return;
            say(ok ? `${name} finished saving after all.`
              : `${name} didn't finish — see Chrome's downloads, then press Save again.`, ok ? "ok" : "warn");
          },
        });
      } catch (err) {
        // a refused download started nothing and watches nothing: the URL is freed here
        URL.revokeObjectURL(url);
        say(`Chrome refused to save ${name} (${(err && err.message) || err}) — check Chrome's download settings, then press Save again.`, "warn");
        return;
      }
      if (saved !== null) URL.revokeObjectURL(url);
      if (saved === false) failed = failed || name;
      else if (saved === null) noWord = true;
    }
    if (failed) {
      say(`The download didn't finish — Chrome interrupted or refused it, and ${failed} was not saved. See Chrome's downloads, then press Save again.`, "warn");
      return;
    }
    if (noWord) {
      say("No word from Chrome in 15 minutes — the save may still be running; keep this tab open.", "warn");
      return;
    }
    const notes = [metadata.transcript_note, metadata.comments_note].filter(Boolean);
    say(`Saved ${base}.json and ${base}.md: ${comments.length} comments, ${replies} replies, ${transcript.length} transcript lines.`
      + (notes.length ? ` ${notes.join(" ")}` : ""), "ok");
  } catch (err) {
    say(`The save failed: ${(err && err.message) || err} — keep the YouTube tab in front and press Save again.`, "warn");
  } finally {
    running = false;
  }
};

document.getElementById("run").addEventListener("click", (e) => {
  const button = e.target;
  button.disabled = true; // until the run settles, so a double click can't double-download
  run().finally(() => { button.disabled = false; });
});
// the open from the popup is the whole gesture this page needs: it starts on its own
if (tabId != null) run();
