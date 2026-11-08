// The reddit save's download half, and it runs in the worker only: the downloads API
// lives there, not in the offscreen document whose blob it reads.
import { trackDownload } from "../../lib/download.js";

// files is the array of { url, name } to save, in order (json first, md second): each
// downloads on its own before the next starts. A refused or interrupted download
// throws — the later files are not attempted (their blobs freed: nothing will read
// them), and a re-click re-saves the lot (overwrite makes that clean). onSettled fires
// per file, with that file's entry, once its own download is over for good (a download
// with no word yet may still be reading the blob, so it fires only then — the worker
// uses it to ask the document to revoke that blob).
// Background always passes exactly two files, json then md; the message builder's
// three shapes below assume that count. notFetched is md.js's { count, atLeast }: when
// count > 0 and both files saved, the message adds the unfetched-comments note (never
// while the .md is unconfirmed, since the note points the reader at it).
export async function downloadPrepared(downloads, files, { timeout, onSettled, notFetched } = {}) {
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
      const stillSaving = unsettled.map((f) => f.name).join(" and ");
      throw new Error(`Chrome didn't complete the save of ${file.name}`
        + (stillSaving ? `; ${stillSaving} ${unsettled.length === 1 ? "is" : "are"} still saving, unconfirmed` : "")
        + " — check Chrome's downloads, then click Save again.");
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
  const n = notFetched && Number.isFinite(notFetched.count) ? notFetched.count : 0;
  if (n > 0 && unsettled.length === 0) {
    const howMany = notFetched.atLeast ? `At least ${n}` : `${n}`;
    message += ` ${howMany} more comment${n === 1 ? " wasn't" : "s weren't"} fetched — the .md links to them on reddit.`;
  }
  return { settled: unsettled.length === 0, message };
}
