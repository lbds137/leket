# Discord tools

A Chrome extension that saves a Discord conversation (a DM, a server channel or a thread) with its attachments as one zip. Unzipped, it holds a page you can read offline, the attachments, and the full data as JSON.

It reads only what Discord's own page loads while it scrolls back through the conversation. It doesn't log in as you, use a bot, or call Discord's API. That also means it saves only what your account can see.

## Install (once)

1. Download this folder and unzip it somewhere it can stay (Chrome loads the extension from it each time it starts, so don't delete it).
2. In Chrome, open `chrome://extensions`.
3. Switch on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder that holds `manifest.json`.
5. Optional: click the puzzle-piece icon in Chrome's toolbar and pin **Discord tools**, so its button is always visible.

Chrome may show a banner about developer-mode extensions when it starts. That's expected for an extension installed this way.

## Save a conversation

1. Open the conversation on [discord.com](https://discord.com/app) in Chrome (the desktop app won't work).
2. Click the **Discord tools** button in the toolbar. A small panel appears at the top right of the page.
3. Click **Auto-scroll**. It scrolls up through the conversation until it reaches the beginning. Leave the tab alone while it runs. For a busy server channel, type a date into **stop at** first (for example `2024-01-01`) to save only from that day on.
4. When the panel says it reached the start, click **Save**. A new tab opens and downloads the attachments, then saves the zip to your Downloads folder. Keep that tab open until it says it's done.
5. Unzip the file and open `index.html`.

If you only want the messages, untick **save attachments too** before clicking Save.

## When something goes wrong

- **"STALLED, not at the start"**: Discord stopped loading older messages. Scroll up a little by hand, then click Auto-scroll again.
- **"WOULD NOT OPEN"**: a group of messages from someone you blocked or ignored stayed closed. The panel says where it is. Scroll back there so it gets clicked again, then click Save again.
- **Attachments that couldn't be saved**: Discord's links to files expire after about a day. Reload the Discord tab, collect again and save again.
- **A save in several parts** (`…-part1-of-3.zip` and so on): very large saves are split. Unzip all the parts into the same folder, then open `index.html`.

## What's in the zip

| File | What it is |
|---|---|
| `index.html` | The conversation, readable in any browser, with images, video and audio inline |
| `discord-<name>-<channel>.json` | Everything that was collected: each message's text, author, time, replies, forwards, embeds, attachments; in a server, each person's server nickname and roles |
| `discord-attachments/` | The attachments, named `<date>_<message id>_<n>_<filename>` |
| `discord-attachments.json` | Which message each attachment belongs to, and any that failed |

## Without installing anything

`src/collector.js` also works on its own: paste its contents into Chrome's DevTools console (F12, Console tab) on an open conversation. Save then downloads the JSON alone, without attachments or the readable page.

## For developers

`npm test` runs the tests (Node 24, and `python3` for checking the zips). There are no dependencies. Layout:

- `src/background.js`: the toolbar button; it injects the bridge and the collector, and opens the export tab.
- `src/collector.js`: the panel. It runs in the page's own world, because Discord's message objects are on its React elements.
- `src/bridge.js`: hands the collector's export from the page to the export tab, in pieces.
- `src/export.html`, `src/export.js`, `src/lib/`: fetch the attachments, write `index.html`, and build the zip.
- `test/fixtures/fake_page.cjs`: a fake Discord page the collector's tests run on. It mimics the shapes the collector expects; only a run on the real site shows they still match.

## License

MIT
