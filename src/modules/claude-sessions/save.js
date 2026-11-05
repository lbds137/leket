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
      // a synchronous throw from downloads.download escapes before trackDownload's
      // promise settles — free the URL here and rethrow unchanged. The throw left the
      // wait timer live, so trackDownload's done(null) still fires at the timeout: its
      // onLate revoke is harmless on an already-revoked URL, and its note stays the
      // late end's narrator (lib/download.js's contract, not fought here).
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

// The part-stop rule, pure and exported so the tests pin it without a downloads seam:
// a saved part returns; a refused or interrupted part throws refusedMessage; a part
// that got no word in 15 minutes throws silentMessage. The strings stay page-side —
// the helper only picks and throws. The thrown errors carry `partStop` so the page's
// onFlush can tell them from a foreign throw (a synchronous download failure among
// them) and convert only the foreign ones. (The marker never stops the run: its null
// path stays page-side narration.)
export function partStop({ saved }, { refusedMessage, silentMessage }) {
  if (saved === false) {
    const err = new Error(refusedMessage);
    err.partStop = true;
    throw err;
  }
  if (saved === null) {
    const err = new Error(silentMessage);
    err.partStop = true;
    throw err;
  }
}
