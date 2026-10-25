// The export tab: reads the save from the Discord tab's bridge, fetches its attachments,
// builds the zip and downloads it. It stays open with what happened.
import { build } from "./lib/build.js";
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
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.textContent = `${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;
  const li = document.createElement("li");
  li.appendChild(a);
  return { a, li };
}

(async () => {
  try {
    const save = await readSave();
    const { attachments, exp } = save;
    // the collector's own names are "discord-<name>-<channel id>.json"; anything else posted
    // to the bridge (a path, a name the zip uses itself) is not used as a file name
    const file = /^discord-[\p{L}\p{N}._-]+-\d+\.json$/u.test(save.file) ? save.file : "discord-export.json";
    document.title = `Discord tools: ${exp.channel || "saving"}`;
    $("title").textContent = [exp.channel, exp.guild_name].filter(Boolean).join(" · ") || "Discord tools";
    const bar = $("bar");
    say(attachments ? "Saving the attachments… keep this tab open." : "Building the zip…");
    const { parts, saved, failed, records } = await build(exp, {
      file, attachments, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      onProgress: ({ phase, done, total, failed: bad }) => {
        bar.hidden = false;
        bar.max = total;
        bar.value = done;
        $("detail").textContent = phase === "fetch"
          ? `Attachment ${done} of ${total}${bad ? ` (${bad} failed)` : ""}`
          : `Packing ${done} of ${total}`;
      },
    });
    bar.hidden = true;
    const list = document.createElement("ul");
    const links = parts.map(({ blob, name }) => download(blob, name));
    links.forEach(({ li }) => list.appendChild(li));
    $("downloads").replaceChildren(list);
    links.forEach(({ a }) => a.click());
    // kept by the Discord tab until now, so a failed build can be retried by reloading this tab
    ask({ type: "discord-tools:release" }).catch(() => {});
    const n = (exp.messages || []).length;
    say(`Saved ${n} messages${records.length ? ` and ${saved} of ${records.length} attachments` : ""}.`, failed.length ? "warn" : "ok");
    $("detail").innerHTML =
      (parts.length > 1 ? `The save is in ${parts.length} parts: unzip them all into the same folder, then open index.html. ` : "Unzip it and open index.html to read it. ") +
      (parts.length > 1 ? "If Chrome asks whether this page may download several files, allow it; or click each link below."
        : "If the download didn't start, click the link below.");
    if (failed.length) {
      $("problems").innerHTML = `<p class="warn">${failed.length} attachment(s) could not be saved. ` +
        "Links Discord gives out expire after about a day: reload the Discord tab and save again to retry them.</p><ul>" +
        failed.slice(0, 200).map((r) => `<li>${esc(r.filename)}: ${esc(r.error)}</li>`).join("") +
        (failed.length > 200 ? `<li>… and ${failed.length - 200} more (all listed in discord-attachments.json)</li>` : "") + "</ul>";
    }
  } catch (e) {
    $("bar").hidden = true;
    say(`Couldn't save: ${(e && e.message) || e}`, "warn");
  }
})();
