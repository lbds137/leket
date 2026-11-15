// The Messenger export tab: reads the save and its media Blobs from the Messenger tab's
// bridge, builds the zip (JSON, Markdown, messenger-media/*) and downloads it.
import { ZipWriter } from "../../lib/zip.js";
import { createPartDownload } from "../../lib/part.js";
import { esc } from "../../lib/render.js";
import { foldName, kindOf, listMedia, messagesOf, readMediaFile, settleMedia } from "./media.js";

const { renderMarkdown, validMediaName, validSaveName } = globalThis.LeketMessengerRead;

const $ = (id) => document.getElementById(id);
const say = (text, cls = "") => { $("status").textContent = text; $("status").className = cls; };
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));
const key = params.get("key");

const ask = (msg) => chrome.tabs.sendMessage(tabId, { ...msg, key });

async function readSave() {
  const first = await ask({ type: "leket:chunk", index: 0 });
  if (!first || first.error) throw new Error((first && first.error) || "The Messenger tab didn't answer: is it still open?");
  const pieces = [first.chunk];
  for (let i = 1; i < first.total; i++) {
    const r = await ask({ type: "leket:chunk", index: i });
    if (!r || r.error) throw new Error((r && r.error) || "The Messenger tab stopped answering partway.");
    pieces.push(r.chunk);
  }
  return { file: first.file, fileCount: Number(first.files) || 0, exp: JSON.parse(pieces.join("")) };
}

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

(async () => {
  try {
    const save = await readSave();
    const { fileCount, exp } = save;
    // every consumer below sees an array of objects, whatever the save held
    exp.messages = messagesOf(exp);
    const file = validSaveName(save.file);
    const base = file.replace(/\.json$/, "");
    const mdFile = `${base}.md`;

    document.title = `Leket: ${exp.title || "saving"}`;
    $("title").textContent = [exp.title, exp.host].filter(Boolean).join(" · ") || "Leket";

    // Every media file the save lists (media.js). The JSON and Markdown are written after
    // the media is read, so they name only files the zip holds; the rest become
    // not-captured entries on their own message.
    const listing = listMedia(exp, validMediaName);
    const { listed } = listing;
    const notCaptured = [
      ...(Array.isArray(exp.media_not_captured) ? exp.media_not_captured : []),
      ...listing.notCaptured,
    ];
    const saved = new Set(); // folded names the zip holds
    const whyNot = new Map(); // folded name → why its read failed
    const readErrors = []; // failures before a file named itself: shown on the page only
    let stopped = null; // why the reads stopped early: the reason for every file not read

    const zip = new ZipWriter();
    const bar = $("bar");
    bar.hidden = !fileCount;
    bar.max = fileCount || 1;
    let photosSaved = 0;
    let videosSaved = 0;

    // Read and pack one media file at a time so no more than one file's bytes are held decoded at once.
    for (let i = 0; i < fileCount; i++) {
      say(`Reading media ${i + 1} of ${fileCount}…`);
      bar.value = i;
      const accept = (name) => listed.has(foldName(name)) && !saved.has(foldName(name))
        && listed.get(foldName(name)).name === name;
      let got;
      try {
        got = await readMediaFile(ask, i, accept);
      } catch (e) {
        got = { status: "error", reason: `media file ${i + 1}: ${(e && e.message) || e}` };
      }
      if (got.status === "gone") throw new Error(got.reason);
      if (got.status === "tab-gone") {
        stopped = got.reason;
        break;
      }
      if (got.status === "error") {
        readErrors.push(got.reason);
        continue;
      }
      const folded = foldName(got.name);
      if (got.status === "failed") {
        whyNot.set(folded, got.reason);
        continue;
      }
      try {
        zip.add(`messenger-media/${got.name}`, got.data, got.crc);
      } catch (e) {
        whyNot.set(folded, `couldn't be added to the zip: ${(e && e.message) || e}`);
        continue;
      }
      saved.add(folded);
      if (kindOf(listed.get(folded).med) === "video") videosSaved++;
      else photosSaved++;
      bar.value = i + 1;
    }
    if (stopped) readErrors.push(`${stopped}; the media not read by then is listed as not captured.`);

    settleMedia(exp, listed, saved, whyNot, notCaptured, stopped || undefined);

    const timeZone = exp.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const enc = new TextEncoder();
    zip.add(file, enc.encode(JSON.stringify(exp, null, 1)));
    zip.add(mdFile, enc.encode(renderMarkdown(exp, { timeZone })));

    const rawParts = zip.parts();
    const parts = rawParts.map((blob, i) => ({
      blob,
      index: i + 1,
      name: rawParts.length === 1 ? `${base}.zip` : `${base}-part${i + 1}-of-${rawParts.length}.zip`,
    }));

    const list = document.createElement("ul");
    if (parts.length > 1) {
      const note = document.createElement("p");
      note.textContent = "If Chrome asks anything about downloading files, allow it; if a part below says it didn't finish, click it to try again.";
      $("downloads").replaceChildren(note, list);
    } else {
      $("downloads").replaceChildren(list);
    }

    let render = null;
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
          a.removeAttribute("href");
          a.textContent = `${label} — saved`;
          if (render) render();
        },
        free: () => URL.revokeObjectURL(url),
      });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        part.click().catch((err) => console.error(`${name} click failed:`, err));
      });
      await part.start();
      return part.result;
    };

    const results = [];
    for (const p of parts) {
      const result = await downloadPart(p);
      results.push(result);
    }
    bar.hidden = true;

    const lostBox = document.createElement("div");
    $("problems").appendChild(lostBox);
    let released = false;
    const messageCount = exp.messages.length;

    render = () => {
      const badParts = results.filter((r) => !r.ok);
      if (!released && !badParts.length) {
        released = true;
        ask({ type: "leket:release" }).catch(() => {});
      }
      const countsText = `${messageCount} messages, ${photosSaved} photo(s) and ${videosSaved} video(s) saved, ${notCaptured.length} media seen but not captured`;
      $("detail").textContent = `Unzip it and open ${mdFile} to read it. ${countsText}.`;
      lostBox.replaceChildren();
      if (notCaptured.length) {
        const p = document.createElement("p");
        p.className = "warn";
        p.textContent = `${notCaptured.length} media item(s) seen but not captured:`;
        const ul = document.createElement("ul");
        ul.innerHTML = notCaptured.slice(0, 200).map((r) =>
          `<li>${esc(r.kind || "media")}${r.message_id ? ` (${esc(r.message_id)})` : ""}: ${esc(r.reason || "not captured")}</li>`,
        ).join("");
        lostBox.append(p, ul);
      }
      if (readErrors.length) {
        const p = document.createElement("p");
        p.className = "warn";
        p.textContent = "Problems reading media from the Messenger tab:";
        const ul = document.createElement("ul");
        ul.innerHTML = readErrors.slice(0, 200).map((r) => `<li>${esc(r)}</li>`).join("");
        lostBox.append(p, ul);
      }
      if (badParts.length) {
        say(`${countsText}. ${badParts.length} part(s) didn't finish — click them above to try again.`, "warn");
      } else {
        say(`Saved ${countsText}. Every part is downloaded.`, notCaptured.length ? "warn" : "ok");
      }
    };
    render();
  } catch (e) {
    $("bar").hidden = true;
    say(`Couldn't save: ${(e && e.message) || e}`, "warn");
  }
})();
