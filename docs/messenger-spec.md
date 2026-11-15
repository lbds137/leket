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
  media_not_captured: [{ message_id, kind: "photo"|"video", reason }],   // one per item
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
  is a `**<sender>** HH:MM` paragraph, then the reply's quoted text as its own `> ` block,
  then its text (source lines joined with backslash hard breaks, blank lines kept as
  paragraph breaks), then one notes paragraph. Blank lines separate every block, so a quote
  never swallows what follows it.
  Each saved photo is `![photo](messenger-media/<file>)` and each saved video
  `[video, <duration> s](messenger-media/<file>)` (just `[video](…)` when the duration is
  unknown). Content that isn't saved gets a
  bracketed note: `[photo, not captured]` / `[video, not captured]` (one per
  `media_not_captured` entry for that message, by its `kind`, or one when a media row has
  nothing saved and no entry), `[sticker]`, `[link preview](<href>)` (spaces and `<>`
  percent-encoded) and `[unsent]`; an unsent message gets no media, sticker or link notes.
  Text renders literally: in text, quotes, names and the title, `` \ ` * _ [ ] < > ~ | & ``
  are backslash-escaped; a line starting with `#`, `>`, `-`, `+`, `=` or `:` gets a leading
  backslash, an ordered-list marker gets one before its `.` or `)` (`1\.`, since CommonMark
  escapes only punctuation), and leading spaces become no-break spaces so an indent never
  opens a code block. Messages are sorted by time, then id, before rendering, and an
  invalid time zone falls back to UTC.
- `safePart(s, max)` → `s` with every character outside `[\p{L}\p{N}._-]` replaced by `_`,
  runs of `_` collapsed, leading dots stripped, and cut to `max` characters (default 40);
  `"x"` if that leaves it empty. `mediaName(day, messageId, n, mime)` →
  `<day>_<safePart(messageId)>_<n>.<jpg|png|webp|gif|mp4|webm|mov|bin>` (by MIME type). Uniqueness comes from the
  collector, not the name: it appends `-2`, `-3` and so on when a name is already taken,
  comparing names case-insensitively (the export tab folds case, since a zip unpacked on
  macOS or Windows holds `a.jpg` and `A.JPG` as one file). `validMediaName(name)` (a bare
  `[\p{L}\p{N}._-]{1,120}` name, no leading dot) and `validSaveName(file)` (the save
  pattern below, else `messenger-export.json`) are the export tab's checks, kept here so
  the collector and the tests share them; every `mediaName` result passes `validMediaName`.

Tests (`test/messenger-read.test.js`, synthetic only): `i64` on `[0, 1]`, on a negative low
word (`[1, -1]` → 2^33 − 1), and on a real-shaped ms pair built from `Date.UTC`; `toIso`
round trip; `contentKinds` for 1, 2, 1024, 16384 and 1|4096; `safePart`/`mediaName` on an id
holding `/`, `$`, `=`, `..` and a leading dot; `normalize` on an e2ee-shaped
and a plain-shaped object; `renderMarkdown` day split across midnight in a non-UTC zone,
the photo link, the placeholders, and line-start escaping.

### B. Wiring

- `src/modules/registry.js`: a `messenger` module. `matches` parses the URL. The scheme must
  be `https:`, and the host `www.messenger.com` with a pathname matching
  `^/(e2ee/)?t/\d+/?$`, or `www.facebook.com` with `^/messages/(e2ee/)?t/\d+/?$`. Export the
  pathname pattern, as `CODE_PATHNAME` is.
  Title "Messenger"; blurb "Save this conversation, with its photos and videos, as one zip.";
  command `{ id: "save", label: "Save this conversation" }`.
  `test/registry.test.js`: matches all eight URL forms (plus a query or fragment, which is
  not path), and refuses `/t/` with no id, `messenger.com` without www, `m.facebook.com`,
  `facebook.com/messages/` bare, `/e2ee/t/abc`, `http:`, `/t/<id>/extra` and the bare hosts.
- `manifest.json`: add `https://www.messenger.com/*` and `https://www.facebook.com/*` to
  `host_permissions`. Add no CDN hosts, because nothing is fetched from them. Update the
  description to name Messenger. The whole `www.facebook.com/*` is needed, not just
  `/messages/*`: the `leket:ready` handler reads `sender.tab.url`, which Chrome fills only
  for a host the extension holds, and Facebook navigates in-page. New host permissions make
  Chrome ask to re-accept on update; the unit D release note says so.
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
  `blob.slice().arrayBuffer()`; an index or offset that is not a whole number in range gets
  an error. It announces with `{ type: "leket:ready", key }`. It keeps only the latest save,
  since media is large, but drops the older one only once `leket:ready` answers ok; a
  refused or failed handoff drops the new save instead, and acks `ok: false`. It accepts one
  post per 10 s (a refused one acks `{ ok: false, reason: "too-soon" }`): every post opens
  a tab, and the page world can post too. A request for a save it no longer holds answers
  `{ error, gone: true }`.
