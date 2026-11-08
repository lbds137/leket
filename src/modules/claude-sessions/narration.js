// The export page's narration, extracted from page.js so the tests can pin it under
// node (page.js itself touches document and cannot import here). Pure: strings and data
// in, strings and data out — no chrome, no DOM. Every user-facing string lives here
// verbatim; the page's note hook and final print are thin callers that only say what a
// function returned. A stale run's late end never reaches this module — save.js's
// stillCurrent guard drops it page-side before the note hook fires, so nothing here
// takes a sequence number.
//
// `resumeLine(state)` — the console's paste-ready line for the resume box, from a
// `{ savedIds, partStart }` record.
export function resumeLine(state) {
  return `window.CLAUDE_EXPORT_SKIP = ${JSON.stringify(state.savedIds)}; window.CLAUDE_EXPORT_PART_START = ${state.partStart};`;
}

// `resumeSessions(state, ids)` — the rebuild math for a stopped part that landed late:
// the pasted skip and already-saved ids seed the chain, the landed part's own session
// ids (exportSessions' fourth onFlush arg) join in flush order, each once, and the
// numbering continues past the part that landed. Ids, not the part's lines: keeping a
// ~150 MB part alive to regex-scan it would hold the memory and freeze the tab.
export function resumeSessions(state, ids) {
  const savedIds = [...state.savedIds];
  const seen = new Set(savedIds);
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      savedIds.push(id);
    }
  }
  return { savedIds, partStart: state.partStart + 1 };
}

// `stopMessage(kind, name, err)` — the status line of a part save that stopped the run:
// kind "error" (the save threw: err's message is named), "refused" (Chrome interrupted
// or refused it) or "silent" (no word in 15 minutes; it may still land). Each points at
// the resume element below the status line instead of embedding the line, so a late
// note can update the line without touching this message.
export function stopMessage(kind, name, err) {
  if (kind === "error") {
    return `Part ${name} didn't finish — ${(err && err.message) || String(err)}. Nothing more is fetched and no done marker is written. To resume, paste the resume line below into the resume box.`;
  }
  if (kind === "refused") {
    return `Part ${name} didn't finish — Chrome interrupted or refused the save. Nothing more is fetched and no done marker is written. To resume, paste the resume line below into the resume box.`;
  }
  return `Part ${name} got no word from Chrome in 15 minutes — the run stopped, so no done marker sits over an unsettled part. If this part lands late, it will say so here. To resume, paste the resume line below into the resume box.`;
}

// `finalLine(...)` — the run's summary line, all three variants: plain (ok when nothing
// failed, warn with the failed count), the marker that failed to save, and the marker
// still saving (a late end may later better this line — see lateNote).
export function finalLine({ markerFailed, markerPending, failedCount, totals, run }) {
  const done = `Done: ${totals.sessions} sessions, ${totals.events} events, ${totals.parts} part file(s), ${totals.mb} MB.`;
  if (markerFailed) {
    return {
      text: `${done} But the done marker (claude-sessions-${run}-done.json) didn't finish saving — bin/claude-sessions-weekly waits for it; see Chrome's downloads. The parts are on disk.`,
      cls: "warn",
    };
  }
  if (markerPending) {
    return {
      text: `${done} The parts are on disk, but the done marker (claude-sessions-${run}-done.json) is still saving — bin/claude-sessions-weekly waits for it. If it lands late, this line will say so.`,
      cls: "warn",
    };
  }
  return {
    text: done + (failedCount ? ` ${failedCount} failed — listed below.` : ""),
    cls: failedCount ? "warn" : "ok",
  };
}

