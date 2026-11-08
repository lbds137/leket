// The sessions page: three sections (Export, Rename, Delete) over the module's pure
// logic. Every guard lives in export.js / rename.js / delete.js — this file only wires
// inputs, buttons, progress and the failure lists. The fetches go out from here (the
// modules default to this page's own fetch): absolute https://claude.ai/ URLs with
// credentials included, which the manifest's claude.ai host permission rides along
// with. This tab owns the run — a popup would die on focus loss — so the buttons say
// to keep it open.
import { listSessions } from "./listing.js";
import { parseRenames, orderRenames, renameAll, currentTitles } from "./rename.js";
import { checkPrefix, findHits, confirmHits, deleteAll } from "./delete.js";
import { parseKnown, parseResume, exportSessions, runKey } from "./export.js";
import { createSaves, partStop } from "./save.js";
import { resumeLine, finalLine, lateNote, renameDoneLine, deleteDoneLine } from "./narration.js";

const $ = (id) => document.getElementById(id);

// on load, a #export, #rename or #delete hash (what the popup's commands open) lands on its own
// section: scroll to it and flash it, then drop the flash. A malformed hash decodes to
// nothing — the page just opens at the top.
const section = (() => {
  try {
    return document.getElementById(decodeURIComponent(location.hash.slice(1)));
  } catch {
    return null;
  }
})();
if (section && section.tagName === "SECTION") {
  section.scrollIntoView();
  section.classList.add("flash");
  setTimeout(() => section.classList.remove("flash"), 1000);
}

// what the dry run saw: its prefix and the exact session ids it listed. The delete
// click must match all of it (confirmHits), not just the count — a session that
// started matching after the dry run would otherwise die with the count unchanged.
let storedDryRun = null;

// one status line per section, a progress counter, and the failures as a list
const panel = (statusId, barId, failsId) => {
  const line = $(statusId), bar = $(barId), fails = $(failsId);
  const say = (text, cls = "") => { line.textContent = text; line.className = cls; line.hidden = false; };
  const progress = (done, total) => { bar.max = total || 1; bar.value = done; bar.hidden = !total; };
  const failures = (items) => fails.replaceChildren(...items.map((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    return li;
  }));
  return { say, progress, failures };
};

const renamePanel = panel("rename-status", "rename-bar", "rename-failures");
const deletePanel = panel("delete-status", "delete-bar", "delete-failures");
const exportPanel = panel("export-status", "export-bar", "export-failures");
// the stop's paste-ready resume line, in its own element beside the status line: a
// late note can then update the line without touching the stop message
const resumeEl = $("export-resume");

// a button (or pair of buttons) sleeps while its run is in flight, so a double click
// can't double-delete and a dry run can't race a delete
const busy = async (button, run) => {
  const buttons = Array.isArray(button) ? button : [button];
  for (const b of buttons) b.disabled = true;
  try {
    await run();
  } finally {
    for (const b of buttons) b.disabled = false;
  }
};

// runs are one-at-a-time in practice, but a no-word part save outlives its click: a
// second run must not have the first run's late end overwrite its line, so every run
// carries a sequence number (the claude-chat page's pattern)
let runSeq = 0;

