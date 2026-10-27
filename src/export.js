// The export tab: reads the save from the Discord tab's bridge, fetches its attachments,
// builds the zip and downloads it. It stays open with what happened.
import { build } from "./lib/build.js";
import { attachmentList, needsParts } from "./lib/files.js";
import { PART_LIMIT } from "./lib/zip.js";
import { esc } from "./lib/render.js";

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

function download(blob, name) {
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
      note.textContent = "If Chrome asks anything about downloading files, allow it; if a part below doesn't start, click it to try again.";
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

    // one part: hand it to Chrome's downloads API, wait until THIS download (matched by
    // the id the call returns, never by name) is done, then free the blob. On a failure
    // (or no word for a quarter of an hour) the link stays for a retry by hand.
    const downloadPart = async ({ blob, name }) => {
      say(`Saving ${name}…`);
      const { a, li, url } = download(blob, name);
      list.appendChild(li);
      const ok = await new Promise((resolve) => {
        let id = null;
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve(v);
        };
        const onChanged = (delta) => {
          if (id == null || delta.id !== id) return;
          const state = delta.state && delta.state.current;
          if (state === "complete" || state === "interrupted") done(state === "complete");
        };
        const timer = setTimeout(() => done(null), 15 * 60 * 1000);
        chrome.downloads.onChanged.addListener(onChanged);
        chrome.downloads.download({ url, filename: name }).then(async (mid) => {
          id = mid;
          // a small part can finish before the promise resolved, and its `complete` event
          // was ignored above (no id yet): settle from the download record instead
          try {
            const [item] = await chrome.downloads.search({ id });
            const state = item && item.state;
            if (state === "complete" || state === "interrupted") done(state === "complete");
          } catch { /* the events will tell */ }
        }, () => done(false));
      });
      if (ok) {
        // saved: the object URL can go, and the dead link becomes a plain label
        URL.revokeObjectURL(url);
        a.removeAttribute("href");
        a.textContent += " — saved";
      } else if (ok === false) {
        a.textContent += " — didn't finish; click to try again";
      } else {
        // no word for a quarter of an hour: it may still be downloading, so say that
        a.textContent += " — still no word that it finished; if it isn't in Downloads, click to try again";
      }
      return ok === true;
    };

    say(attachments ? "Saving the attachments… keep this tab open." : "Building the zip…");
    const results = [];
    const onPart = stream ? async (entry) => {
      say(entry.index === 1
        ? "Saving part 1: the messages and the readable page (they are kept whatever happens to the rest)…"
        : `Saving part ${entry.index}…`);
      const ok = await downloadPart(entry);
      if (ok) partsSaved++;
      results.push({ name: entry.name, ok });
      progress();
      // false stops the build: the rest of the attachments stay unfetched instead of
      // piling failed 2 GB parts up on a full disk (the manifest lists them unsaved)
      return ok === true;
    } : undefined;
    const { parts, saved, failed } = await build(exp, {
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
        const ok = await downloadPart(p);
        if (ok) partsSaved++;
        results.push({ name: p.name, ok });
      }
    }
    bar.hidden = true;
    // the Discord tab held this save so a failed build could be retried by reloading this
    // tab; every part is downloaded now, so it can let go
    ask({ type: "discord-tools:release" }).catch(() => {});
    const badParts = results.filter((r) => !r.ok);
    const n = (exp.messages || []).length;
    const savedText = `Saved ${n} messages${records.length ? ` and ${saved} of ${records.length} attachments` : ""}.`;
    $("detail").innerHTML =
      (results.length > 1 ? `The save is in ${results.length} parts: unzip them all into the same folder, then open index.html. `
        : "Unzip it and open index.html to read it. ") +
      (badParts.length ? `${badParts.length} part(s) above didn't finish — click them to try again. ` : "");
    if (failed.length) {
      const p = document.createElement("p");
      p.className = "warn";
      p.textContent = `${failed.length} attachment(s) could not be saved. Links Discord gives out expire after about a day: reload the Discord tab and save again to retry them.`;
      const ul = document.createElement("ul");
      ul.innerHTML = failed.slice(0, 200).map((r) => `<li>${esc(r.filename)}: ${esc(r.error)}</li>`).join("") +
        (failed.length > 200 ? `<li>… and ${failed.length - 200} more (all listed in discord-attachments.json)</li>` : "");
      $("problems").appendChild(p);
      $("problems").appendChild(ul);
    }
    if (badParts.length) {
      const stoppedNote = stream
        ? " The save stopped there — the rest of the attachments are listed as unsaved in discord-attachments.json. Free up space, then click the part above to try it again, or save again from the Discord tab for the rest."
        : "";
      say(`${savedText} ${badParts.length} part(s) didn't finish — click them above to try again.${stoppedNote}`, "warn");
    } else if (!failed.length) window.close();
    else if (!failed.length) window.close();
    else say(`${savedText} This tab stays open because ${failed.length} attachment(s) could not be saved.`, "warn");
  } catch (e) {
    $("bar").hidden = true;
    say(`Couldn't save: ${(e && e.message) || e}`, "warn");
  }
})();
