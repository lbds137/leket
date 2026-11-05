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

// `resumeSessions(state, lines)` — the rebuild math for a stopped part that landed
// late: the pasted skip and already-saved ids seed the chain, the landed part's own
// `_session` values join in flush order (deduped — a session's id appears once), and
// the numbering continues past the part that landed. `lines` is this module's own
// output: every event line carries `_session`; the titles line carries none and
// contributes nothing.
export function resumeSessions(state, lines) {
  const savedIds = [...state.savedIds];
  for (const line of lines) {
    const m = /"_session":"([^"]+)"/.exec(line);
    if (m && !savedIds.includes(m[1])) savedIds.push(m[1]);
  }
  return { savedIds, partStart: state.partStart + 1 };
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
// MB total and the per-run state (`stopped`: the onFlush args of the part that stopped
// the run, plus the stop message and class its status line carries); this function only
// says what to print and, when a stopped part landed, the rebuilt resume line to write
// into the resume element. A late marker end with a retained `doneLine` appends to the
// run's summary rather than replacing it; without one it says the standalone line. A
// late part end for the stopped part itself appends to the stop message and the resume
// line is rebuilt; a different part's late end (an earlier silent part outliving a
// later stop) appends only — its sessions are not in the stopped part's lines, so the
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
        resume: resumeLine(resumeSessions(stopped.state, stopped.lines)),
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
