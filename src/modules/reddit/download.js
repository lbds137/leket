// The reddit save's download half, and it runs in the worker only: the downloads API
// lives there, not in the offscreen document whose blob it reads.
import { trackDownload } from "../../lib/download.js";

// onSettled fires once the download is over for good (a download with no word yet may
// still be reading the blob, so it fires only then — the worker uses it to ask the
// document to revoke).
export async function downloadPrepared(downloads, { url, name }, { timeout, onSettled } = {}) {
  // saveAs is pinned off: a dialog would park the save on a prompt instead of landing
  // the file in ~/Downloads under the CLI's expected name. conflictAction is pinned to
  // overwrite so a re-save of the same post updates that one file — with Chrome's
  // default (uniquify) a re-save would land as reddit-<id> (1).json and the CLI would
  // go on reading the stale original.
  const saved = await trackDownload(downloads, { url, filename: name, saveAs: false, conflictAction: "overwrite" }, { timeout });
  if (saved !== null && onSettled) onSettled();
  if (saved === false) throw new Error(`Chrome didn't complete the save of ${name} — check Chrome's downloads, then click Save again.`);
  return saved === null
    ? { settled: false, message: `${name} is still saving, with no word for a long while — if it never lands in Downloads, click Save again.` }
    : { settled: true, message: `Saved ${name} to Downloads. Next: reddit-export --from-json ~/Downloads/${name}` };
}
