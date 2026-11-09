// The reddit module's offscreen document: fetches the post's json and prepares the
// blob when the worker asks, frees a settled blob when told, and answers with the
// result. It stays open — the next save reuses it, and closing it could kill a
// download still reading its blob. chrome.runtime is the only extension API here; the
// download itself belongs to the worker.
import { preparePostJson, fetchImage } from "./prepare.js";
import { render } from "./md.js";

const saves = new Map();

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // the worker is the only caller that matters; mirror its sender line — a content
  // script's relay carries sender.tab, and websites cannot message the extension at all
  if (!msg || !sender || sender.tab || sender.id !== chrome.runtime.id) return;
  if (msg.type === "leket:reddit-save-revoke" && typeof msg.url === "string") {
    URL.revokeObjectURL(msg.url);
    reply({ ok: true });
    return;
  }
  if (msg.type === "leket:reddit-save-run" && typeof msg.tabUrl === "string") {
    preparePostJson(msg.tabUrl).then(
      ({ id, data, images, url, name, mdUrl, mdName, notFetched }) => {
        const token = crypto.randomUUID();
        saves.set(token, { id, data, notFetched, images });
        reply({ ok: true, token, id, images, url, name, mdUrl, mdName, notFetched });
      },
      (e) => reply({ ok: false, error: (e && e.message) || String(e) }),
    );
    return true; // the answer comes after the fetch
  }
  if (msg.type === "leket:reddit-save-image") {
    const save = saves.get(msg.token);
    const row = save && save.images.find((im) => im.n === msg.n);
    if (!row) {
      reply({ ok: false, error: "that save is over" });
      return;
    }
    fetchImage(row).then(
      ({ url, name }) => reply({ ok: true, url, name }),
      (e) => reply({ ok: false, error: (e && e.message) || String(e) }),
    );
    return true;
  }
  if (msg.type === "leket:reddit-save-md") {
    const save = saves.get(msg.token);
    if (!save) {
      reply({ ok: false, error: "that save is over" });
      return;
    }
    if (msg.folderRel !== `reddit-${save.id}-images`) {
      reply({ ok: false, error: "invalid image folder" });
      return;
    }
    const cleanSaved = {};
    if (msg.saved && typeof msg.saved === "object") {
      for (const { n } of save.images) {
        const name = Object.hasOwn(msg.saved, n) ? msg.saved[n] : undefined;
        if (typeof name === "string" && /^\d{2,}\.(jpg|jpeg|png|gif|webp)$/.test(name)) {
          cleanSaved[n] = name;
        }
      }
    }
    const mdText = render(save.data, cleanSaved, msg.folderRel, save.notFetched);
    const mdUrl = URL.createObjectURL(new Blob([mdText], { type: "text/markdown" }));
    reply({ ok: true, mdUrl, mdName: `reddit-${save.id}.md` });
    return;
  }
  if (msg.type === "leket:reddit-save-done") {
    saves.delete(msg.token);
    reply({ ok: true });
    return;
  }
});