// `lateNote(...)` — what a late end (the save seam's note hook) says. The page owns the
// MB total and the per-run state (`stopped`: the name, flush state and session ids of the
// part that stopped the run — never its lines — plus the stop message and class its
// status line carries); this function only
// says what to print and, when a stopped part landed, the rebuilt resume line to write
// into the resume element. A late marker end with a retained `doneLine` appends to the
// run's summary rather than replacing it; without one it says the standalone line. A
// late part end for the stopped part itself appends to the stop message and the resume
// line is rebuilt; a different part's late end (an earlier silent part outliving a
// later stop) appends only — its sessions are not among the stopped part's ids, so the
// chain view must not claim them. Mid-run it says today's Saved/warn lines (`savedMB`
// is the total so far, `size` this part's own bytes). `run` rides along for callers'
// context; today's lines name the marker by its late event's own name.
export function lateNote({ marker, ok, name, size, stopped, doneLine, savedMB, run, failedCount }) {
  if (marker) {
    if (doneLine != null) {
      return {
        text: ok
          ? `${doneLine} The done marker (${name}) landed late.`
          : `${doneLine} The done marker (${name}) landed late but didn't finish — bin/claude-sessions-weekly waits for it; see Chrome's downloads.`,
        cls: ok ? (failedCount ? "warn" : "ok") : "warn",
        resume: null,
      };
    }
    return {
      text: ok
        ? `The done marker (${name}) landed late.`
        : `The done marker (${name}) landed late but didn't finish — bin/claude-sessions-weekly waits for it; see Chrome's downloads.`,
      cls: ok ? "" : "warn",
      resume: null,
    };
  }
  if (stopped) {
    if (name !== stopped.name) {
      return {
        text: ok
          ? `${stopped.message} The silent part (${name}) landed too — the resume line below doesn't include it.`
          : `${stopped.message} The silent part (${name}) didn't finish — the resume line below stands.`,
        cls: stopped.cls,
        resume: null,
      };
    }
    if (ok) {
      return {
        text: `${stopped.message} The silent part (${name}) landed — the resume line below is updated.`,
        cls: stopped.cls,
        resume: resumeLine(resumeSessions(stopped.state, stopped.ids)),
      };
    }
    return {
      text: `${stopped.message} The silent part (${name}) didn't finish — the resume line below stands.`,
      cls: stopped.cls,
      resume: null,
    };
  }
  if (ok) {
    return {
      text: `Saved ${name} (${(savedMB + size / 1048576).toFixed(1)} MB, landed late) — keep this tab open.`,
      cls: "",
      resume: null,
    };
  }
  return {
    text: `${name} landed late but didn't finish — see Chrome's downloads. Keep this tab open.`,
    cls: "warn",
    resume: null,
  };
}

// The rename and delete runs' Done lines (an unstopped run; a stopped one prints its own
// error). A result that may still have taken (no answer, or accepted but unverified) is
// counted apart from the refusals: calling it "failed" would tell her it didn't happen.
// A zero count gets no clause, and each line carries one parenthetical at most.
export function renameDoneLine({ ok, failed, uncertain = 0 }, total) {
  if (!failed.length) return { text: `Done: ${ok}/${total} renamed, every one read back.`, cls: "ok" };
  const refused = failed.length - uncertain;
  const clauses = [];
  if (refused) clauses.push(`${refused} failed`);
  if (uncertain) clauses.push(`${uncertain} may have taken`);
  const note = uncertain
    ? `no answer, or unverified — check those sessions; ${refused ? "all " : ""}listed below`
    : "listed below";
  return { text: `Done: ${ok}/${total} renamed and read back; ${clauses.join(", ")} (${note}).`, cls: "warn" };
}

export function deleteDoneLine({ deleted, failed, unanswered = 0 }) {
  const refused = failed.length - unanswered;
  return {
    text: `Done: ${deleted} deleted (the first read back as gone; the rest on the server's OK)`
      + (refused ? `, ${refused} failed` : "")
      + (unanswered ? `, ${unanswered} got no answer (may have been deleted — check the session list)` : "")
      + ".",
    cls: failed.length ? "warn" : "ok",
  };
}
