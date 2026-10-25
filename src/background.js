// The toolbar button puts the collector's panel on the Discord tab; a Save there opens the
// export tab, which fetches the attachments and builds the zip.
const CONVERSATION = /^https:\/\/discord\.com\/channels\/(@me|\d+)\/\d+/;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !CONVERSATION.test(tab.url || "")) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "?" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Discord tools: open a DM or a channel on discord.com first, then click again" });
    return;
  }
  await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  // the bridge first: the collector looks for its mark when Save is pressed
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/bridge.js"] });
  // the page's own world: Discord's message objects live on its React elements, which a
  // content script's isolated world can't see
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/collector.js"], world: "MAIN" });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "discord-tools:ready" || !sender.tab) return;
  const q = new URLSearchParams({ tab: String(sender.tab.id), key: msg.key });
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/export.html?${q}`), index: sender.tab.index + 1 });
});
