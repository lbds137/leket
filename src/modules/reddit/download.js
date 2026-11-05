// The reddit save's download half, and it runs in the worker only: the downloads API
// lives there, not in the offscreen document whose blob it reads.
import { trackDownload } from "../../lib/download.js";

// files is the array of { url, name } to save, in order (json first, md second): each
// downloads on its own before the next starts. A refused or interrupted download
// throws — the later files are not attempted (their blobs freed: nothing will read
// them), and a re-click re-saves the lot (overwrite makes that clean). onSettled fires
// per file, with that file's entry, once ITS download
// is over for good (a download with no word yet may still be reading the blob, so it
// fires only then — the worker uses it to ask the document to revoke that blob).
export async function downloadPrepared(downloads, files, { timeout, onSettled } = {}) {
  // saveAs is pinned off so the save never raises a prompt of its own; Chrome's own
  // "ask where to save each file" setting still asks when it is on — the API flag
  // can't suppress the user's setting (runtime-confirmed 11-04) — and the save lands
  // under the CLI's expected name once it is answered. conflictAction is pinned to
  // overwrite so a re-save of the same post updates that one file — with Chrome's
  // default (uniquify) a re-save would land as reddit-<id> (1).json and the CLI would
  // go on reading the stale original.
  const settled = [];
  const unsettled = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const saved = await trackDownload(downloads, { url: file.url, filename: file.name, saveAs: false, conflictAction: "overwrite" }, { timeout });
    if (saved !== null && onSettled) onSettled(file);
    if (saved === false) {
      // this save is over for good, and so are the files after it: nothing will ever
      // read their blobs, so they are revoked alongside this one's — a skipped file's
      // blob would otherwise sit in the document (MBs on a big thread) until restart
      if (onSettled) for (const rest of files.slice(i + 1)) onSettled(rest);
      throw new Error(`Chrome didn't complete the save of ${file.name} — check Chrome's downloads, then click Save again.`);
    }
    (saved === null ? unsettled : settled).push(file);
  }
  let message;
  if (unsettled.length === 0) {
    message = `Saved ${settled.map((f) => f.name).join(" and ")} to Downloads.`;
  } else if (settled.length === 1) {
    message = `Saved ${settled[0].name} to Downloads. ${unsettled[0].name} is still saving, with no word for a long while — if it never lands in Downloads, click Save again.`;
  } else {
    message = `${unsettled.map((f) => f.name).join(" and ")} are still saving, with no word for a long while — if they never land in Downloads, click Save again.`;
  }
  return { settled: unsettled.length === 0, message };
}
