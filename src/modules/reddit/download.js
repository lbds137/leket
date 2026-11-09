// The reddit save's download half, and it runs in the worker only: the downloads API
// lives there, not in the offscreen document whose blob it reads.
import { trackDownload } from "../../lib/download.js";

// files is the [json, md] pair of { url, name } to save, in order: each downloads on its
// own before the next starts. A refused or interrupted json or md download throws — the
// later files are not attempted (their blobs freed: nothing will read them), and a
// re-click re-saves the lot (overwrite makes that clean). When opts.images is given, the
// post's images are fetched and downloaded one at a time into opts.images.folder between
// the json and the md (a failed image is noted and skipped without stopping the save),
// and when at least one image saved, renderMd(saved) re-renders the .md with relative
// links and replaces files[1] (freeing its unlinked blob; a renderMd failure keeps the
// prepared .md). onSettled fires per file or image, with its { url, name }, once its own
// download is over for good (a download with no word yet may still be reading the blob,
// so it fires only then — the worker uses it to ask the document to revoke that blob).
// The message builder's three base shapes cover the [json, md] pair, followed by the
// images sentence (when images.list is non-empty) and the unfetched-comments note (when
// notFetched.count > 0 and both main files saved).
export async function downloadPrepared(downloads, files, { timeout, onSettled, notFetched, images } = {}) {
  // saveAs is pinned off so the save never raises a prompt of its own; Chrome's own
  // "ask where to save each file" setting still asks when it is on — the API flag
  // can't suppress the user's setting (runtime-confirmed 11-04) — and the save lands
  // under the CLI's expected name once it is answered. conflictAction is pinned to
  // overwrite so a re-save of the same post updates that one file — with Chrome's
  // default (uniquify) a re-save would land as reddit-<id> (1).json and the CLI would
  // go on reading the stale original.
  const settled = [];
  const unsettled = [];
  const savedImages = {};
  const failedImages = [];
  let renderFailed = false;
  const failMain = (file, rest) => {
    // this save is over for good, and so are the files after it: nothing will ever
    // read their blobs, so they are revoked alongside this one's — a skipped file's
    // blob would otherwise sit in the document (MBs on a big thread) until restart
    if (onSettled) for (const r of rest) onSettled(r);
    const stillSaving = unsettled.map((f) => f.name).join(" and ");
    throw new Error(`Chrome didn't complete the save of ${file.name}`
      + (stillSaving ? `; ${stillSaving} ${unsettled.length === 1 ? "is" : "are"} still saving, unconfirmed` : "")
      + " — check Chrome's downloads, then click Save again.");
  };
  for (let i = 0; i < files.length; i++) {
    let file = files[i];
    if (i === 1 && images && Array.isArray(images.list) && images.list.length > 0) {
      for (const row of images.list) {
        let r;
        try {
          r = await images.fetchImage(row.n);
        } catch (e) {
          r = { ok: false, error: (e && e.message) || String(e) };
        }
        if (!r || !r.ok) {
          failedImages.push({ n: row.n, why: (r && r.error) || "no answer" });
          continue;
        }
        const entry = { url: r.url, name: r.name };
        let imgSaved;
        try {
          // a download still going at the timeout stays watched, so a late end still frees
          // its blob (an image can be 50 MB; the json and md blobs are small)
          imgSaved = await trackDownload(
            downloads,
            { url: r.url, filename: `${images.folder}/${r.name}`, saveAs: false, conflictAction: "overwrite" },
            { timeout, onLate: () => { if (onSettled) onSettled(entry); } },
          );
        } catch {
          // Chrome refused to start it: nothing reads the blob, and the save goes on
          if (onSettled) onSettled(entry);
          failedImages.push({ n: row.n, why: "Chrome refused the download" });
          continue;
        }
        if (imgSaved !== null && onSettled) onSettled(entry);
        if (imgSaved === true) {
          savedImages[row.n] = r.name;
        } else if (imgSaved === false) {
          failedImages.push({ n: row.n, why: "Chrome didn't complete the save" });
        } else {
          failedImages.push({ n: row.n, why: "no word from Chrome yet" });
        }
      }
      if (Object.keys(savedImages).length > 0) {
        // the fallback helps when the save page is alive but the render failed; if the
        // save page is gone, the prepared .md's blob went with it, so its download is
        // interrupted and failMain reports it
        let md;
        try {
          md = await images.renderMd(savedImages);
        } catch (e) {
          // the reason stays out of the popup (one is a whole sentence of its own) but not
          // out of reach: the worker's console keeps it
          console.warn("leket: the .md re-render failed; saving the prepared .md", e);
          renderFailed = true;
        }
        if (!renderFailed) {
          if (onSettled) onSettled(file);
          file = md;
        }
      }
    }
    const saved = await trackDownload(downloads, { url: file.url, filename: file.name, saveAs: false, conflictAction: "overwrite" }, { timeout });
    if (saved !== null && onSettled) onSettled(file);
    if (saved === false) {
      failMain(file, files.slice(i + 1));
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
  if (images && Array.isArray(images.list) && images.list.length > 0) {
    const k = Object.keys(savedImages).length;
    const m = images.list.length;
    const why = failedImages.map((f) => `image ${f.n}: ${f.why}`).join("; ");
    if (k === m) {
      message += ` The post's ${m === 1 ? "image is" : `${m} images are`} in ${images.folder}.`;
    } else if (k > 0) {
      // with renderFailed, the sentence below says where the .md links them all
      message += ` ${k} of ${m} images saved in ${images.folder}${renderFailed ? "" : "; the .md links the rest where they're hosted"} (${why}).`;
    } else {
      message += ` The post's ${m === 1 ? "image wasn't" : "images weren't"} saved; the .md links ${m === 1 ? "it where it's" : "them where they're"} hosted (${why}).`;
    }
    if (renderFailed) {
      message += " The .md couldn't be rewritten to link the saved images, so it links every image where it's hosted.";
    }
  }
  const n = notFetched && Number.isFinite(notFetched.count) ? notFetched.count : 0;
  if (n > 0 && unsettled.length === 0) {
    const howMany = notFetched.atLeast ? `At least ${n}` : `${n}`;
    message += ` ${howMany} more comment${n === 1 ? " wasn't" : "s weren't"} fetched — the .md links to them on reddit.`;
  }
  return { settled: unsettled.length === 0, message };
}
