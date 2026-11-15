# Messenger module: build spec (v1)

Approved 2026-11-15 by the owner. Scope: save one Messenger one-to-one thread, opened on
www.facebook.com/messages or www.messenger.com, as a zip holding its messages (JSON and Markdown)
and its photos and videos (owner 11-15: videos too). Every platform fact below comes from read-only probes of live threads on
2026-11-15 (Hebrew locale, Chrome). Nothing from those threads is in this repo, and nothing
may be: fixtures are synthetic.

## Premise ledger

Each line says what was observed, and where, or marks the claim as inferred.

- **Hosts and paths** (observed): a thread opens at `www.messenger.com/e2ee/t/<digits>`,
  `www.messenger.com/t/<digits>` (a non-encrypted thread, seen on a group), the same with a
  trailing `/`, and `www.facebook.com/messages/e2ee/t/<digits>`. `www.facebook.com/messages/t/<digits>`
  is inferred from the scope notes and was not seen on 11-15.
- **Rows** (observed on both hosts, e2ee and plain): each message is a `div[data-message-id]`
  with `data-scope="messages_table"`. Walking `__reactFiber$…` up through `.return` reaches a
  fiber whose `memoizedProps.message` is an object. That was at depth 24 on every row seen;
  match it by `message.messageId === row.dataset.messageId`, not by depth (15/15 rows matched).
- **Message fields** (observed): `messageId` (string), `timestampMs` and `senderId` (each
  `[high, low]`, two numbers: a 64-bit integer split into words), `text` (string, or undefined
  for a media-only row), `isUnsent`, `editCount`, `replySnippet` / `replyMessageText` /
  `replyToUserId` (e2ee rows), `displayedContentTypes` (`[0, bits]`). The e2ee object has 54
  keys and the plain one 26.
- **Time decode** (observed): `high * 2^32 + (low >>> 0)` as epoch ms matched the row's own
  aria-label date and HH:MM on 15/15 rows. No negative low word was seen. `>>> 0` stays
  anyway, and a unit test pins it.
