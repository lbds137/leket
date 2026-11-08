// The export tab: reads the save from the Discord tab's bridge, fetches its attachments,
// builds the zip and downloads it. It stays open with what happened.
import { build } from "../../lib/build.js";
import { attachmentList, needsParts } from "../../lib/files.js";
import { PART_LIMIT } from "../../lib/zip.js";
import { createPartDownload } from "../../lib/part.js";
import { esc } from "../../lib/render.js";
import { summarize } from "../../lib/summary.js";

const $ = (id) => document.getElementById(id);
const say = (text, cls = "") => { $("status").textContent = text; $("status").className = cls; };
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));
const key = params.get("key");

const ask = (msg) => chrome.tabs.sendMessage(tabId, { ...msg, key });

async function readSave() {
  const first = await ask({ type: "discord-tools:chunk", index: 0 });
  if (!first || first.error) throw new Error((first && first.error) || "The Discord tab didn't answer: is it still open?");
  const pieces = [first.chunk];
  for (let i = 1; i < first.total; i++) {
    const r = await ask({ type: "discord-tools:chunk", index: i });
    if (!r || r.error) throw new Error((r && r.error) || "The Discord tab stopped answering partway.");
    pieces.push(r.chunk);
  }
  return { file: first.file, attachments: first.attachments, exp: JSON.parse(pieces.join("")) };
}

