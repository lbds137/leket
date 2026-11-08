// The export page's save seam, extracted from page.js's onFlush/onMarker bodies so the
// tests can pin it under node (page.js itself touches document and cannot import here).
// It builds the Blob, starts the download, and applies the revoke discipline — pure up
// to the injected seams: downloads (the chrome.downloads stand-in), note (the page's
// narration hook), stillCurrent (the run's seq guard). Every user-facing string and the
// MB accounting stay in page.js: the factory narrates only the late ends, through note,
// and returns the settled result plus the blob size for the page's MB math.
import { trackDownload } from "../../lib/download.js";

// `note(event)` fires for a late end only, with { marker, ok, name, size } — marker
// distinguishes the done marker's lines, size feeds the page's MB total when ok.
// stillCurrent() is the seq guard captured at click: a save with no word in 15 minutes
// may still be reading the blob URL, so its late end frees the URL whatever the run —
// but it speaks only if this run still owns the line (a late save outlives its click,
// a second run owns the line).
export function createSaves({ downloads, note, stillCurrent }, { timeout } = {}) {
  const save = async (blob, name, marker) => {
    const url = URL.createObjectURL(blob);
    let saved;
    try {
      saved = await trackDownload(downloads, { url, filename: name, saveAs: false, conflictAction: "overwrite" }, {
        timeout,
        onLate: (ok) => {
          URL.revokeObjectURL(url);
          if (!stillCurrent()) return;
          note({ marker, ok, name, size: blob.size });
        },
      });
    } catch (err) {
      // a synchronous throw from downloads.download rejects trackDownload's promise,
      // which has already dropped its timer and listener: onLate never fires on this
      // path, so this is the only revoke — free the URL here and rethrow unchanged
      URL.revokeObjectURL(url);
      throw err;
    }
    if (saved !== null) URL.revokeObjectURL(url);
    return { saved, size: blob.size };
  };
  return {
    savePart: (lines, name) => save(new Blob(lines, { type: "application/x-ndjson" }), name, false),
    saveMarker: (payload, name) =>
      save(new Blob([JSON.stringify(payload) + "\n"], { type: "application/json" }), name, true),
  };
}

// The page's onFlush glue as one seam the tests can pin: save the part, and stop the run
// unless it saved. A saved part returns its blob size (the page's MB math). Anything else
// calls onStop(kind, err) — kind "error" (the save threw; err is the throw, a synchronous
// download failure among them), "refused" (Chrome interrupted or refused it) or "silent"
// (no word in 15 minutes; it may still land) — and throws the message onStop returns,
// which exportSessions propagates: later sessions are not fetched and no marker is
// written. onStop is where the page records its stopped state and resume line; it gets
// no lines, so nothing the page keeps can hold the part alive. (The marker never stops
// the run: its null path stays page-side narration.)
export async function savePartOrStop(savePart, lines, name, onStop) {
  let out;
  try {
    out = await savePart(lines, name);
  } catch (err) {
    throw new Error(onStop("error", err));
  }
  if (out.saved === true) return out.size;
  throw new Error(onStop(out.saved === false ? "refused" : "silent"));
}