- **Sender name** (observed): walk further up the same fiber chain to depth ~56, where a
  `memoizedProps.value.contact` object has a `name` string. It differs per sender: three
  senders, three distinct names, each constant across that sender's rows. The contact object
  has no id field, so key names by the row's `senderId`. Nearby props carry `outgoing`
  (boolean, true for the viewer's own rows) and `isGroupThread`.
- **Content-type bits** (observed counts across 12 threads; meanings inferred from what
  rendered): `1` text; `2` media: on messenger.com e2ee threads a photo row holds one or more
  `<img>` whose `src` is a `data:image/jpeg;base64,…` URL (natural sizes seen 540x720 up to
  946x2049; whether that is the full-size photo or a preview capped near 720 px is NOT
  checked: compare with the media viewer before unit C), and a video row holds a `<video>`
  with a `blob:` src. Photos on facebook.com and on plain threads are unverified; `1024` link-preview card (has an
  `a[href^="http"]`; its thumbnail is a `blob:` img); `1032`/`1033` share or preview
  variants (fbcdn https imgs, links); `16384` sticker-like (one `blob:` img 220x259, no
  link); `4`, `4096`, `536870912` (2^29) unknown (no image, no link).
- **Photo bytes** (observed): `data:` URLs carry the bytes in the DOM itself. A `blob:` URL
  is readable by `fetch()` from the page (28,315 bytes, image/jpeg), and the export tab
  cannot read it. A photo `<img>` can be empty for a moment after mount, so read only
  once `img.complete && img.naturalWidth > 0`.
- **Filter out** (observed): avatars are https fbcdn imgs at 100x100 natural size, read
  receipts 16x16 or 12x12, and reaction emoji are `<img alt="<emoji>">` at small sizes.
- **Scroller** (observed): the tallest element under `[role="main"]` whose computed
  `overflow-y` is auto or scroll and whose `scrollHeight > clientHeight + 50`.
- **Top of thread** (observed): at the top, the thread's profile header is mounted above
  the first row, with a 60x60 img that precedes the first `div[data-message-id]` inside the
  scroller. No progressbar is present there.
- **Sweep repeatability** (observed): two full sweeps (up in steps of 85% of clientHeight,
  900 ms apart, then back down) on one 1:1 e2ee thread gave 55 distinct ids both times. The
  earlier 49 on facebook.com came from a partial run.
- **PIN** (observed once, not re-triggerable): a host without the e2ee keys shows a 6-digit
  "enter PIN to restore chats" dialog before any rows load. No selector was recorded.
- **Groups** (observed): plain group threads use the same row shape. Out of scope for v1.
- **Path is not encryption** (observed): an e2ee thread once showed as `/t/<id>/` in the
  address bar, so the path form says nothing about encryption. Use `isSecureMessage` if
  that is ever needed.
- **Video bytes**: NOT read. The probe saw `<video>` elements with `blob:` srcs and finite
  durations (13–37 s) but did not fetch one. If the blob URL is a MediaSource, `fetch` fails,
  and the collector must report that rather than hide it. Check during unit C's live check.
- **messageId character set**: NOT read (the probe tool masked the values). Treat it as an
  arbitrary string everywhere it reaches a file name.

## Data shape

Units A, B and C all use this one shape. The export JSON:

```
{ leket: "messenger", version: 1, host, thread_id, url, title, saved_at (ISO), time_zone,
  count, senders: { "<sender_id>": "<name>" }, group_warning: bool,
  media_not_captured: [{ message_id, reason }],
  messages: [Message] }            // sorted by time, then id
Message = { id, time (ISO|null), sender_id (string|null), sender (string|null),
  outgoing (bool|null), text (string|null), unsent (bool), edited (bool),
  reply_to: { text } | null, kinds: [string],   // per contentKinds, plus "video" when seen
  link: string|null, media: [Media] }
Media = { file, kind: "photo"|"video", mime, width, height, bytes, duration_s }      // file = name inside messenger-media/
```

`normalize()` returns a Message with `link: null` and `media: []`. The collector fills
those two fields, and `renderMarkdown` reads them.

## Units

Four units, in this order. Each one is reviewed and merged on its own, with `npm test`
green, and `npm run smoke` green for units B and D.

### A. Pure helpers: `src/modules/messenger/read.js`

A classic script, with no `import` or `export`. It is injected into the page before
`collector.js`, and the tests `require` it through `vm`. It defines
`globalThis.LeketMessengerRead = { … }` and, when `module` exists, sets `module.exports` too.

- `i64([high, low])` → BigInt `(BigInt(high) << 32n) + BigInt(low >>> 0)`. A string or
  number input passes through `BigInt(x)`. Anything else returns null.
- `toIso(ts)` → the ISO string of `Number(i64(ts))`, or null.
- `contentKinds(bits)` → a list drawn from `text` (1), `media` (2), `link` (1024),
  `sticker` (16384) and `other:<bit>` for every other set bit. It takes `[0, n]` or `n`.
- `normalize(message, senderName, outgoing)` → a Message (see Data shape). `sender_id` is `i64(senderId).toString()`. `reply_to` is
  `{ text: replyMessageText ?? replySnippet ?? null }`, or null when neither field exists.
- `renderMarkdown(exp)` → one Markdown document: a title line, then a meta line with the
  host, thread id, message count, first and last date, and save time. After that, each
  day gets a `## YYYY-MM-DD` heading (in the page's time zone, passed in), and each message
  is `**<sender>** HH:MM` followed by its text, with `> ` for a reply's quoted text.
  Each saved photo is `![photo](messenger-media/<file>)` and each saved video
  `[video, <duration> s](messenger-media/<file>)`. Content that isn't saved gets a
  bracketed note: `[photo, not captured]`, `[video, not captured]`, `[sticker]`, `[link preview: <href>]` and
  `[unsent]`. Escape Markdown only where it breaks structure, meaning a line starting with
  `#`, `>` or `-`.
- `safePart(s, max)` → `s` with every character outside `[\p{L}\p{N}._-]` replaced by `_`,
  runs of `_` collapsed, leading dots stripped, and cut to `max` characters (default 40);
  `"x"` if that leaves it empty. `mediaName(day, messageId, n, mime)` →
  `<day>_<safePart(messageId)>_<n>.<jpg|png|webp|gif|mp4|webm|mov|bin>` (by MIME type). Uniqueness comes from the
  collector, not the name: it appends `-2`, `-3` and so on when a name is already taken.

Tests (`test/messenger-read.test.js`, synthetic only): `i64` on `[0, 1]`, on a negative low
word (`[1, -1]` → 2^33 − 1), and on a real-shaped ms pair built from `Date.UTC`; `toIso`
round trip; `contentKinds` for 1, 2, 1024, 16384 and 1|4096; `safePart`/`mediaName` on an id
holding `/`, `$`, `=`, `..` and a leading dot; `normalize` on an e2ee-shaped
and a plain-shaped object; `renderMarkdown` day split across midnight in a non-UTC zone,
the photo link, the placeholders, and line-start escaping.

### B. Wiring

- `src/modules/registry.js`: a `messenger` module. `matches` parses the URL. The host must be
  `www.messenger.com` with a pathname matching `^/(e2ee/)?t/\d+/?$`, or `www.facebook.com`
  with `^/messages/(e2ee/)?t/\d+/?$`. Export the pathname pattern, as `CODE_PATHNAME` is.
  Title "Messenger"; blurb "Save this conversation, with its photos and videos, as one zip.";
  command `{ id: "save", label: "Save this conversation" }`.
  `test/registry.test.js`: matches all six URL forms, and refuses `/t/` with no id,
  `messenger.com` without www, `m.facebook.com`, `facebook.com/messages/` bare, and
  `/e2ee/t/abc`.
- `manifest.json`: add `https://www.messenger.com/*` and `https://www.facebook.com/*` to
  `host_permissions`. Add no CDN hosts, because nothing is fetched from them. Update the
  description to name Messenger.
- `src/modules/messenger/launch.js`: the same shape as the Discord one, sending
  `{ type: "leket:launch", command: "save", tabId }` with no module field.
  `src/popup/commands.js` maps `messenger` to it.
- `src/background.js` `launch()`: a table keyed by module id, where the module comes from
  `match(tab.url).id` alone. `discord.save` injects
  `discord/bridge.js` (isolated) and `discord/collector.js` (MAIN). `messenger.save`
  injects `messenger/bridge.js` (isolated), then `messenger/read.js` and
  `messenger/collector.js` (both MAIN). A tab that matches no module in the table runs the
  existing refusal and badge path, with wording that names both supported sites.
  An unknown command is still refused. Update the registry comment that names the three
  places a worker command lives.
- `src/modules/messenger/bridge.js`: a new file. It leaves the Discord bridge untouched,
  because the Discord flow is mirrored and battle-tested. It differs in one way: the
  collector posts `{ type: "leket:messenger-export", id, file, json, files: [{ name, blob }] }`.
  Blobs survive `window.postMessage` structured cloning. The bridge holds the JSON string
  in 8 MiB string chunks, as Discord's does, and each file as its Blob. It answers
  `leket:chunk` as Discord's does, and adds `leket:file` `{ index, offset }`, which returns
  `{ name, size, data }`: `data` is base64 of up to 6 MiB from `offset`, read with
  `blob.slice().arrayBuffer()`. It announces with `{ type: "leket:ready", key }`.
  It keeps only the latest save (`KEEP = 1`): media is large.
- `src/background.js` `leket:ready` handler: choose the export page from
  `match(sender.tab.url)?.id`. `discord` opens `discord/export.html`, `messenger` opens
  `messenger/export.html`, and anything else gets `{ ok: false }`. The message shape stays
  the same, so `discord/collector.js` and `discord/bridge.js` don't change, and there is no
  diff to mirror.
- `src/modules/messenger/export.html` + `export.js`: `export.html` loads `../messenger/read.js`
  with a plain `<script>` before the `export.js` module, and `export.js` uses
  `globalThis.LeketMessengerRead`. Re-validate the posted `file` against
  `^messenger-[\p{L}\p{N}._-]{1,60}-\d{1,25}\.json$` (else `messenger-export.json`). Check
  each media file name against `^[\p{L}\p{N}._-]{1,120}$`, with no leading dot; a file that
  fails is skipped and listed as not captured. Read the JSON through `leket:chunk`,
  then each file through `leket:file` until `offset >= size`, decoding base64 into
  Uint8Arrays. Write a `ZipWriter` (default part limit) holding
  `messenger-<name>-<thread>.json`, `messenger-<name>-<thread>.md` (from `renderMarkdown`)
  and `messenger-media/<file>`. Download it with `createPartDownload` exactly as the
  Discord export tab does, with the same retry-by-click link. On release, send
  `leket:release`. The page states the counts: messages, photos and videos saved, and
  media seen but not captured. Media is added to the zip a file at a time, as each one is
  read, so no more than one file's bytes are held decoded at once.
- Smoke (`test/smoke/smoke.mjs`), scenario "messenger": serve a synthetic page at
  `https://www.messenger.com/e2ee/t/123`, click the popup's button, and assert that the
  popup closed and the collector's panel (`#leket-messenger-panel`) mounted, which proves
  the MAIN-world files injected. Wait for the bridge mark, then post a synthetic `leket:messenger-export` with two messages and one small JPEG
  Blob, then assert one zip on disk holding the json, the md and `messenger-media/…jpg`
  with the right bytes. Prove it red by routing `messenger` to the Discord export page in
  the `leket:ready` handler, and record that red run in the PR body.

### C. Collector: `src/modules/messenger/collector.js` (MAIN world, classic script)

- Gate: the same path test as the registry. On no match, return with a panel message (no
  `alert`). A second launch while the panel is open does nothing.
- Panel: a fixed div `#leket-messenger-panel`, shaped like Discord's, with the count, the oldest date, the photos
  captured, **Start**, **Stop** and **Save**, and a status line.
- PIN or empty: when no `div[data-message-id]` mounts within 10 s of Start, the status
  says "No messages are showing. If Messenger is asking for your PIN to restore chats,
  enter it there, then press Start again." The collector never touches any dialog.
- Sweep: Start jumps to the bottom (`scrollTop = scrollHeight`), harvests, then steps up
  by 85% of `clientHeight` every 900 ms, harvesting after each step. It is at the top when
  `scrollTop === 0`, the header img (≥ 48 px wide, before the first row in document
  order) is mounted, and the id count hasn't grown over 3 steps. With `scrollTop === 0`
  but no header after 10 more steps, the status says "STALLED, not at the start" and keeps
  what it has. Then it steps down to the bottom, harvesting again, which catches rows
  whose photos hadn't loaded on the way up. Stop ends either leg.
- Harvest, per mounted row not yet complete:
  1. Find `message` by the id match. Find `contact.name` and `outgoing` higher up the chain
     (search to depth 80, and stop at the first hit of each).
  2. Store `normalize(...)` in a Map keyed by `messageId`. A later read of the same id
     replaces fields that were null.
  3. When `kinds` includes `media`: for each `<img>` in the row with natural size ≥ 150
     px on both sides, whose `src` starts with `data:` or `blob:`, and that sits outside any
     `a[href^="http"]`: once it is complete, read its bytes (`data:` by decoding, `blob:` by
     `await fetch`) **before the next scroll step**. Keep it as a Blob named by
     `mediaName`. A `<video>` in a media row records `video` in the message's `kinds`;
     when its `currentSrc || src` starts with `blob:`, read it with `await fetch` the same
     way (a fetch that throws, as a MediaSource blob URL would, is recorded as not captured
     with the error as its reason) and store `duration_s` from `video.duration` when it is
     finite. Count the photos and videos captured on the panel, with their total MB. A
     media row that ends the sweep with nothing captured, whatever its `src` scheme, goes in
     `media_not_captured` with its message id.
  4. Link-preview rows record the first `a[href^="http"]` href as `link`. Their
     thumbnails are not saved.
- More than 2 distinct `sender_id`s: the status warns "This looks like a group
  conversation; groups aren't checked yet". The save is still allowed.
- Save: build `{ host, thread_id, url, title, saved_at, time_zone, count, senders:
  {id: name}, media_not_captured: [...], messages: [...] (sorted by time, then id) }`.
  Name the file `messenger-<name>-<thread>.json` (name from `document.title` before
  ` | Messenger`, cleaned as Discord's is, ≤ 50 chars). When the bridge mark
  `data-leket-messenger-bridge="1"` is present, post it with its files. Otherwise download
  the JSON alone, through an anchor.
- Tests: `test/fixtures/messenger_page.cjs`, a vm fake page shaped like
  `fake_page.cjs`: synthetic rows with fiber chains (the message at depth 24, the contact
  at depth 56), a virtualized scroller that mounts 20 rows around `scrollTop`, a header
  img at the top, one photo row whose `data:` img completes only on the second visit, a
  video row, a link row and an unsent row. `test/messenger-collector.test.js` asserts the
  count, the dedupe, the names, the photo captured on the way down, the video captured
  (and a second video whose fetch throws, recorded as not captured), the link placeholder, the STALLED path when the header never mounts, the PIN status with no
  rows, and the group warning.

### D. Docs, version, release

README: a "Save a Messenger conversation" section, the file table, and the layout lines.
Bump to 0.4.0 in `manifest.json` and `package.json`. Release notes go in the PR that
completes the batch. Then the owner reloads the unpacked extension and runs one real save
on a thread she picks (filed as a Needs Lila item).

## Open, for later

Stickers, voice clips, the unknown
kinds `4`, `4096` and `2^29`, groups, and the English-locale panel wording.
