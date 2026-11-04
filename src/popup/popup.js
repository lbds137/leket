// The toolbar popup: detects what the active tab supports, renders that module's card,
// and hands the click to the module's command. A popup closes the moment it loses
// focus, so nothing long runs in here — a one-shot command may, and anything longer
// opens the module's own page beside the tab. No match: the list of what this
// extension supports.
import { MODULES, match } from "../modules/registry.js";
import { COMMANDS } from "./commands.js";

const card = document.getElementById("card");

// the module decides what a command does; the popup only shows what came of it.
// One status line per card, reused — errors don't stack — and the button sleeps
// while its launch is in flight
const run = async (module, command, tab, button, show) => {
  const handler = COMMANDS[module.id] && COMMANDS[module.id][command.id];
  if (!handler) {
    show(`${module.title}: this command has no implementation yet — that is a bug in the extension.`, true);
    return;
  }
  button.disabled = true;
  try {
    show("Working…");
    await handler(tab);
    window.close(); // launched: the collector's panel is on the tab now
  } catch (e) {
    show(`Couldn't start: ${(e && e.message) || e}`, true);
    button.disabled = false;
  }
};

const renderSupported = () => {
  const h = document.createElement("h1");
  h.textContent = "Supported sites";
  const p = document.createElement("p");
  p.className = "blurb";
  p.textContent = "Open one of these, then click the toolbar button again.";
  const ul = document.createElement("ul");
  for (const m of MODULES) {
    const li = document.createElement("li");
    const b = document.createElement("strong");
    b.textContent = m.title;
    li.appendChild(b);
    li.append(` — ${m.blurb}`);
    ul.appendChild(li);
  }
  card.replaceChildren(h, p, ul);
};

const renderCard = (module, tab) => {
  const h = document.createElement("h1");
  h.textContent = module.title;
  const p = document.createElement("p");
  p.className = "blurb";
  p.textContent = module.blurb;
  const bar = document.createElement("div");
  const line = document.createElement("p");
  line.hidden = true;
  const show = (text, warn = false) => {
    line.textContent = text;
    line.className = warn ? "warn" : "blurb";
    line.hidden = false;
  };
  for (const command of module.commands) {
    const button = document.createElement("button");
    button.textContent = command.label;
    button.addEventListener("click", () => run(module, command, tab, button, show));
    bar.appendChild(button);
  }
  card.replaceChildren(h, p, bar, line);
};

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const module = tab && tab.url ? match(tab.url) : null;
    if (!module) return renderSupported();
    renderCard(module, tab);
  } catch (e) {
    const err = document.createElement("p");
    err.className = "warn";
    err.textContent = `Couldn't read this tab: ${(e && e.message) || e}`;
    card.replaceChildren(err);
  }
})();
