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

const $ = (id) => document.getElementById(id);

// on load, a #rename or #delete hash (what the popup's commands open) lands on its own
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

// a button sleeps while its run is in flight, so a double click can't double-delete
const busy = async (button, run) => {
  button.disabled = true;
  try {
    await run();
  } finally {
    button.disabled = false;
  }
};

// runs are one-at-a-time in practice, but a no-word part save outlives its click: a
// second run must not have the first run's late end overwrite its line, so every run
// carries a sequence number (the claude-chat page's pattern)
let runSeq = 0;

$("export-run").addEventListener("click", (e) => busy(e.target, async () => {
  const seq = ++runSeq;
  exportPanel.failures([]);
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
    const mb = (n) => n.toFixed(1);
    // the save seam (save.js): Blob, download and revoke discipline live there; every
    // user-facing string stays here — the factory narrates only the late ends, through
    // this hook, and only while this run still owns the line
    const saves = createSaves({
      downloads: chrome.downloads,
      stillCurrent: () => seq === runSeq,
      note: (ev) => {
        if (ev.marker) {
          exportPanel.say(ev.ok
            ? `The done marker (${ev.name}) landed late.`
            : `The done marker (${ev.name}) landed late but didn't finish — bin/claude-sessions-weekly waits for it; see Chrome's downloads.`, ev.ok ? "" : "warn");
        } else if (ev.ok) {
          savedMB += ev.size / 1048576;
          exportPanel.say(`Saved ${ev.name} (${mb(savedMB)} MB, landed late) — keep this tab open.`);
        } else {
          exportPanel.say(`${ev.name} landed late but didn't finish — see Chrome's downloads. Keep this tab open.`, "warn");
        }
      },
    });
    const result = await exportSessions(sessions, {
      known, skip, partStart, run,
      onFlush: async (lines, name, state) => {
        const { saved, size } = await saves.savePart(lines, name);
        if (saved === true) {
          savedMB += size / 1048576;
          exportPanel.say(`Saved ${name} (${mb(savedMB)} MB) — keep this tab open.`);
          return;
        }
        // a refused or silent part stops the run: exportSessions propagates the throw —
        // later sessions are not fetched and no done marker is written. The resume line
        // is built from the state as of before this part, so it names exactly what is
        // already on disk. (For a silent part the URL stays alive and the factory's
        // onLate still narrates how it ended, late.)
        const resume = `window.CLAUDE_EXPORT_SKIP = ${JSON.stringify(state.savedIds)}; window.CLAUDE_EXPORT_PART_START = ${state.partStart};`;
        partStop({ saved }, {
          refusedMessage: `Part ${name} didn't finish — Chrome interrupted or refused the save. Nothing more is fetched and no done marker is written. To resume, paste this in the resume box: ${resume}`,
          silentMessage: `Part ${name} got no word from Chrome in 15 minutes — the run stopped, so no done marker sits over an unsettled part. If this part lands late, it will say so here. To resume, paste this in the resume box: ${resume}`,
        });
      },
      onMarker: async (payload, name) => {
        const { saved } = await saves.saveMarker(payload, name);
        if (saved === false) markerFailed = true;
        else if (saved === null) markerPending = true;
        // (null: the marker save may still be running — the factory's onLate handles its end)
      },
      onProgress: (d, t, evs, failedCount) => {
        exportPanel.progress(d, t);
        exportPanel.say(`Session ${d} of ${t} — ${evs} events, ${failedCount} failed so far… keep this tab open.`);
      },
    });
    exportPanel.failures(result.failed);
    const done = `Done: ${result.sessions} sessions, ${result.events} events, ${result.parts} part file(s), ${mb(savedMB)} MB.`;
    if (markerFailed) {
      exportPanel.say(`${done} But the done marker (claude-sessions-${run}-done.json) didn't finish saving — bin/claude-sessions-weekly waits for it; see Chrome's downloads. The parts are on disk.`,
        "warn");
    } else if (markerPending) {
      exportPanel.say(`${done} The parts are on disk, but the done marker (claude-sessions-${run}-done.json) is still saving — bin/claude-sessions-weekly waits for it. If it lands late, this line will say so.`,
        "warn");
    } else {
      exportPanel.say(done + (result.failed.length ? ` ${result.failed.length} failed — listed below.` : ""),
        result.failed.length ? "warn" : "ok");
    }
  } catch (err) {
    exportPanel.say((err && err.message) || String(err), "warn");
  }
}));

$("rename-run").addEventListener("click", (e) => busy(e.target, async () => {
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
    renamePanel.say(done.stopped ? done.error : `Done: ${done.ok}/${ordered.length} renamed, every one read back.`,
      done.stopped || done.failed.length ? "warn" : "ok");
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

$("dry-run").addEventListener("click", (e) => busy(e.target, async () => {
  deletePanel.failures([]);
  try {
    storedDryRun = await dryRun();
  } catch (err) {
    deletePanel.say((err && err.message) || String(err), "warn");
  }
}));

$("delete-run").addEventListener("click", (e) => busy(e.target, async () => {
  deletePanel.failures([]);
  try {
    // every input is read once, before any await: the boxes stay editable while a run
    // is in flight, and a mid-run edit must not re-target what this run deletes (an
    // empty prefix matches every session — checkPrefix refuses it here, at capture)
    const prefix = checkPrefix($("prefix").value);
    const typed = $("delete-confirm").value;
    // the listing runs again at delete time, and the result must match the dry run —
    // prefix, exact ids, and the typed count — not the count alone: a session that
    // started matching after the dry run could slip in under an unchanged count
    deletePanel.say("Listing every session again — the confirm must still match the dry run…");
    const hits = findHits(await listSessions(), prefix);
    confirmHits(storedDryRun, prefix, hits, typed);
    deletePanel.progress(0, hits.length);
    deletePanel.say(`Deleting ${hits.length} session(s) — the first is read back before the rest… keep this tab open.`);
    const done = await deleteAll(hits, {
      onProgress: (d, t) => { deletePanel.progress(d, t); deletePanel.say(`Deleted ${d} of ${t}…`); },
    });
    deletePanel.failures(done.failed);
    if (!done.stopped) $("delete-confirm").value = ""; // a completed run resets the confirm
    deletePanel.say(done.stopped ? done.error : `Done: ${done.deleted} deleted, ${done.failed.length} failed.`,
      done.stopped || done.failed.length ? "warn" : "ok");
  } catch (err) {
    deletePanel.say((err && err.message) || String(err), "warn");
  }
}));
