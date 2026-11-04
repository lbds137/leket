// The toolbar button puts the collector's panel on the Discord tab; a Save there opens the
// export tab, which fetches the attachments and builds the zip.
const CONVERSATION = /^https:\/\/discord\.com\/channels\/(@me|\d+)\/\d+/;

const flag = async (tabId, text, title) => {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
  } catch { /* the tab is gone */ }
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (!CONVERSATION.test(tab.url || "")) {
    return flag(tab.id, "?", "Discord tools: open a DM or a channel on discord.com first, then click again");
  }
  try {
    // the bridge first: the collector looks for its mark when Save is pressed
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/modules/discord/bridge.js"] });
    // the page's own world: Discord's message objects live on its React elements, which a
    // content script's isolated world can't see
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/modules/discord/collector.js"], world: "MAIN" });
    await flag(tab.id, "", "Discord tools: save this conversation");
  } catch (e) {
    await flag(tab.id, "!", `Discord tools couldn't start on this tab: ${(e && e.message) || e}. Reload the tab and try again.`);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "discord-tools:ready" || !sender.tab) return;
  const q = new URLSearchParams({ tab: String(sender.tab.id), key: msg.key });
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/modules/discord/export.html?${q}`), index: sender.tab.index + 1, windowId: sender.tab.windowId })
    .then(() => reply({ ok: true }), () => reply({ ok: false }));
  // the answer comes after the tab is opened
  return true;
});
