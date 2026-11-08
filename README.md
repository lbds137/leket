# Leket

A Chrome extension that saves what you can see on a few sites, to files you keep:

- **Discord**: a DM, a server channel or a thread, with its attachments, as a zip (in parts when the save is large). Unzipped, it holds a page you can read offline, the attachments, and the full data as JSON.
- **Etsy**: your conversations with shops or buyers, as one dated JSON.
- **Reddit**: a post with its comments, as Markdown, with its JSON alongside.
- **claude.ai**: your claude.ai/code sessions (export, rename, delete), and the files Claude delivered in your chats.

Click its toolbar button on one of these sites and it offers what it can do there; anywhere else it lists them.

On Discord it reads only what Discord's own page loads while it scrolls back through the conversation. It doesn't log in as you, use a bot, or call Discord's API. That also means it saves only what your account can see.

## Install (once)

1. Download this folder and unzip it somewhere it can stay (Chrome loads the extension from it each time it starts, so don't delete it).
2. In Chrome, open `chrome://extensions`.
3. Switch on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder that holds `manifest.json`.
5. Optional: click the puzzle-piece icon in Chrome's toolbar and pin **Leket**, so its button is always visible.

Chrome may show a banner about developer-mode extensions when it starts. That's expected for an extension installed this way.

## Save a Discord conversation

1. Open the conversation on [discord.com](https://discord.com/app) in Chrome (the desktop app won't work).
2. Click the **Leket** button in the toolbar, then **Save this conversation**. A small panel appears at the top right of the page.
3. Click **Auto-scroll**. It scrolls up through the conversation until it reaches the beginning. It goes at a reader's pace on purpose — a few seconds per screenful of history, and a rest of under a minute every twenty or so — so a long conversation takes a while (about 5–8 minutes for 4,000 messages); Discord sees each screenful as a request from your account. Leave the tab alone while it runs. To stop at a date instead — a busy server channel, or one chunk of a very long conversation — type it into **stop at** first (for example `2024-01-01`), so it saves only from that day on. The panel also shows roughly how big the attachments are, before you commit.
4. When the panel says it reached the start, click **Save**. A new tab opens and saves the zip to your Downloads folder — a large save arrives in parts, downloaded one at a time. Attachments are fetched two at a time with a short pause between files, so a save with many of them takes a while. Keep that tab open until it says it's done.
5. Unzip the file and open `index.html`.

If you only want the messages, untick **save attachments too** before clicking Save.

**A conversation too big to save at once**: save it in chunks. Find where the last chunk stopped with a Discord search like `before:2024-01-01`, click **Jump** on one of the results, then click the Leket button and **Save this conversation**, type that same date into **start at**, and the date this chunk should reach back to into **stop at**, and auto-scroll. **Start at** clips nothing: it records the chunk's newest edge (`reached_until`), any messages on or after that date only overlap the previous chunk, and Save warns if the newest message is more than a day older than that date, because messages in between may be missing — click **Jump** on the newest search result and save again. Chunks may overlap slightly where they meet; the message ids in the JSON say what's what when merging them.

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

`src/modules/discord/collector.js` also works on its own: paste its contents into Chrome's DevTools console (F12, Console tab) on an open conversation. Save then downloads the JSON alone, without attachments or the readable page.

## Save Etsy conversations

1. Sign in to [etsy.com](https://www.etsy.com) in Chrome and open any Etsy page — ideally the conversation you want, at `etsy.com/messages/<id>`.
2. Click the **Leket** button in the toolbar, then **Save conversations**. Leket's Etsy page opens in a new tab.
3. Put the conversation ids in the box, separated by commas or spaces. The Etsy notification emails carry them (the number in an `etsy.com/messages/<id>` link). If you opened Leket on a conversation, its id is already filled in, and an empty box falls back to it.
4. Click **Save conversations** and keep the tab open. It pages through each conversation with a short pause between pages, then saves `etsy-conversations-<date>.json` to your Downloads folder (the date is UTC, so it can be a day off from yours near midnight). Saving again on the same date replaces that file — unless the new file fails Leket's own check that it reads back as JSON: then it is saved beside the old one, and the page says not to share it.

The JSON holds each conversation's messages as Etsy's own messages page receives them: both sides, the text, the time, who sent it, and links to any images (the images themselves aren't downloaded). A conversation that failed, came back empty (usually a mistyped id), or stopped at the 400-page cap is listed under the button. In the file, a failure carries an `error` and a capped one `truncated: true`; an empty one just has no messages.

### Hiding a name in the export (optional)

Leket can replace one person's name with `[redacted]` throughout the Etsy export: the full name, its short form, and the misspellings speech-to-text tends to make of them. An email address that contains either becomes `[email redacted]`. It's off until you set it up, and the page says which way it is on every save (**Redact: on**, or **Redact: off** and why). The `redact` field in the file records the same thing.

The name never goes into this repo. It lives in Chrome's storage for this extension, on your computer only. To set it:

1. Open Leket's Etsy page (step 2 above).
2. Right-click the page, choose **Inspect**, and open the **Console** tab. It has to be the console of this page: the extension's storage can't be reached from an etsy.com tab.
3. Paste this, with your own values, and press Enter:

   ```js
   chrome.storage.local.set({ etsyRedact: { name: "janedoe", short: "jane", firstSounds: "jgy" } })
   ```

   - `name`: the full name, lowercase letters a–z only, no spaces.
   - `short`: the short form, also lowercase a–z, starting with the same letter as `name`.
   - `firstSounds`: lowercase a–z letters a speech-to-text tool might hear in place of the first letter, starting with `name`'s own first letter (`"jgy"`: J, sometimes heard as G or Y).
4. Click **Save conversations**. The page should say **Redact: on.** If it says the config is invalid, check the three rules above.

If the page warns that the name also matches Etsy's own words or the file's field names, those words read `[redacted]` in the export too. That's expected, but the file's shape changes where a field name is hit. To turn redaction off again, run `chrome.storage.local.remove("etsyRedact")` in the same console.

## For developers

`npm test` runs the tests (Node 24, and `python3` for checking the zips). There are no dependencies.

`npm run smoke` loads the unpacked extension into a headless Chromium, opens the real popup and presses its buttons: a reddit save (twice: the second must overwrite, not add a renamed copy) and a Discord save, from the bridge onward (the harness posts the collector's hand-off itself), whose zip's first try is cancelled so the export tab's retry click has to save it. Every page is synthetic and served by the harness; requests are intercepted, DNS resolves nothing and no proxy is used. It needs a Chromium that still loads unpacked extensions (branded Google Chrome no longer does): it finds a Playwright Chromium in `~/.cache/ms-playwright` (`npx playwright install chromium`), or set `LEKET_CHROME` to one; without one it exits 2. `LEKET_SMOKE_KEEP=1` keeps the profile and downloads for a look. The unit tests stub `chrome.*`, so run the smoke too after any change to `src/background.js`, the popup, an offscreen document, an export or download path, or a module's launch.

Layout:

- `src/popup/popup.html`, `src/popup/popup.js`: the toolbar popup. It detects what the active tab supports and renders that module's card.
- `src/modules/registry.js`: the supported sites, matched by URL.
- `src/modules/discord/launch.js`: the Discord module's commands — what the popup's buttons do.
- `src/background.js`: the service worker. It carries the Discord module's launch (the popup hands the click over) and opens the export tab when the collector's Save hands over.
- `src/modules/discord/collector.js`: the panel. It runs in the page's own world, because Discord's message objects are on its React elements.
- `src/modules/discord/bridge.js`: hands the collector's export from the page to the export tab, in pieces.
- `src/modules/discord/export.html`, `src/modules/discord/export.js`, `src/lib/`: fetch the attachments, write `index.html`, and build the zip.
- `test/fixtures/fake_page.cjs`: a fake Discord page the collector's tests run on. It mimics the shapes the collector expects; only a run on the real site shows they still match.

## License

MIT
