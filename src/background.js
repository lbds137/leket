// The Discord module's launch: the popup hands the click over
// (src/modules/discord/launch.js) and the worker does the injecting — a popup dies when
// it loses focus, and a launch must finish once started. A module worker, so the
// conversation test comes from the registry (src/modules/registry.js): one copy, not
// two that can drift.
import { match } from "./modules/registry.js";
import { downloadPrepared } from "./modules/reddit/download.js";
import { SAVE_PAGE_SILENT } from "./modules/reddit/json.js";

// flags the toolbar icon on this tab alone: what happened, for when the popup is gone
const flag = async (tabId, text, title) => {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
  } catch { /* the tab is gone */ }
};

const launch = async (tabId, command) => {
  // a command the popup may render but the worker does not carry yet is refused, not
  // run as save (a second Discord command dispatches here)
  if (command !== "save") {
    return { ok: false, error: `The worker has no "${command}" command.` };
  }
  try {
    // the tab may have navigated since the popup matched it
    const tab = await chrome.tabs.get(tabId);
    if (match(tab.url || "")?.id !== "discord") {
      await flag(tabId, "?", "Leket: open a DM or a channel on discord.com first, then click again");
      return { ok: false, error: "This tab is no longer a Discord conversation — open a DM or a channel and click again." };
    }
    // the bridge first: the collector looks for its mark when Save is pressed
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/modules/discord/bridge.js"] });
    // the page's own world: Discord's message objects live on its React elements, which
    // a content script's isolated world can't see
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/modules/discord/collector.js"], world: "MAIN" });
    await flag(tabId, "", "Leket: save this conversation");
    return { ok: true };
  } catch (e) {
    await flag(tabId, "!", `Leket couldn't start on this tab: ${(e && e.message) || e}. Reload the tab and try again.`);
    return { ok: false, error: (e && e.message) || String(e) };
  }
};

// The reddit save: the offscreen document fetches and prepares the blob (chrome.runtime
// is the only extension API it gets), and THIS worker downloads it — chrome.downloads
// lives here, the document's blob URL is same-origin, and download events keep the
// worker alive for the length of the save. A popup closing mid-save costs only the
// result line, never the file.
const OFFSCREEN_PATH = "src/modules/reddit/offscreen.html";
// Whether the offscreen document is open, the way the offscreen reference page
// (developer.chrome.com, "Maintain the lifecycle" and "Before Chrome 116") does it:
// runtime.getContexts from Chrome 116, the worker's clients below that. Not
// offscreen.hasDocument: the page lists it as Chrome 150+, past the 109 floor.
const offscreenOpen = async () => {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length > 0;
  }
  return (await self.clients.matchAll()).some((c) => c.url === url);
};
let creatingOffscreen = null;
const ensureOffscreen = async () => {
  // an in-flight creation is awaited before anything else: the check can report the
  // document while its listener is not registered yet, and relaying into that gap is
  // a "receiving end does not exist" refusal
  if (creatingOffscreen) return creatingOffscreen;
  if (await offscreenOpen()) return;
  // two saves racing both see no document: the second waits on this same
  // creation instead of making a second document (Chrome allows only one)
  creatingOffscreen ||= chrome.offscreen.createDocument({
    url: chrome.runtime.getURL(OFFSCREEN_PATH),
    reasons: ["BLOBS"],
    justification: "Fetch the open reddit post's JSON, render it as Markdown, and download both; the save must outlive the popup.",
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
};

const redditSave = async (tabUrl) => {
  // the popup matched this url and the save targets the post it saw; this re-check
  // keeps a malformed or foreign payload from drawing a fetch, not a navigation check
  if (match(tabUrl || "")?.id !== "reddit") {
    return { ok: false, error: "This tab is no longer a reddit post page — open the post and click again." };
  }
  await ensureOffscreen();
  // a broadcast: every extension page gets it, and today only the offscreen document
  // answers a reddit-save-run. No other page may grow a listener that replies to it —
  // the worker would read that reply as the save's result.
  const prep = await chrome.runtime.sendMessage({ type: "leket:reddit-save-run", tabUrl });
  if (!prep || !prep.ok) {
    return { ok: false, error: (prep && prep.error) || SAVE_PAGE_SILENT };
  }
  const done = await downloadPrepared(chrome.downloads, [
    { url: prep.url, name: prep.name },
    { url: prep.mdUrl, name: prep.mdName },
  ], {
    notFetched: prep.notFetched,
    onSettled: (file) => chrome.runtime.sendMessage({ type: "leket:reddit-save-revoke", url: file.url }).catch(() => {}),
  });
  return { ok: true, message: done.message };
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // only this extension's own extension pages may launch: sender.id also passes for our
  // own content scripts, so !sender.tab is the line. Websites cannot message the
  // extension at all — no externally_connectable, and no onMessageExternal listener.
  if (msg && msg.type === "leket:launch" && typeof msg.tabId === "number"
      && !sender.tab && sender.id === chrome.runtime.id) {
    launch(msg.tabId, msg.command).then(reply);
    return true; // the answer comes after the injection
  }
  if (msg && msg.type === "leket:reddit-save" && typeof msg.tabUrl === "string"
      && !sender.tab && sender.id === chrome.runtime.id) {
    redditSave(msg.tabUrl).then(reply, (e) => reply({ ok: false, error: (e && e.message) || String(e) }));
    return true; // the answer comes after the save
  }
  if (!msg || msg.type !== "leket:ready" || !sender.tab) return;
  const q = new URLSearchParams({ tab: String(sender.tab.id), key: msg.key });
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/modules/discord/export.html?${q}`), index: sender.tab.index + 1, windowId: sender.tab.windowId })
    .then(() => reply({ ok: true }), () => reply({ ok: false }));
  // the answer comes after the tab is opened
  return true;
});
