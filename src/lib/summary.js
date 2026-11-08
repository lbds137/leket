// The export tab's decisions, kept apart from the page so the tests can run them: what a
// click on a part's link does, and the summary drawn from where the save stands.

// a click on a part's link, before Chrome is asked anything. "ignore": saved, or a click
// is already being answered; "starting" / "downloading": a tracked download is under way
// (its id not back yet, or back); "ask": ask Chrome about the last one first; "retry":
// there is none to ask about, so download again
export function clickStep({ busy, saved, inFlight, lastId }) {
  if (busy || saved) return "ignore";
  if (inFlight) return lastId == null ? "starting" : "downloading";
  return lastId == null ? "retry" : "ask";
}

// what Chrome's answer about the last tracked download means for the click: saved, still
// downloading, (interrupted, or erased from Chrome's list) download it again, or
// "unavailable": Chrome couldn't be asked, so nothing is known — the click says so and
// leaves the next click to retry
export function stateStep(state) {
  if (state === "complete") return "saved";
  if (state === "in_progress") return "downloading";
  if (state === "unavailable") return "unavailable";
  return "retry";
}

// how one try's download came out, in time or late: ok is true (finished), false
// (interrupted or refused) or null (no word within the wait). "save": the part is saved,
// whichever try it was; "keep": already saved, its label stands; "didnt-finish" /
// "no-word": the latest try says so, once no newer try is running; "ignore": an older
// try's failure, or one while a newer try runs, says nothing
export function endStep({ ok, saved, latest, inFlight }) {
  if (ok === true) return "save";
  if (saved) return "keep";
  if (!latest || inFlight) return "ignore";
  return ok === false ? "didnt-finish" : "no-word";
}

// The summary, from where things stand now. results: one { index, ok } per part handed to
// a download; failed: the build's records with an error; leftBehind: records a stopped
// streamed save kept out of every part; records: all the build's records, where a small
// save's notes which part each file went into (part). first: the build has just returned
// (later calls follow a click or a late finish that saved a part).
// Returns lost (the records still not saved), release (every part is down and nothing is
// left out, so the Discord tab can let go of the save), close (all done on the first
// draw), detail and status (the page's two lines) and warn (status is a warning).
export function summarize({ results, failed, leftBehind = 0, records = [], messages, attachments, streamed, first }) {
  const badParts = results.filter((r) => !r.ok);
  // a streamed part's files are marked as in it until it downloads: once that part is
  // saved (by a click, or a download that finished late), they are saved after all
  const savedParts = new Set(results.filter((r) => r.ok && r.index).map((r) => r.index));
  const lost = failed.filter((r) => !(r.failedPart && savedParts.has(r.failedPart)));
  // parts saved after the manifest was written: it still lists their files as unsaved
  const staleParts = [...new Set(failed.filter((r) => r.failedPart && savedParts.has(r.failedPart)).map((r) => r.failedPart))];
  const release = !badParts.length && !leftBehind;

  const intro = results.length > 1 ? `The save is in ${results.length} parts: unzip them all into the same folder, then open index.html. `
    : "Unzip it and open index.html to read it. ";
  const detail = intro + (badParts.length ? `${badParts.length} part(s) above didn't finish — click them to try again. ` : "");
  // a small save's parts download after its build, so its files carry no failedPart: a
  // file in a part that isn't saved (yet) isn't saved either
  const waiting = records.filter((r) => r.part && !r.error && !savedParts.has(r.part)).length;
  const attachText = `${attachments - lost.length - waiting} of ${attachments} attachments`;
  // part 1 holds the messages and the readable page, in both kinds of save
  const savedText = savedParts.has(1)
    ? `Saved ${messages} messages${attachments ? ` and ${attachText}` : ""}.`
    : `The ${messages} messages are in ${streamed || results.length > 1 ? "part 1" : "the zip"}, which isn't saved yet${attachments ? `; saved ${attachText}` : ""}.`;
  const staleNote = !staleParts.length ? ""
    : ` discord-attachments.json was written before part ${staleParts.join(", ")} was saved, so it still lists that part's files as not downloaded: they are in the part.`;
  // a streamed save stops at its first failed part; whether anything was left out of
  // every part depends on how far it had got
  const stoppedNote = !streamed ? ""
    : leftBehind ? ` The save stopped there — ${leftBehind} attachment(s) never got into a part (discord-attachments.json lists them as unsaved). If your disk is full, free up space first; then click the part above to try it again, and save again from the Discord tab for the rest.`
    : " If your disk is full, free up space first; then click the part above to try it again.";

  let status, warn = true, close = false;
  if (badParts.length) {
    status = `${savedText} ${badParts.length} part(s) didn't finish — click them above to try again.${stoppedNote}${staleNote}`;
  } else if (!lost.length) {
    // the tab closes on a save that just finished clean; one saved by a click stays,
    // so the click gets an answer (and so does a manifest that no longer tells the truth)
    close = first && !staleNote;
    status = `${savedText} Every part is downloaded.${staleNote}`;
    warn = !!staleNote;
  } else {
    const stopped = leftBehind ? ` The save stopped early, so ${leftBehind} of them never got into a part: save again from the Discord tab for those.` : "";
    status = `${savedText} This tab stays open because ${lost.length} attachment(s) could not be saved.${stopped}${staleNote}`;
  }
  return { lost, release, close, detail, status, warn };
}
