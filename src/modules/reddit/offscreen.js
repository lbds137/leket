// The reddit module's offscreen document: fetches the post's json and prepares the
// blob when the worker asks, frees a settled blob when told, and answers with the
// result. It stays open — the next save reuses it, and closing it could kill a
// download still reading its blob. chrome.runtime is the only extension API here; the
// download itself belongs to the worker.
import { preparePostJson } from "./prepare.js";

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // the worker is the only caller that matters; mirror its sender line — a content
  // script's relay carries sender.tab, and websites cannot message the extension at all
  if (!msg || !sender || sender.tab || sender.id !== chrome.runtime.id) return;
  if (msg.type === "discord-tools:reddit-save-revoke" && typeof msg.url === "string") {
    URL.revokeObjectURL(msg.url);
    reply({ ok: true });
    return;
  }
  if (msg.type === "discord-tools:reddit-save-run" && typeof msg.tabUrl === "string") {
    preparePostJson(msg.tabUrl).then(
      ({ url, name, mdUrl, mdName }) => reply({ ok: true, url, name, mdUrl, mdName }),
      (e) => reply({ ok: false, error: (e && e.message) || String(e) }),
    );
    return true; // the answer comes after the fetch
  }
});
