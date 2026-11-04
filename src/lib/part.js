// One part of a save: every try to download it through Chrome's downloads API, the races
// between tries (an older try's id or end arriving late, a click while a try is under way,
// a save that lands while another try still runs), and what a click on the part's link
// does. Kept apart from the export page so the tests can run it under node with a stand-in
// for chrome.downloads: the labels, the list item and the counters stay with the caller,
// behind the hooks. The decisions themselves live in summary.js.
import { downloadState, NO_WORD_MS, trackDownload } from "./download.js";
import { clickStep, endStep, stateStep } from "./summary.js";

// hooks, all called by the factory:
// - label(kind): one of the part link's state texts — "didnt-finish", "no-word",
//   "starting", "downloading", "saving-again", or "unavailable" (Chrome couldn't be asked
//   where the last try stands)
// - saved(): the part is saved, whichever try landed it — count it, turn the link into a
//   plain label, redraw
// - free(): no download of this part reads the blob URL any more — revoke it; may be
//   called more than once (revoking twice is harmless)
export function createPartDownload(downloads, { url, name, index }, hooks, { timeout = NO_WORD_MS } = {}) {
  const result = { name, index, ok: false };
  // the latest try's download id, and that try's number
  let lastId = null, lastTry = 0;
  // downloads of this part not yet over (a try that got no word in time still counts
  // until its late end), and the ids Chrome gave them
  const running = new Set();
  const runningIds = new Map();
  // a try is over: clearing one twice is harmless
  const over = (mine) => { running.delete(mine); runningIds.delete(mine); };
  // the object URL goes once the part is saved and no download is still reading it
  const free = () => { if (result.ok && !running.size) hooks.free(); };
  const markSaved = () => {
    if (result.ok) return;
    result.ok = true;
    // any other try still downloading would only land a second copy: stop it (its
    // end then frees the URL). The page's saved hook goes last, so a throw in its
    // redraw cannot skip the cancels or the revoke — the old code's order too.
    for (const id of runningIds.values()) downloads.cancel(id).catch(() => {});
    free();
    hooks.saved();
  };
  // set while a tracked download is under way, from the call until it settles (the id
  // may not have come back yet): a click then never starts another
  let inFlight = false;
  // each attempt is numbered: an older one whose id or end arrives late (its download()
  // was held up past the wait) must not take lastId or the label from the latest
  let tries = 0;
  // how a try came out, in time or (after the wait) late
  const ended = (mine, ok) => {
    if (ok !== null) over(mine);
    const step = endStep({ ok, saved: result.ok, latest: mine === tries, inFlight });
    if (step === "save") markSaved();
    else if (step === "didnt-finish") hooks.label("didnt-finish");
    // no word within the wait: it may still be downloading, so say that
    else if (step === "no-word") hooks.label("no-word");
    free();
  };
  const attempt = async () => {
    const mine = ++tries;
    // the previous try's id is not this one's: until Chrome gives one, a click says so
    lastId = null;
    inFlight = true;
    running.add(mine);
    let ok;
    try {
      ok = await trackDownload(downloads, { url, filename: name }, {
        timeout,
        onStart: (id) => {
          runningIds.set(mine, id);
          if (mine === tries) { lastId = id; lastTry = mine; }
          // saved by another try before Chrome gave this one its id
          if (result.ok) downloads.cancel(id).catch(() => {});
        },
        onLate: (late) => ended(mine, late),
      });
    } finally {
      inFlight = false;
    }
    ended(mine, ok);
  };
  // set while a click is being answered: the next one waits
  let busy = false;
  const click = async () => {
    const step = clickStep({ busy, saved: result.ok, inFlight, lastId });
    if (step === "ignore") return;
    if (step === "starting") { hooks.label("starting"); return; }
    if (step === "downloading") { hooks.label("downloading"); return; }
    busy = true;
    try {
      const next = step === "retry" ? "retry" : stateStep(await downloadState(downloads, lastId));
      // saved or restarted by another path while Chrome was being asked
      if (result.ok || inFlight) return;
      // Chrome says it completed: that try is over, whether or not its end reached us
      if (next === "saved") { over(lastTry); markSaved(); }
      else if (next === "downloading") hooks.label("downloading");
      else if (next === "unavailable") {
        // Chrome couldn't be asked where the last try stands: say so instead of guessing,
        // and leave the link clickable so a further click can retry
        hooks.label("unavailable");
      } else {
        // Chrome says the last try is interrupted or gone (an erase sends it no end):
        // it reads the URL no longer
        if (step === "ask") over(lastTry);
        hooks.label("saving-again");
        await attempt();
      }
    } finally {
      busy = false;
    }
  };
  return { result, start: attempt, click };
}