- `src/background.js` `leket:ready` handler: choose the export page by the sender tab's
  hostname: Save can be pressed after the page has moved on inside the site (Discord's
  friends list matches no module), and a collected save must still open. `discord.com`
  opens `discord/export.html` on the host alone. `www.messenger.com` and `www.facebook.com`
  open `messenger/export.html` only while `match(url)` is the messenger module (a thread
  page): facebook.com's other pages share the window the bridge listens on. Anything else
  gets `{ ok: false }`. The message shape stays the same, so `discord/collector.js` and
  `discord/bridge.js` don't change, and there is no diff to mirror.
- `src/modules/messenger/export.html` + `export.js`: `export.html` loads `../messenger/read.js`
  with a plain `<script>` before the `export.js` module, and `export.js` uses
  `globalThis.LeketMessengerRead`. Re-validate the posted `file` with `validSaveName`
  (`^messenger-[\p{L}\p{N}._-]{1,60}-\d{1,25}\.json$`, else `messenger-export.json`). Check
  each media file name with `validMediaName`; names compare with case folded, the first
  entry for a name wins, and an invalid or repeated one is listed as not captured. The
  media bookkeeping lives in `src/modules/messenger/media.js` (tested against a stub
  bridge): `listMedia`, `readMediaFile` and `settleMedia`. Read the JSON through
  `leket:chunk`, then each file through `leket:file` until `offset >= size`, decoding
  base64 into Uint8Arrays. A gone save is fatal (nothing is built). A tab that stops
  answering ends the reads; the JSON and Markdown are still written, with every file not
  read by then marked not captured. The JSON and Markdown are written after the media, so
  they name only files the zip holds: every listed file not saved (a failed read, or never
  handed over) becomes a `media_not_captured` entry on its own message, and a message keeps
  only the media entries the zip holds, by identity. Write a `ZipWriter` (default part limit) holding
  `messenger-<name>-<thread>.json`, `messenger-<name>-<thread>.md` (from `renderMarkdown`)
  and `messenger-media/<file>`. Download it with `createPartDownload` exactly as the
  Discord export tab does, with the same retry-by-click link. On release, send
  `leket:release`. The page states the counts: messages, photos and videos saved, and
  media seen but not captured. Media is added to the zip a file at a time, as each one is
  read, so no more than one file's bytes are held decoded at once. Because the JSON and
  Markdown come last, a save whose media passes the ~2 GiB part limit puts them in the last
  part; accepted, since retry-by-click covers a part that fails.
- Smoke (`test/smoke/smoke.mjs`), scenario "messenger": serve a synthetic page at
  `https://www.messenger.com/e2ee/t/123`, click the popup's button, and assert that the
  popup closed and the collector's panel (`#leket-messenger-panel`) mounted, which proves
  the MAIN-world files injected. Wait for the bridge mark, then post a synthetic `leket:messenger-export` with two messages and one small JPEG
  Blob, then assert one zip on disk holding the json, the md and `messenger-media/…jpg`
  with the right bytes. Prove it red by routing `messenger` to the Discord export page in
  the `leket:ready` handler, and record that red run in the PR body.

### C. Collector: `src/modules/messenger/collector.js` (MAIN world, classic script)

- Timings (constants at the top of the collector): `STEP_MS = 900`, `STEP_FRACTION = 0.85`,
  `ROWS_WAIT_MS = 10000`, `STILL_STEPS = 3`, `STALL_STEPS = 10`, `ACK_WAIT_MS = 10000`.
  Everything waits through `setTimeout`, so the fixture's virtual timers run a sweep in
  milliseconds.
- Gate: the same two path regexes as the stub. A second launch while the panel is mounted
  does nothing. Off a thread path, the panel mounts with only a status line saying
  "Open a one-to-one conversation on messenger.com or facebook.com/messages, then click
  Leket's button again." and a **Close** button (no `alert`).
