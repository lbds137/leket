// The Discord module's launch: the popup hands the click over
// (src/modules/discord/launch.js) and the worker does the injecting — a popup dies when
// it loses focus, and a launch must finish once started. This is the old toolbar-click
// flow; the popup supersedes chrome.action.onClicked, which stops firing once the
// manifest has a default_popup.
const CONVERSATION = /^https:\/\/discord\.com\/channels\/(@me|\d+)\/\d+/;

// flags the toolbar icon on this tab alone: what happened, for when the popup is gone
const flag = async (tabId, text, title) => {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
  } catch { /* the tab is gone */ }
};

const launch = async (tabId) => {
  try {
    // the tab may have navigated since the popup matched it
    const tab = await chrome.tabs.get(tabId);
    if (!CONVERSATION.test(tab.url || "")) {
      return flag(tabId, "?", "Discord tools: open a DM or a channel on discord.com first, then click again");
    }
    // the bridge first: the collector looks for its mark when Save is pressed
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/modules/discord/bridge.js"] });
    // the page's own world: Discord's message objects live on its React elements, which
    // a content script's isolated world can't see
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/modules/discord/collector.js"], world: "MAIN" });
    await flag(tabId, "", "Discord tools: save this conversation");
    return { ok: true };
  } catch (e) {
    await flag(tabId, "!", `Discord tools couldn't start on this tab: ${(e && e.message) || e}. Reload the tab and try again.`);
    return { ok: false, error: (e && e.message) || String(e) };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // only this extension's own pages may launch. The gate is structural: with no
  // externally_connectable and no onMessageExternal listener, nothing foreign can ring
  // onMessage at all — the sender check just says so at the gate itself
  if (msg && msg.type === "discord-tools:launch" && typeof msg.tabId === "number" && sender.id === chrome.runtime.id) {
    launch(msg.tabId).then(reply);
    return true; // the answer comes after the injection
  }
  if (!msg || msg.type !== "discord-tools:ready" || !sender.tab) return;
  const q = new URLSearchParams({ tab: String(sender.tab.id), key: msg.key });
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/modules/discord/export.html?${q}`), index: sender.tab.index + 1, windowId: sender.tab.windowId })
    .then(() => reply({ ok: true }), () => reply({ ok: false }));
  // the answer comes after the tab is opened
  return true;
});
