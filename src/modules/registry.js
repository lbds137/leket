// The modules the popup can offer, one per supported site. matches() is a pure URL
// test so the registry runs anywhere (the popup, the tests); commands name the card's
// buttons, and the module's own directory implements what each one does
// (src/popup/popup.js maps a module id to its implementations).

// One anchored pattern for "the pathname of a reddit post page" builds both the reddit
// gate below and the save's id extraction (src/modules/reddit/prepare.js), so the id the
// fetch targets is always the id the gate saw — even when the subreddit or user is
// literally named "comments" (r/comments exists). The gate prepends the two hosts it
// covers; www and old are what the manifest lists and what the fetch targets (the tab's
// own origin) — other mirrors and share short links (/r/<sub>/s/<token>) redirect to a
// canonical post page before the popup looks, so they need no match of their own.
export const POST_PATHNAME = new RegExp(
  String.raw`^\/(?:(?:r|u|user)\/[^/]+\/)?comments\/([a-z0-9]+)`,
);
const REDDIT_POST_PAGE = new RegExp(
  String.raw`^https:\/\/(www|old)\.reddit\.com` + POST_PATHNAME.source.slice(1),
);

// One anchored pattern for "the pathname of a claude.ai/code page" gates the
// claude-sessions module: the pathname must START with /code and then end, or run on
// into / — the URL parser has already split ? and # off the pathname, so they never
// appear here. claude.ai/chat and the bare claude.ai host are other pages' territory,
// and /codeX is a different path altogether.
export const CODE_PATHNAME = new RegExp(String.raw`^\/code(?=$|\/)`);

export const MODULES = [
  {
    id: "discord",
    // a DM (@me), a server channel or a thread: /channels/<guild>/<channel>[/<thread>].
    // A worker-run command lives in three places: here, src/popup/commands.js (via the
    // module's launch.js), and the command check in src/background.js launch() —
    // test/registry.test.js pins only the first two.
    matches: (url) => /^https:\/\/discord\.com\/channels\/(@me|\d+)\/\d+/.test(url),
    title: "Discord",
    blurb: "Save this DM, channel or thread, with its attachments, as one zip you can open offline.",
    commands: [{ id: "save", label: "Save this conversation" }],
  },
  {
    id: "reddit",
    // a post page, per REDDIT_POST_PAGE above. The command is `stay`: the popup keeps
    // the card open to show what came of it, while the save itself runs in the module's
    // offscreen document (src/modules/reddit/prepare.js fetches there; the worker
    // downloads) — a page outlives the popup, so closing it mid-save kills nothing.
    matches: (url) => REDDIT_POST_PAGE.test(url),
    title: "Reddit",
    blurb: "Save this post — comments included — as a Markdown file, with its JSON alongside.",
    commands: [{ id: "json", label: "Save this post as Markdown", stay: true }],
  },
  {
    id: "claude-sessions",
    // a claude.ai/code page, per CODE_PATHNAME above. Both commands open the module's
    // own page (src/modules/claude-sessions/page.html): a rename or a delete is a long,
    // reviewable run, and a popup dies when it loses focus. The page's own fetches carry
    // the login (credentials: include) against the manifest's claude.ai host permission.
    matches: (url) => {
      try {
        const u = new URL(url);
        return u.hostname === "claude.ai" && CODE_PATHNAME.test(u.pathname);
      } catch {
        return false;
      }
    },
    title: "Claude sessions",
    blurb: "Rename or delete your claude.ai/code sessions — read-back verified, one run at a time.",
    commands: [{ id: "rename", label: "Rename sessions" }, { id: "delete", label: "Delete sessions" }],
  },
];

// the module whose tab this is, or null when the popup has nothing to offer
export function match(url) {
  return MODULES.find((m) => m.matches(url)) || null;
}
