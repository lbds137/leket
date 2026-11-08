// The Reddit module's command: what the popup's Save button does. It hands the save to
// the worker, which opens the module's offscreen document (src/modules/reddit/prepare.js
// runs there; the worker downloads) and relays the answer. `stay` keeps the popup open
// for the result; if it closes mid-save, the offscreen document still finishes — the
// file lands either way.
// One text for "the save page went silent", used by the worker's relay and the popup's
// own fallback — one copy, so they cannot drift.
export const SAVE_PAGE_SILENT = "The extension's save page didn't answer — try again; if it repeats, reload the extension.";

export const commands = {
  json: async (tab) => {
    const r = await chrome.runtime.sendMessage({ type: "leket:reddit-save", tabUrl: tab.url });
    if (!r || !r.ok) throw new Error((r && r.error) || SAVE_PAGE_SILENT);
    return r.message;
  },
};