// builds the visible link for one part; chrome.downloads.download does the actual
// downloading (this anchor is what the user clicks to retry a part by hand)
function partLink(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.textContent = `${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;
  const li = document.createElement("li");
  li.appendChild(a);
  return { a, li, url, name };
}

const humanSize = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB`
  : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.ceil(b / 1024)} KB`;

(async () => {
  try {
    const save = await readSave();
    const { attachments, exp } = save;
    // the collector's own names are "discord-<name>-<channel id>.json"; anything else posted
    // to the bridge (a path, a name the zip uses itself) is not used as a file name
    const file = /^discord-[\p{L}\p{N}._-]+-\d+\.json$/u.test(save.file) ? save.file : "discord-export.json";
    document.title = `Discord tools: ${exp.channel || "saving"}`;
    $("title").textContent = [exp.channel, exp.guild_name].filter(Boolean).join(" · ") || "Discord tools";
    const records = attachments ? attachmentList(exp) : [];
    const sized = records.reduce((s, r) => s + (r.size != null ? r.size : 0), 0);
    const unsized = records.length - records.filter((r) => r.size != null).length;
    const projectBytes = sized + unsized * 4 * 1024 ** 2;
    // too big to hold twice (build every part, then download them all): stream instead, a
    // part at a time. Either way each part is downloaded the moment it is built.
    const stream = needsParts(records, PART_LIMIT);
    const bar = $("bar");
    bar.hidden = !records.length;
    bar.max = records.length || 1;
    let fetchDone = 0, packDone = 0, fetchFailed = 0, partsSaved = 0;
    const progress = () => {
      bar.value = fetchDone;
      $("detail").textContent = [
        records.length ? `Attachment ${fetchDone} of ${records.length}${fetchFailed ? ` (${fetchFailed} failed)` : ""}` : "",
        packDone ? `packed ${packDone}` : "",
        partsSaved ? `${partsSaved} part${partsSaved === 1 ? "" : "s"} saved` : "",
      ].filter(Boolean).join(" · ");
    };
    const list = document.createElement("ul");
    let note = null;
    const ensureNote = () => {
      if (note) return;
      note = document.createElement("p");
      note.textContent = "If Chrome asks anything about downloading files, allow it; if a part below says it didn't finish, click it to try again.";
      $("downloads").replaceChildren(note, list);
    };
    $("downloads").replaceChildren(list);
    if (stream) ensureNote();

    // the disk check, before anything downloads: a save that can't fit burns an hour before
    // it says so. Chrome's quota isn't exactly the free space on disk, so it warns instead
    // of refusing — parts download one at a time, so whatever lands before a full disk is kept.
    if (projectBytes > 16 * 1024 * 1024) {
      try {
        const est = await navigator.storage?.estimate?.();
        const free = est ? est.quota - est.usage : null;
        if (free != null && projectBytes > free) {
          const p = document.createElement("p");
          p.className = "warn";
          p.textContent = `This save is about ${humanSize(projectBytes)} of files, and this page's browser storage reports only about ${humanSize(free)} available — the save may not fit. ` +
            "(That number is a storage quota, not exactly the free space on your disk.) Parts download one at a time, so whatever is saved before storage fills up is kept; the rest can be retried once you free up space.";
          $("problems").appendChild(p);
        }
      } catch { /* no estimate to be had; save anyway */ }
    }

    // set once the build is over: redraws the summary after a part is saved by a click
    let render = null;

    // one part: hand it to Chrome's downloads API, wait until it is done, then free the
    // blob. On a failure (or no word for a quarter of an hour) the link stays. A click on
    // it is never a second, untracked download: the part (src/lib/part.js) asks Chrome
    // about the latest tracked one first, and only downloads again (tracked) when that
    // one is over or gone. This page keeps the DOM — the labels, the list item, the
    // counters — and the part tells it what to say.
    const linkNote = {
      "didnt-finish": "— didn't finish; click to try again",
      "no-word": "— still no word that it finished; if it isn't in Downloads, click to try again",
      "starting": "— waiting for Chrome to start it; if Chrome asks about downloading files, allow it",
      "downloading": "— still downloading; see Chrome's downloads",
      "saving-again": "— saving again…",
      "unavailable": "— Chrome couldn't be asked where its last try stands; click to ask again",
    };
    const downloadPart = async ({ blob, name, index }) => {
      say(`Saving ${name}…`);
      const { a, li, url } = partLink(blob, name);
      const label = a.textContent;
      list.appendChild(li);
      const part = createPartDownload(chrome.downloads, { url, name, index }, {
        label: (kind) => { a.textContent = `${label} ${linkNote[kind]}`; },
        saved: () => {
          partsSaved++;
          // the dead link becomes a plain label, and the summary follows
          a.removeAttribute("href");
          a.textContent = `${label} — saved`;
          if (render) render();
          else progress();
        },
        free: () => URL.revokeObjectURL(url),
      });
      // the part decides what a click does; the page only hands the click over
      a.addEventListener("click", (e) => {
        e.preventDefault();
        // a hook throwing inside the click must not become an unhandled rejection
        // (the old async listener had the same exposure); keep the signal on the console
        part.click().catch((err) => console.error(`${name} click failed:`, err));
      });
      await part.start();
      return part.result;
    };

    say(attachments ? "Saving the attachments… keep this tab open." : "Building the zip…");
    const results = [];
    const onPart = stream ? async (entry) => {
      say(entry.index === 1
        ? "Saving part 1: the messages and the readable page (they are kept whatever happens to the rest)…"
        : `Saving part ${entry.index}…`);
      const result = await downloadPart(entry);
      results.push(result);
      progress();
      // false stops the build: the rest of the attachments stay unfetched instead of
      // piling failed 2 GB parts up on a full disk (the manifest lists them unsaved)
      return result.ok;
    } : undefined;
    // the build's own records (each small-save file noting its part), not this tab's list
    const { parts, failed, leftBehind, records: builtRecords } = await build(exp, {
      file, attachments, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      onProgress: ({ phase, done, failed: bad }) => {
        if (phase === "fetch") { fetchDone = done; fetchFailed = bad || 0; }
        else packDone = done;
        progress();
      },
      onPart,
    });
    if (!stream) {
      // a small save: the parts come back as Blobs and download here
      if (parts.length > 1) ensureNote();
      for (const p of parts) {
        const result = await downloadPart(p);
        results.push(result);
      }
    }
    bar.hidden = true;
    // the summary's own spot among the problems, so a redraw leaves the disk warning be
    const lostBox = document.createElement("div");
    $("problems").appendChild(lostBox);
    let released = false;
    // the summary, from where things stand now: drawn once the build is over, and again
    // whenever a click or a late finish saves a part (perhaps before the build was over)
    render = (first = false) => {
      const { lost, release, close, detail, status, warn } = summarize({
        results, failed, leftBehind, records: builtRecords, messages: (exp.messages || []).length,
        attachments: records.length, streamed: stream, first });
      // the Discord tab holds the save so that reloading this tab can rebuild it, so it
      // lets go only once every part is down and nothing was left out of every part by a
      // stopped save (reloading this tab is how to get those)
      if (!released && release) {
        released = true;
        ask({ type: "discord-tools:release" }).catch(() => {});
      }
      $("detail").textContent = detail;
      lostBox.replaceChildren();
      if (lost.length) {
        const p = document.createElement("p");
        p.className = "warn";
        p.textContent = `${lost.length} attachment(s) could not be saved. Links Discord gives out expire after about a day: reload the Discord tab and save again to retry them.`;
        const ul = document.createElement("ul");
        ul.innerHTML = lost.slice(0, 200).map((r) => `<li>${esc(r.filename)}: ${esc(r.error)}</li>`).join("") +
          (lost.length > 200 ? `<li>… and ${lost.length - 200} more (all listed in discord-attachments.json)</li>` : "");
        lostBox.append(p, ul);
      }
      if (close) window.close();
      else say(status, warn ? "warn" : "");
    };
    render(true);
  } catch (e) {
    $("bar").hidden = true;
    say(`Couldn't save: ${(e && e.message) || e}`, "warn");
  }
})();