$("export-run").addEventListener("click", () => busy($("export-run"), async () => {
  const seq = ++runSeq;
  exportPanel.failures([]);
  resumeEl.textContent = "";
  resumeEl.hidden = true;
  try {
    // every input is read once, before any await: the boxes stay editable while a run
    // is in flight, and a mid-run edit must not re-target what this run exports. A
    // parser error says what to paste and fetches nothing.
    const known = parseKnown($("known").value);
    const { skip, partStart } = parseResume($("resume").value);
    const run = runKey(); // the run's key, taken at click time: it names every part file
    exportPanel.say("Listing every session (active, paused, archived)…");
    const sessions = await listSessions();
    let savedMB = 0;
    let markerFailed = false;
    let markerPending = false; // the marker's save resolved null — it may still land, late
    let failedCount = 0; // the late marker append's class reads it
    let doneLine = null; // the retained summary line a late marker end appends to
    // the part that stopped the run: its onFlush args plus the stop message and class
    // the status line carries. A late note for it appends to that message and rebuilds
    // the resume line; the stop messages point at the resume element instead of
    // embedding the raw line, so the line can move without touching the message.
    let stopped = null;
    const mb = (n) => n.toFixed(1);
    // the save seam (save.js): Blob, download and revoke discipline live there — the
    // factory narrates only the late ends, through this hook, and only while this run
    // still owns the line; the narration module says what to print, this hook says it
    const saves = createSaves({
      downloads: chrome.downloads,
      stillCurrent: () => seq === runSeq,
      note: (ev) => {
        const said = lateNote({
          marker: ev.marker, ok: ev.ok, name: ev.name, size: ev.size,
          stopped, doneLine, savedMB, run, failedCount,
        });
        if (!ev.marker && !stopped && ev.ok) savedMB += ev.size / 1048576;
        exportPanel.say(said.text, said.cls);
        if (said.resume) {
          resumeEl.textContent = said.resume;
          resumeEl.hidden = false;
        }
      },
    });
    const result = await exportSessions(sessions, {
      known, skip, partStart, run,
      onFlush: async (lines, name, state) => {
        // a refused, silent or failed save stops the run: exportSessions propagates the
        // throw — later sessions are not fetched and no done marker is written. The
        // stop writes the resume line into its own element from the state as of before
        // this part, so it names exactly what is already on disk, and the messages
        // point at the line below instead of embedding it — a late note can update the
        // line without touching the stop message. (For a silent part the URL stays
        // alive and the factory's onLate still narrates how it ended, late.)
        const stopRun = (saved, message) => {
          resumeEl.textContent = resumeLine(state);
          resumeEl.hidden = false;
          stopped = { name, lines, state, message, cls: "warn" };
          partStop({ saved }, { refusedMessage: message, silentMessage: message });
        };
        let out;
        try {
          out = await saves.savePart(lines, name);
        } catch (err) {
          if (err && err.partStop) throw err;
          // a foreign throw (a synchronous download failure among them) converts to the
          // refused path: the run stops, the status line names the underlying error,
          // and the resume element above holds the line — the user keeps it
          stopRun(false, `Part ${name} didn't finish — ${err.message}. Nothing more is fetched and no done marker is written. To resume, paste the resume line below into the resume box.`);
        }
        const { saved, size } = out;
        if (saved !== true) {
          stopRun(saved, saved === false
            ? `Part ${name} didn't finish — Chrome interrupted or refused the save. Nothing more is fetched and no done marker is written. To resume, paste the resume line below into the resume box.`
            : `Part ${name} got no word from Chrome in 15 minutes — the run stopped, so no done marker sits over an unsettled part. If this part lands late, it will say so here. To resume, paste the resume line below into the resume box.`);
        }
        savedMB += size / 1048576;
        exportPanel.say(`Saved ${name} (${mb(savedMB)} MB) — keep this tab open.`);
      },
      onMarker: async (payload, name) => {
        const { saved } = await saves.saveMarker(payload, name);
        if (saved === false) markerFailed = true;
        else if (saved === null) markerPending = true;
        // (null: the marker save may still be running — the factory's onLate handles its end)
      },
      onProgress: (d, t, evs, failed) => {
        failedCount = failed;
        exportPanel.progress(d, t);
        exportPanel.say(`Session ${d} of ${t} — ${evs} events, ${failed} failed so far… keep this tab open.`);
      },
    });
    exportPanel.failures(result.failed);
    const done = finalLine({
      markerFailed, markerPending, failedCount: result.failed.length,
      totals: { sessions: result.sessions, events: result.events, parts: result.parts, mb: mb(savedMB) },
      run,
    });
    exportPanel.say(done.text, done.cls);
    if (markerPending) doneLine = done.text; // a late marker end appends to this line
  } catch (err) {
    exportPanel.say((err && err.message) || String(err), "warn");
  }
}));

