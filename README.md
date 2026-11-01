# Discord tools

A Chrome extension that saves a Discord conversation (a DM, a server channel or a thread) with its attachments as a zip (in parts when the save is large). Unzipped, it holds a page you can read offline, the attachments, and the full data as JSON.

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
3. Click **Auto-scroll**. It scrolls up through the conversation until it reaches the beginning. Leave the tab alone while it runs. To stop at a date instead — a busy server channel, or one chunk of a very long conversation — type it into **stop at** first (for example `2024-01-01`), so it saves only from that day on. The panel also shows roughly how big the attachments are, before you commit.
4. When the panel says it reached the start, click **Save**. A new tab opens and saves the zip to your Downloads folder — a large save arrives in parts, downloaded one at a time. Keep that tab open until it says it's done.
5. Unzip the file and open `index.html`.

If you only want the messages, untick **save attachments too** before clicking Save.

**A conversation too big to save at once**: save it in chunks. Find where the last chunk stopped with a Discord search like `before:2024-01-01`, click **Jump** on one of the results, then click the Discord tools button, type that same date into **start at**, and the date this chunk should reach back to into **stop at**, and auto-scroll. **Start at** clips nothing: it records the chunk's newest edge (`reached_until`), any messages on or after that date only overlap the previous chunk, and Save warns if the newest message is more than a day older than that date, because messages in between may be missing — click **Jump** on the newest search result and save again. Chunks may overlap slightly where they meet; the message ids in the JSON say what's what when merging them.

## When something goes wrong

- **"STALLED, not at the start"**: Discord stopped loading older messages. Scroll up a little by hand, then click Auto-scroll again.
- **"WOULD NOT OPEN"**: a group of messages from someone you blocked or ignored stayed closed. The panel says where it is. Scroll back there so it gets clicked again, then click Save again.
- **"The extension didn't answer"**: the extension was updated or reloaded after you clicked its button. Your messages were still saved, as a JSON file in Downloads. For the attachments and the readable page, reload the Discord tab, click the button again and collect again.
- **Attachments that couldn't be saved**: Discord's links to files expire after about a day. Reload the Discord tab, collect again and save again.
- **A save in several parts** (`…-part1.zip`, `…-part2.zip` and so on): a large save is split, and the first part holds the readable page and the data, so it arrives even if the rest don't. Unzip all the parts into the same folder, then open `index.html`. A part that didn't finish shows a "click to try again" link in the export tab. Which attachments couldn't be fetched is listed in `discord-attachments.json` — in a streamed save it is the small part at the end. (Rarely the parts come named `…-part1-of-2.zip` instead, when a save splits without streaming: same drill.)
- **"This save is about … and this page's browser storage reports only about … available"**: the attachments may not all fit. That number is the page's storage quota, which isn't exactly the free space on your disk. Parts download one at a time, so the ones already saved are safe: free up space, then click the part that didn't finish.

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
