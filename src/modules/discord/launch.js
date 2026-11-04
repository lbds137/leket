// The Discord module's commands: what the popup's buttons do. The injection itself
// lives in the service worker (src/background.js): a popup dies when it loses focus,
// and a launch must finish once started — the worker carries it, and the badge flags
// report what came of it when the popup is already gone.

export const commands = {
  save: async (tab) => {
    const r = await chrome.runtime.sendMessage({ type: "discord-tools:launch", command: "save", tabId: tab.id });
    if (!r || !r.ok) throw new Error((r && r.error) || "The extension's worker didn't answer — reload the page and try again.");
  },
};