- Panel: a fixed div `#leket-messenger-panel` with the stub's style, a bold heading
  `Leket: <name>`, a counts line (messages, oldest date `YYYY-MM-DD` or `-`, photos N,
  videos N, total MB to one decimal), a status line, and buttons **Start**, **Stop**,
  **Save**, **Close** (Close stops any sweep and removes the panel, as Discord's does).
- Controls and status prefixes:
  - **Start** while sweeping does nothing.
  - **Stop** ends the current leg at the next step; the status says
    `Stopped: press Save to keep what was collected, or Start to go on.`
  - **Save** during a sweep stops it first, waits for the in-flight harvest, then saves.
    **Save** with nothing collected says `Nothing collected yet: press Start.` and posts
    nothing.
  - While sweeping: `Going up: N messages…` / `Going down: N messages…`
  - Done: `Done: N messages from the start of the conversation. Press Save.`
  - Stalled: `STALLED, not at the start: N messages collected. Press Save to keep them, or Start to try again.`
  - No scroller (a conversation that fits on one screen, so no element passes the scroller
    rule): Start harvests the mounted rows once, then ends as Done if the header img is
    mounted, else as STALLED.
- PIN or empty: when no `div[data-message-id]` mounts within 10 s (`ROWS_WAIT_MS`) of Start,
  the status says "No messages are showing. If Messenger is asking for your PIN to restore chats,
  enter it there, then press Start again." The collector never touches any dialog.
- Sweep: Start jumps to the bottom (`scrollTop = scrollHeight`), sleeps 900 ms, and
  harvests, then steps up by 85% of `clientHeight` (each step: scroll → sleep 900 ms →
  harvest). It is at the top when `scrollTop <= 2`, the header img (≥ 48 px wide, before the
  first row in document order) is mounted, and the id count hasn't grown over 3 steps. With
  `scrollTop <= 2` but no header after 10 more steps (or when `scrollTop` has not changed
  for 3 steps without reaching the header), the status says "STALLED, not at the start" and
  keeps what it has. Then it steps down to the bottom (`scrollHeight - clientHeight -
  scrollTop <= 2`, or 3 steps with unchanged `scrollTop`), harvesting again, which catches
  rows whose photos hadn't loaded on the way up. Before declaring the top or the bottom, it
  runs one extra sleep and harvest. Stop ends either leg; an unexpected throw sets
  `ERROR: <message>. Press Save to keep what was collected.` and resets `sweeping`.
- Harvest, per mounted row not yet complete (wrapped in try/catch per row so a throwing row
  is skipped and counted as `N rows could not be read` in the Done/STALLED/Stopped status; a
  row is complete once its message has `time`,
  `sender_id`, `outgoing` and a sender name, and when `kinds` has `media`, at least one item
  was captured and every seen item is captured; a complete row is not read again):
  1. Find `message` by the id match. Find `contact.name` and `outgoing` higher up the chain
     (search to depth 80, and stop at the first hit of each).
  2. Store `normalize(...)` in a Map keyed by `messageId`. Merging a re-read row: fields
     that are `null` take the new value; `kinds` is the union; `link` keeps the first
     non-null. `senders` maps `sender_id → name` from the first contact name found for that
     sender, and `sender` on each message comes from that map at Save time.
  3. When `kinds` includes `media`: what counts as seen media outside any `a[href^="http"]`
     is:
     - a complete `img` (`complete && naturalWidth > 0`) with natural size ≥ 150 on both
       sides;
     - an incomplete `img` whose `getBoundingClientRect()` is ≥ 100 on both sides (an emoji
       or read receipt is far smaller, so it is never counted while loading; **this
       100×100 threshold is the driver's inference, not a probe fact**);
     - every `video` (a captured or seen-but-uncaptured video adds `"video"` to the
       message's `kinds` once).
     Media identity within a message is keyed by its source: a `blob:` URL as-is; a `data:`
     URL by `length + ":" + first 64 chars + last 64 chars` (never hold a second copy of a
     long `data:` string as a key). A key captured once is never read again. Whether
     Messenger keeps a `blob:` URL across a row's remount is not observed, so after reading
     the bytes, an item whose kind, size, and first and last 64 bytes equal an item already
     captured in the same message is also dropped. `data:` URLs are decoded with `atob`
     (never `fetch`, which the page's CSP may block) with MIME from the URL header; `blob:`
     URLs are read with `await (await fetch(src)).blob()`, hashing and sniffing with
     `blob.slice(0, 64)`, `blob.slice(Math.max(0, size - 64))` and `blob.size` (never
     calling `arrayBuffer()` on the whole blob, and keeping the Blob itself for posting),
     sniffing the first 12 bytes when `blob.type` is empty (JPEG `FF D8 FF`, PNG `89 50 4E 47`, GIF `47 49 46 38`, WEBP
     `RIFF....WEBP`, MP4/MOV `....ftyp`, WEBM `1A 45 DF A3`, else empty → `.bin`). All reads
     in a harvest finish before the next scroll step. Each captured item is a `{ file, kind,
     mime, width, height, bytes, duration_s }` entry on `message.media` (`n` in `mediaName`
     is the 1-based capture order within the message; case-insensitive collisions across the
     save insert `-2`, `-3`, … before the extension while staying ≤ 120 chars and passing
     `validMediaName`). Seen media not captured by the end of the sweep gets one
     `media_not_captured` entry `{ message_id, kind, reason }`: non-`data:`/`blob:` photo
     `not a data: or blob: image (<scheme>)`, incomplete photo `the photo never finished
     loading`, sourceless video `no video source`, failed fetch `fetch failed: <message>`,
     and a media row where nothing was seen on any visit gets one `photo` entry with reason
     `no media element`. Every not-captured branch skips when the slot or key is already
     captured, and an item captured on a later visit removes its earlier not-captured state.
  4. Link-preview rows record the first `a[href^="http"]` href as `link`. Their
     thumbnails are not saved.
- More than 2 distinct non-null `sender_id`s: `group_warning: true` and the status shows
  "This looks like a group conversation; groups aren't checked yet." The save is allowed.
- Save: build `{ leket: "messenger", version: 1, host, thread_id, url, title, saved_at,
  time_zone, count, senders: {id: name}, group_warning, media_not_captured: [...],
  messages: [...] (sorted by time, nulls last, then id) }`. Name the file
  `messenger-<NAME>-<thread_id>.json` (`NAME` = `document.title` with leading `(\d+) `
  unread count removed, cut before ` | Messenger`, trimmed, `"messenger"` if empty, cleaned
  with `[^\p{L}\p{N}._-]+` → `_`, ≤ 50 code points; passes `validSaveName` unchanged).
  Close sets a `closed` flag checked at the top of each row in harvest and after each await
  in Save (stopping before any handoff or download).
  With the bridge mark `data-leket-messenger-bridge="1"`, post `{ type:
  "leket:messenger-export", id, file, json, files }` to `location.origin` and wait up to
  `ACK_WAIT_MS` for the ack:
  - `ok: true` → status `Handed to the export tab (it opens next to this one): N messages, P photos, V videos.`
  - `ok: false, reason: "too-soon"` → status `Saved less than 10 seconds ago: wait a moment and press Save again.` (nothing downloaded).
  - any other `ok: false`, or no ack → fall back, status prefixed `The extension didn't answer (reload this tab and click Leket's button again for photos and videos)`.
  - Without the mark → fall back: move every `media` entry into `media_not_captured`
    (reason `saved without the extension, so media files were not kept`), empty each
    `media` list, and download the JSON alone through an anchor (`URL.createObjectURL`,
    revoked after click).
- Tests: `test/fixtures/messenger_page.cjs`, a vm fake page shaped like
  `fake_page.cjs`: synthetic rows with fiber chains (the message at depth 24, `outgoing` at
  ~40, `contact.name` at 56, decoy fibers above and below), a virtualized scroller that
  mounts ~20 rows around `scrollTop`, a header img at the top, one photo row whose `data:`
  img completes only on the second visit, a video row, a link row, an unsent row, filtered
  small imgs, case-insensitive name collision, reminted video blob URL, short no-overflow
  thread, off-thread path, Hebrew/emoji titles, stalled, PIN, group, and handoff paths
  (`test/messenger-collector.test.js`). The `"messenger-collector"` smoke scenario on
  `https://www.messenger.com/e2ee/t/456` runs the real collector's Start and Save end to
  end.

### D. Docs, version, release

README: a "Save a Messenger conversation" section, the file table, and the layout lines.
Bump to 0.4.0 in `manifest.json` and `package.json`. Release notes go in the PR that
completes the batch, and say that Chrome asks to re-accept permissions on update (the
new Messenger and Facebook hosts). Then the owner reloads the unpacked extension and runs one real save
on a thread she picks (filed as a Needs Lila item).

## Open, for later

Stickers, voice clips, the unknown
kinds `4`, `4096` and `2^29`, groups, and the English-locale panel wording.

Ruled out: an unforgeable Save handshake. The collector runs in the page's own world, so
any script on the thread page can post what it posts; the thread-page check and the
10 s throttle bound what a forged post can do (open an export tab), and they are the
whole defence.
