// The popup's command implementations, one map per module id. Kept apart from popup.js
// (which touches the DOM) so the tests can pin every registry command to an
// implementation: test/registry.test.js walks MODULES against this map, and a module
// registered without its implementation is a red suite, not a silent button.
import { commands as discordCommands } from "../modules/discord/launch.js";
import { commands as redditCommands } from "../modules/reddit/json.js";

export const COMMANDS = { discord: discordCommands, reddit: redditCommands };
