// The modules the popup can offer, one per supported site. matches() is a pure URL
// test so the registry runs anywhere (the popup, the tests); commands name the card's
// buttons, and the module's own directory implements what each one does
// (src/popup/popup.js maps a module id to its implementations).
export const MODULES = [
  {
    id: "discord",
    // a DM (@me), a server channel or a thread: /channels/<guild>/<channel>[/<thread>]
    matches: (url) => /^https:\/\/discord\.com\/channels\/(@me|\d+)\/\d+/.test(url),
    title: "Discord",
    blurb: "Save this DM, channel or thread, with its attachments, as one zip you can open offline.",
    commands: [{ id: "save", label: "Save this conversation" }],
  },
];

// the module whose tab this is, or null when the popup has nothing to offer
export function match(url) {
  return MODULES.find((m) => m.matches(url)) || null;
}
