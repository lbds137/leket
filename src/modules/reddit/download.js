// The reddit save's download half, and it runs in the worker only: the downloads API
// lives there, not in the offscreen document whose blob it reads.
import { trackDownload } from "../../lib/download.js";

// onSettled fires once the download is over for good (a download with no word yet may
// still be reading the blob, so it fires only then — the worker uses it to ask the
// document to revoke).
export async function downloadPrepared(downloads, { url, name }, { timeout, onSettled } = {}) {
  // saveAs is pinned off so the save never raises a prompt of its own; Chrome's own
  // "ask where to save each file" setting still asks when it is on — the API flag
  // can't suppress the user's setting (runtime-confirmed 11-04) — and the save lands
  // under the CLI's expected name once it is answered. conflictAction is pinned to
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
