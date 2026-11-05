// The popup's command implementations, one map per module id. Kept apart from popup.js
// (which touches the DOM) so the tests can pin every registry command to an
// implementation: test/registry.test.js walks MODULES against this map, and a module
// registered without its implementation is a red suite, not a silent button.
import { commands as discordCommands } from "../modules/discord/launch.js";
import { commands as redditCommands } from "../modules/reddit/json.js";

// The claude-sessions commands need no relay at all: the module's page is self-
// sufficient (its own fetches carry the login), and a long run needs the tab anyway —
// a popup dies when it loses focus. chrome is touched only INSIDE the handler, so the
// import stays pure for the node tests; the tabs stand-in is the seam they inject
// through. The popup closes itself once the handler settles — before it could ever
// show the returned string — so that string exists only for the tests, which pin it.
const openSessionsPage = (hash) => async (tab, { tabs = chrome.tabs } = {}) => {
  await tabs.create({ url: chrome.runtime.getURL("src/modules/claude-sessions/page.html") + hash });
  return "Opened the sessions page.";
};

// Like the sessions commands the page is self-sufficient, but its probe reads the
// claude.ai tab the popup matched (readOrgPath runs there via chrome.scripting), so
// the open carries that tab's id as a query. Tabless calls (the tests) open the page
// bare — it refuses to run without a tab id.
const openChatOutputsPage = async (tab, { tabs = chrome.tabs } = {}) => {
  const page = chrome.runtime.getURL("src/modules/claude-chat/page.html");
  const url = tab && tab.id != null ? `${page}?tab=${tab.id}` : page;
  await tabs.create({ url });
  return "Opened the chat outputs page.";
};

export const COMMANDS = {
  discord: discordCommands,
  reddit: redditCommands,
  "claude-sessions": {
    export: openSessionsPage("#export"),
    rename: openSessionsPage("#rename"),
    delete: openSessionsPage("#delete"),
  },
  "claude-chat": {
    outputs: openChatOutputsPage,
  },
};
