// The sessions page: two sections (Rename, Delete) over the module's pure logic. Every
// guard lives in rename.js / delete.js — this file only wires inputs, buttons, progress
// and the failure lists. The fetches go out from here (the modules default to this
// page's own fetch): absolute https://claude.ai/ URLs with credentials included, which
// the manifest's claude.ai host permission rides along with. This tab owns the run — a
// popup would die on focus loss — so the buttons say to keep it open.
import { listSessions } from "./listing.js";
import { parseRenames, orderRenames, renameAll, currentTitles } from "./rename.js";
import { checkPrefix, findHits, confirmHits, deleteAll } from "./delete.js";

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

// a button sleeps while its run is in flight, so a double click can't double-delete
const busy = async (button, run) => {
  button.disabled = true;
  try {
    await run();
  } finally {
    button.disabled = false;
  }
};

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