$("rename-run").addEventListener("click", () => busy($("rename-run"), async () => {
  renamePanel.failures([]);
  try {
    const list = parseRenames($("renames").value);
    renamePanel.say("Reading the sessions' current titles…");
    const titles = await currentTitles(list);
    const ordered = orderRenames(list, titles);
    if (!ordered) {
      renamePanel.say("Every session is already at its target title: nothing to change (the first rename must be a real change, or the read-back proves nothing).");
      return;
    }
    renamePanel.progress(0, ordered.length);
    renamePanel.say(`Renaming ${ordered.length} session(s)… keep this tab open.`);
    const done = await renameAll(ordered, {
      onProgress: (d, t) => { renamePanel.progress(d, t); renamePanel.say(`Renamed ${d} of ${t}…`); },
    });
    renamePanel.failures(done.failed);
    if (done.stopped) {
      renamePanel.say(done.error, "warn");
    } else {
      const line = renameDoneLine(done, ordered.length);
      renamePanel.say(line.text, line.cls);
    }
  } catch (err) {
    renamePanel.say((err && err.message) || String(err), "warn");
  }
}));

const dryRun = async () => {
  const prefix = checkPrefix($("prefix").value);
  deletePanel.say("Listing every session (active, paused, archived)…");
  const sessions = await listSessions();
  const hits = findHits(sessions, prefix);
  const examples = hits.slice(0, 5).map((s) => s.title);
  deletePanel.say(`${sessions.size} sessions listed; ${hits.length} titled with this prefix.`
    + (examples.length ? ` Examples: ${examples.join(" · ")}` : " (no examples)")
    + (hits.length ? ` To delete, type ${hits.length} in the confirm box, then click Delete.` : " Nothing to delete."));
  return { prefix, ids: hits.map((s) => s.id) };
};

$("dry-run").addEventListener("click", () => busy([$("dry-run"), $("delete-run")], async () => {
  deletePanel.failures([]);
  try {
    storedDryRun = await dryRun();
  } catch (err) {
    deletePanel.say((err && err.message) || String(err), "warn");
  }
}));

$("delete-run").addEventListener("click", () => busy([$("dry-run"), $("delete-run")], async () => {
  deletePanel.failures([]);
  try {
    // every input is read once, before any await: the boxes stay editable while a run
    // is in flight, and a mid-run edit must not re-target what this run deletes (an
    // empty prefix matches every session — checkPrefix refuses it here, at capture);
    // the dry run it is checked against is pinned here too
    const prefix = checkPrefix($("prefix").value);
    const typed = $("delete-confirm").value;
    const dry = storedDryRun;
    // the listing runs again at delete time, and the result must match the dry run —
    // prefix, exact ids, and the typed count — not the count alone: a session that
    // started matching after the dry run could slip in under an unchanged count
    deletePanel.say("Listing every session again — the confirm must still match the dry run…");
    const hits = findHits(await listSessions(), prefix);
    confirmHits(dry, prefix, hits, typed);
    deletePanel.progress(0, hits.length);
    deletePanel.say(`Deleting ${hits.length} session(s) — the first is read back before the rest… keep this tab open.`);
    const done = await deleteAll(hits, {
      onProgress: (d, t) => { deletePanel.progress(d, t); deletePanel.say(`Deleted ${d} of ${t}…`); },
    });
    deletePanel.failures(done.failed);
    if (!done.stopped) $("delete-confirm").value = ""; // a completed run resets the confirm
    if (done.stopped) {
      deletePanel.say(done.error, "warn");
    } else {
      const line = deleteDoneLine(done);
      deletePanel.say(line.text, line.cls);
    }
  } catch (err) {
    deletePanel.say((err && err.message) || String(err), "warn");
  }
}));
