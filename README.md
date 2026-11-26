# Leket

A Chrome extension that saves what you can see on a few sites, to files you keep:

- **Discord**: a DM, a server channel or a thread, with its attachments, as a zip (in parts when the save is large). Unzipped, it holds a page you can read offline, the attachments, and the full data as JSON.
- **Messenger**: a one-to-one conversation on messenger.com or facebook.com/messages, with its photos and videos, as a zip holding the messages as Markdown and JSON.
- **Etsy**: your conversations with shops or buyers, as one dated JSON.
- **Reddit**: a post with its comments, as Markdown, with its JSON alongside.
- **claude.ai**: your claude.ai/code sessions (export, rename, delete), and the files Claude delivered in your chats.
- **Replika**: your chats, diary and memories, with their pictures and voice clips, as one zip you can open offline.

Click its toolbar button on one of these sites and it offers what it can do there; anywhere else it lists them.

On Discord it reads only what Discord's own page loads while it scrolls back through the conversation. It doesn't log in as you, use a bot, or call Discord's API. That also means it saves only what your account can see. Messenger works the same way: it reads what the open conversation shows as it scrolls.

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

## Save a Messenger conversation

1. Open the conversation on [messenger.com](https://www.messenger.com) or [facebook.com/messages](https://www.facebook.com/messages) in Chrome. One-to-one conversations only for now: a group can be saved, but the panel warns that groups haven't been checked yet.
2. Click the **Leket** button in the toolbar, then **Save this conversation**. A small panel appears at the top right of the page.
3. Click **Start**. It jumps to the newest message, scrolls up to the start of the conversation, then back down, reading messages, photos and videos as they appear. Leave the tab alone while it runs. **Stop** ends it early; what was read so far is kept.
4. When the panel says **Done**, click **Save**. A new tab opens and saves the zip to your Downloads folder. Keep that tab open until it says it's done.

The photos are the ones the conversation shows. Whether those are always full size, or sometimes a smaller copy of a large photo, hasn't been checked yet.

When something goes wrong:

- **"No messages are showing"**: Messenger may be asking for your PIN to restore your chats. Enter it there (Leket never touches it), then click **Start** again.
- **"STALLED, not at the start"**: Messenger stopped loading older messages. Scroll up a little by hand, then click **Start** again. **Save** keeps what was read so far.
- **"Saved less than 10 seconds ago"**: wait a moment and click **Save** again.
- **"The extension didn't answer"**: the extension was updated or reloaded after you clicked its button. The messages were saved as a JSON file in Downloads, without the photos and videos. For those, reload the Messenger tab, click the button again and start again.
- **Photos or videos marked "not captured"**: the Markdown file says where each one was, and the JSON says why (one that never finished loading, or a video Messenger streams in a way that can't be read back).

What's in the zip:

| File | What it is |
|---|---|
| `messenger-<name>-<thread>.md` | The conversation, readable as plain text or in any Markdown viewer, with the photos inline |
| `messenger-<name>-<thread>.json` | Everything that was collected: each message's text, sender, time, replies, and its photos and videos |
| `messenger-media/` | The photos and videos, named `<date>_<message id>_<n>` |

## Save Etsy conversations

1. Sign in to [etsy.com](https://www.etsy.com) in Chrome and open any Etsy page — ideally the conversation you want, at `etsy.com/messages/<id>`.
2. Click the **Leket** button in the toolbar, then **Save conversations**. Leket's Etsy page opens in a new tab.
3. Put the conversation ids in the box, separated by commas or spaces. The Etsy notification emails carry them (the number in an `etsy.com/messages/<id>` link). If you opened Leket on a conversation, its id is already filled in, and an empty box falls back to it.
4. Click **Save conversations** and keep the tab open. It pages through each conversation with a short pause between pages, then saves `etsy-conversations-<date>.json` to your Downloads folder (the date is UTC, so it can be a day off from yours near midnight). Saving again on the same date replaces that file.

The JSON holds each conversation's messages as Etsy's own messages page receives them: both sides, the text, the time, who sent it, and links to any images (the images themselves aren't downloaded). A conversation that failed, came back empty (usually a mistyped id), or stopped at the 400-page cap is listed under the button. In the file, a failure carries an `error`, a capped one `truncated: true` and an empty one `empty: true`.

The file holds the messages exactly as Etsy sent them; Leket hides nothing in them. If a name needs hiding, whoever reads the file does that.

## Save a Reddit post

1. Open the post itself on [www.reddit.com](https://www.reddit.com) or [old.reddit.com](https://old.reddit.com) in Chrome (its address has `/comments/` in it).
2. Click the **Leket** button in the toolbar, then **Save this post as Markdown**. The popup stays open and says how it went; if you close it, the save still finishes.
3. `reddit-<post id>.md`, the post and its comments as readable Markdown, and `reddit-<post id>.json`, the data reddit sent, land in your Downloads folder, and any images on reddit's own image hosts download into `reddit-<post id>-images/` beside the `.md`, which links them. Saving the same post again replaces them. Chrome can't delete files, though: if a re-save names an image differently (`01.png` becoming `01.jpg`) or the post now has fewer images, the old files stay in the folder; the `.md` links only the current ones.

Images hosted elsewhere are tried too, over https only, never through a redirect, never from a local or private-network address and never from an address with a login in it, and never an SVG drawing (it can carry script, and saved as a picture it would open as nothing), and if one can't be fetched the `.md` links it where it's hosted. Leket fetches the comments in one request, as your logged-in browser sees them; on a big thread reddit leaves some out. The popup says how many, and the `.md` links to those threads on reddit. If Chrome is set to ask where to save each file, it asks for each image too.

## claude.ai sessions and chat outputs

These two pages are bulk tools for claude.ai. Their input lists come from scripts outside this repo, so they're mostly for whoever maintains the extension.

**Sessions** (on any claude.ai/code page, click the **Leket** button, then **Export sessions**, **Rename sessions** or **Delete sessions**; all three open Leket's Claude sessions page in a new tab, which has to stay open while it runs):

- **Export** fetches every active, paused and archived session and saves them to Downloads as `claude-sessions-<run>-partNN.jsonl` (about 150 MB each), then a `claude-sessions-<run>-done.json` marker. `<run>` is the UTC time of the run to the second, so two runs share file names only when they start in the same second, and then the later one's parts replace the earlier one's. Leave both boxes empty for a full export. The first box takes the list of sessions already archived, so only new or changed ones are fetched. The second box takes the resume line a failed run prints, so the next run picks up where that one stopped.
- **Rename** takes a list of `[session id, new title]` pairs and reads each rename back. At least one has to actually change a title: Leket does that one first and reads it back to prove renaming works, and refuses a list where nothing would change.
- **Delete** removes sessions whose title starts with the prefix you type. It can't be undone, so export first. **Dry run** lists and counts them; to delete, type that count into **Confirm count**. If the list has changed since the dry run, nothing is deleted. The first delete is read back before the rest run.

**Chat outputs** (on a claude.ai chat page, click the **Leket** button, then **Save chat outputs**): paste a list of `[chat id, name, source]` entries. Every file Claude delivered in those chats is saved into one `claude-chat-outputs-<date>.json`, text as text and everything else as base64 (the date is UTC, so it can be a day off from yours near midnight). Saving again on the same date replaces that file.

## Save Replika

1. Sign in to [my.replika.com](https://my.replika.com) in Chrome and let the chat load, then open any page there.
2. Click the **Leket** button in the toolbar, then **Save everything**. Leket's Replika page opens in a new tab.
3. Click **Save everything** there and keep the tab open. It reads the chat history over Replika's chat socket (paging backwards until the conversation's start), then the diary and the memories, then fetches each picture and voice clip one at a time with a short pause between files, and saves `replika-<date>-<time>.zip` to your Downloads folder. Each save gets its own file — saving again never replaces an earlier one.
4. Unzip the file and open `index.html`.

The zip holds the whole chat with both sides labelled by name, the diary entries and the memories (yours and the companion's), with pictures and voice clips inline. Where Replika changed a message after it was written, the text it had first is shown under it; the companion's emotion on a message and a diary entry's reaction show as small labels. A picture or voice clip that couldn't be fetched is listed in its message's place with the reason; so is one over 50 MB, which is skipped so a single huge file can't run the save out of memory. Anything Replika stopped halfway is said in words at the top of its section — what was read is saved either way. If Leket signed out (Replika answered 401/403), sign in at my.replika.com again and rerun: the new save lands beside the old one. Each kind of message field Leket didn't read is counted in the zip's `data.json` under `unsaved_fields`, so a future version can read more.

**Updating from before 0.6.0:** 0.6.0 added permission to fetch Replika's diary pictures from their Amazon S3 file hosts (`s3-us-west-1.amazonaws.com` and `luka-user-media.s3.us-west-1.amazonaws.com`). If Chrome turns Leket off after the update or asks about the new permission, accept it, or open `chrome://extensions` and switch Leket back on.

## From the command line

`bin/leket.js` runs saves from a shell, with no browser, and turns saves into readable Markdown.

### Discord saves to Markdown

```
node bin/leket.js convert discord <save>... [--out DIR] [--by none|year|month] [--tz ZONE] [--name USERNAME=LABEL]...
```

A save is Leket's Discord zip (for a save in parts, part 1, which holds the messages) or the `.json` inside it; several saves of the same conversation are merged by message id. It writes one Markdown transcript, or one per year or month (`--by`; a server channel defaults to month), with each day under its own heading and each message's replies, forwards and attachments shown in words. A server channel also gets a participants table (nicknames, roles, first and last message) and an index of its files. Times are shown in `--tz` (default: this computer's zone). `--name` shows an account under a label of your choosing, `--embeds` adds link previews' titles, and `--voice` adds machine transcripts of voice messages; `node bin/leket.js convert --help` lists every option.

### ChatGPT export to Markdown

```
node bin/leket.js convert chatgpt <export>... [--out DIR] [--user LABEL] [--assistant LABEL] [--tz ZONE] [--folders FILE] [--unlisted FOLDER]
```

An export is the zip ChatGPT's "Export data" emails you a link to (or the folder it unzips to), or the `conversations.json` in it. It writes one `YYYY-MM-DD Title.md` per conversation, following the branch you last had on screen (an edited prompt's older answers stay out), with each message under a `### User · time` heading and attached pictures named as `[image: name]`. System, tool and hidden messages are left out, and so are messages with no text (code the assistant ran, its reasoning): the summary line counts those. With several exports, a later one's copy of a conversation wins. `--user` and `--assistant` set the headings, `--tz` the zone (default UTC), and `--folders` (a tab-separated file with `id` and `folder` columns) sorts conversations into subfolders (`--unlisted` names the folder for the rest); `node bin/leket.js convert --help` lists every option.

### Gemini activity (Google Takeout) to Markdown

```
node bin/leket.js convert gemini <takeout>... [--out DIR] [--user LABEL] [--assistant LABEL] [--tz ZONE] [--folders FILE] [--unlisted FOLDER] [--titles FILE] [--other FOLDER]
```

A Takeout is the zip Google Takeout makes of "My Activity" with Gemini Apps chosen, in JSON (or the folder it unzips to), or the activity JSON file in it, whatever its language names it. Takeout keeps one row per prompt, with Gemini's replies as HTML and a link to the chat each belongs to. This rebuilds one `YYYY-MM-DD First words of the first prompt.md` per chat, with each prompt and reply under a `### User · time` heading, the replies turned into Markdown (no pandoc needed), drafts numbered, and the files and Gem each prompt used listed. A reply Takeout removed text from is marked. Rows that belong to no chat (Canvas documents, feedback, phone Assistant actions) go to `other-activity.md`, and each Canvas document's text to `canvases/`, both under `--other` (default: the output folder). Several Takeouts are merged, oldest first: the first one that has a row keeps its copy, so a newer Takeout made after chats were deleted loses nothing. `--titles` (a tab-separated file with `id` and `title` columns) gives chats the titles Takeout doesn't keep; `--folders` and `--unlisted` work as for ChatGPT; `--assistant` defaults to `Gemini`.

### Character-chat exports to Markdown

```
node bin/leket.js convert character-chat <export.json>... [--out DIR] [--user LABEL] [--site NAME] [--tz ZONE]
```

An export is one JSON file holding the `conversations` (each with its `messages`, `meta` and `character_id`) and the `characters`' cards that a character-chat site's console export gives. It writes one `.md` per conversation, named after its label (or `Character YYYY-MM-DD`), with each message under a `## Speaker · YYYY-MM-DD HH:MM` heading and a line saying how many messages were saved of the number the site counts. It also writes `INDEX.md` (every conversation, oldest first) and `CARDS.md` (each character's card as the site served it). Conversations with no messages are left out, and the summary counts them. With several exports, the copy of a conversation with the most messages wins. `--user` names your side when the conversation has no persona name, `--site` names the site in the headings (default `Character chat`), and `--tz` sets the zone (default UTC). Files from an earlier run that this one doesn't write are not deleted.

### Reddit posts

```
node bin/leket.js reddit --from-json reddit-<post id>.json [--out DIR] [--file PATH]
node bin/leket.js reddit <post-url> [--out DIR] [--file PATH]
```

It writes `reddit-<post id>.md`, the same Markdown the extension's Save writes, and saves an image post's picture or every gallery image into `reddit-<post id>-images/` beside it, under the same guards as the extension (https only, no redirects, no local or private-network address, no SVG). The CLI also checks where a host's name resolves: a name whose DNS answer is a local or private-network address is refused before any connection is made, which the extension can't do. An image that can't be saved stays linked where it's hosted, and the exit code is 3 instead of 0. A re-save replaces an earlier save's picture of the same number, even under another extension; one it can't fetch again is left in the folder (it may be the only copy), and stderr names it. One save fetches up to 100 images, 1 GB in all, and reads at most 64 MB of the post's JSON. `--file PATH` names the `.md` itself; `--file -` prints it and fetches no images. Reddit usually refuses a fetch from a script that isn't logged in (HTTP 403), so the usual path is to save the post with the extension and give its `reddit-<post id>.json` to `--from-json`. A post address (or a share link, which is resolved by its redirect) works when reddit allows it.

### YouTube videos

```
node bin/leket.js youtube https://youtu.be/<id> [--out DIR] [--lang CODE] [--max-comments N]
```

It writes `<title>-<video id>-transcript-comments.json` (the `youtube-extract/v1` schema) and a `.md` beside it, replacing an earlier save of the same video: the captions (a manual track in `--lang` if there is one, a regional one such as `en-US` next, else YouTube's automatic ones; default `en`) and every comment with its replies, sorted by likes. It needs a recent [yt-dlp](https://github.com/yt-dlp/yt-dlp), one that knows `--js-runtimes` (Leket says so when yours is older): set `LEKET_YTDLP` to its path, or have `yt-dlp` on your PATH, or have [uv](https://docs.astral.sh/uv/) installed, and Leket runs it with `uvx`. Captions and comments are fetched separately, so if YouTube refuses the captions (it rate-limits them per network), the comments are still saved and the exit code is 3 instead of 0; 3 also means yt-dlp stopped partway or only the `.json` could be written, and the notes say which. Exit 1 means nothing was saved. It takes one video's address (`watch?v=`, `youtu.be/`, `/shorts/`, `/live/`); a channel or playlist address is refused, since yt-dlp would walk every video in it. `npm link` (or a symlink to `bin/leket.js`) puts it on your PATH as `leket`.

## For developers

`npm test` runs the tests (Node 24, and `python3` for checking the zips). There are no dependencies.

`npm run smoke` loads the unpacked extension into a headless Chromium, opens the real popup and presses its buttons, one isolated scenario per module (a failure fails that module and the rest still run): a reddit save (twice: the second must overwrite, not add a renamed copy), and a reddit image save; a Discord save, from the bridge onward (the harness posts the collector's hand-off itself), whose zip's first try is cancelled so the export tab's retry click has to save it; two Messenger saves, one whose hand-off the harness posts itself (with a repeated photo name and a missing video the export tab must report) and one swept and saved by the real panel, with a photo and a video; a claude.ai sessions export whose download reports late; a claude.ai chat-outputs run, twice (the second must overwrite); and Etsy saves, four over one file, then two the harness makes Chrome refuse. Every page is synthetic and served by the harness; requests are intercepted, DNS resolves nothing and no proxy is used. It needs a Chromium that still loads unpacked extensions (branded Google Chrome no longer does). On Linux it finds a Playwright Chromium in `~/.cache/ms-playwright`, or in `PLAYWRIGHT_BROWSERS_PATH` when that is set (`npx playwright install chromium`). On other systems, or to pick a browser, set `LEKET_CHROME` to one. Without one it exits 2. `LEKET_SMOKE_KEEP=1` keeps the profile and downloads for a look. CI runs the smoke on every pull request, in the Chromium build pinned in `.github/workflows/ci.yml`. The unit tests stub `chrome.*`, so run the smoke locally too before pushing any change to `src/background.js`, the popup, an offscreen document, an export or download path, or a module's launch.

Layout:

- `src/popup/popup.html`, `src/popup/popup.js`: the toolbar popup. It detects what the active tab supports and renders that module's card.
- `src/popup/commands.js`: what each card's buttons do, one map per module; the tests pin every registered command to an implementation here.
- `src/modules/registry.js`: the supported sites, matched by URL, and each module's buttons.
- `src/background.js`: the service worker. It carries the Discord and Messenger launches (the popup hands the click over), opens the matching export tab when a collector's Save hands over, and runs the reddit save (it opens the offscreen document and downloads what that prepares).
- `src/modules/discord/`: the Discord module.
  - `launch.js`: its command — what the popup's button does.
  - `collector.js`: the panel. It runs in the page's own world, because Discord's message objects are on its React elements.
  - `bridge.js`: hands the collector's export from the page to the export tab, in pieces.
  - `export.html`, `export.js`: the export tab. With `src/lib/`, it fetches the attachments, writes `index.html` and builds the zip.
  - `convert.js`: saves to Markdown transcripts (pure), used by `leket convert discord`.
- `src/modules/messenger/`: the Messenger module.
  - `launch.js`: its command.
  - `read.js`: pure helpers (dates, message fields, file names, the Markdown), shared by the panel, the export tab and the tests.
  - `collector.js`: the panel. It runs in the page's own world, because Messenger's message objects are on its React elements, and it reads each photo and video's bytes there, since only that page can.
  - `bridge.js`: hands the collector's save, photos and videos included, from the page to the export tab, in pieces.
  - `export.html`, `export.js`, `media.js`: the export tab, which reads the pieces and builds the zip.
- `src/modules/reddit/`: the Reddit module.
  - `json.js`: its command; it hands the save to the worker.
  - `offscreen.html`, `offscreen.js`, `prepare.js`: the offscreen document, which fetches the post's JSON and images and renders the .md (again once the images are saved, so it links them), so the save outlives the popup.
  - `md.js`: the post-to-Markdown converter (pure).
  - `download.js`: the worker's half, which downloads the json, the post's images and the .md, overwriting an earlier save.
- `src/modules/etsy/`: the Etsy module. `page.html`, `page.js`: its page; `messages.js`: paging through each conversation (no extension APIs).
- `src/modules/claude-sessions/`: the claude.ai sessions module. `page.html`, `page.js`: its page; `listing.js`: lists every session; `export.js`, `save.js`, `narration.js`: the export, its downloads, and what the page says about the export, rename and delete; `rename.js`, `delete.js`: rename and delete, each read back.
- `src/modules/claude-chat/`: the claude.ai chat-outputs module. `page.html`, `page.js`: its page; `outputs.js`: lists and fetches each chat's delivered files (no extension APIs).
- `src/modules/replika/`: the Replika module. `page.html`, `page.js`: its page; `api.js`: the protocol — the sign-in probe injected into the tab, the REST walkers, the history pager and the signed media links (no extension APIs); `save.js`: the allowlisted record builders, the unknown-field tally, the readable page and the zip (no extension APIs).
- `src/modules/youtube/extract.js`: the `youtube-extract/v1` JSON and its Markdown (pure), used by the CLI.
- `bin/leket.js`: the command-line saves (see above).
- `src/convert/`: converters from other services' exports to Markdown (pure), for the CLI. `chatgpt.js`: `leket convert chatgpt`; `gemini.js`: `leket convert gemini`; `character-chat.js`: `leket convert character-chat`; `common.js`: their times, file names and folder checks.
- `src/lib/`: shared code. `build.js`, `files.js`, `render.js`, `zip.js`, `part.js`, `summary.js`: the Discord export (the attachments' names, the readable page, the zip, its parts and their retries); `unzip.js`: reads one entry out of a zip on disk, for the CLI; `download.js`: one download followed until it ends, used by the reddit, Etsy and claude.ai saves; `paste.js`: reads the paste boxes on the claude.ai pages; `html-md.js`: HTML to GitHub Markdown, for the Gemini converter.
- `test/fixtures/fake_page.cjs`: a fake Discord page the collector's tests run on. It mimics the shapes the collector expects; only a run on the real site shows they still match.
- `test/fixtures/messenger_page.cjs`: the same for Messenger.
- `test/smoke/smoke.mjs`: the smoke run (`npm run smoke`).
- `icons/`: the toolbar and extension icons. `source/logo.svg` draws the 48 and 128 px ones; `source/logo-16.svg` is a simplified version for 16 px, where the full one blurs. Regenerate with `rsvg-convert -w N -h N icons/source/logo.svg -o icons/iconN.png` (`logo-16.svg` for N = 16).

## License

MIT
