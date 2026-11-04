// The Reddit module's command: what the popup's Save button does. It hands the save to
// the worker, which opens the module's offscreen document (src/modules/reddit/prepare.js
// runs there; the worker downloads) and relays the answer. `stay` keeps the popup open
// for the result; if it closes mid-save, the offscreen document still finishes — the
// file lands either way.
export const commands = {
  json: async (tab) => {
    const r = await chrome.runtime.sendMessage({ type: "discord-tools:reddit-save", tabUrl: tab.url });
    if (!r || !r.ok) throw new Error((r && r.error) || "The extension's save page didn't answer — try again; if it repeats, reload the extension.");
    return r.message;
  },
};
