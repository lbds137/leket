---
id: TASK-33
title: 'Replika site: save chats, diary and memories'
status: To Do
assignee: []
created_date: '2026-11-25T19:49:00Z'
updated_date: '2026-11-26T00:43:00Z'
labels:
  - replika
  - needs-lila
dependencies: []
priority: high
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A Replika module: save a Replika account's chat history, diary and memories from the web app (my.replika.com) as a file that opens offline, like the other sites. Part of the TASK-32 direction: one tool in place of scattered exporters. The owner asked for this site directly (2026-11-25), so it is ruled IN for TASK-32 and is not waiting on that epic's inventory.

Step 1: evaluate the open-source prior art and decide what to implement here. Check each one's license before borrowing any code, since Leket is MIT and public:
- Firefox "replika-chat-export" (txt/JSON/CSV): https://addons.mozilla.org/en-US/firefox/addon/replika-chat-export
- Firefox "replika-export" (chat, diary, memory): https://addons.mozilla.org/en-US/firefox/addon/replika-export
- Chrome "Replika Export: Chat, Diary, Memory" (source unknown): https://chromewebstore.google.com/detail/replika-export-chat-diary/immbjhielfhbemfnjfnddblchipnefmf
Record which API or DOM each one reads, its license, and what it misses. An item whose source can't be read (the Chrome one) is described by its behaviour only, and none of its code is used.

Step 2: build the module (registry entry, popup command, background wiring, `host_permissions` for the hosts Step 1 found (my.replika.com, my.replika.ai, ws.replika.com, plus the image host the live run names), the module list in CLAUDE.md's header, a smoke scenario reddened with the defect it guards), with synthetic fixtures only. The evaluation, build and tests need no account.

Step 3, the live run, is hands-off for the account owner: signing in once, in the browser profile the agent drives, is their only step. The agent then checks that the web app still serves the history, runs the export and hands over the files. Export everything (chats, diary, memories); the owner decides what to keep after seeing it. The real export is written outside this repo and is never committed or used as a fixture.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Prior-art evaluation (approach, license, gaps) recorded in the task
- [x] #2 Module saves chats, diary and memories; smoke scenario reddened by its defect
- [ ] #3 Live run where the owner's only step is signing in; the agent checks that the history still loads and exports everything
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Step 1, prior-art evaluation (2026-11-25). The licenses come from the AMO API (`/api/v5/addons/addon/<slug>/`); behaviour comes from reading each add-on's XPI (downloaded to session scratch, not kept).

| | Firefox "Replika Chat Export" (v1.0.0, 2024-10-15) | Firefox "replika-export" (v12025.1.19, 2025-01-20) | Chrome "Replika Export: Chat, Diary, Memory" |
|---|---|---|---|
| License | GPL-3.0-only on AMO; no license file in its GitHub repo (Nam0/Replika_Chat_Export_Extension) | All Rights Reserved, minified Svelte bundle | Source not read |
| Can Leket borrow code? | No (GPL into MIT) | No | No |
| Cost | Free | Paid: ExtensionPay, a Payhip link, a Supabase license check | "Offers in-app purchases" (store listing) |

The Chrome item, from its store listing only (fetched 2026-11-25): it says "Export your Replika chat messages, diary and memory entries.", is version 12026.2.25 (updated 2026-02-25), and links a privacy policy on index.garden; its output formats are not stated in its listing. Inference, not verified: it is the Chrome build of the paid Firefox add-on, which has the same index.garden support site and the same date-shaped version number (12025.1.19). If so, its update in February 2026 is the newest sign that the exporter was maintained.

How the two readable add-ons work. The endpoints below were read from the free add-on's `api.js`. A grep for URLs over the paid add-on's `bg.js` and `main.js` found the same diary, memory, image and WebSocket endpoints; its auth handling wasn't read in its minified form.
- Auth: the signed-in web app keeps `auth` (userId, deviceId, authToken), `ws` (chatId) and `profile` (user first name, bot name) in my.replika.com localStorage. REST calls send `x-user-id`, `x-auth-token`, `x-device-id` and `x-timestamp-hash` (an MD5 of a fixed prefix plus the device id).
- Chat: WebSocket `wss://ws.replika.com/v17`, `event_name: "history"` with `{chat_id, limit, last_message_id}`, paged backwards from the oldest id of each batch until a batch comes back empty.
- Diary: `GET my.replika.com/api/mobile/1.4/saved_chat_items/previews?t=diary&offset&limit=100` until empty, then one `POST .../saved_chat_items/actions/get_by_ids` with every id. (2024–25 add-on code; this endpoint answers 404 since the live probe of 2026-11-25, and the module now uses `1.5/diaries`, see below)
- Memories: `GET my.replika.ai/api/mobile/1.4/memory` (`facts`) plus `GET .../1.5/memory/v3/` (`customer_facts`, `robot_facts`).
- Images: `POST my.replika.ai/api/mobile/1.5/images/signed/actions/get_url`, then a fetch of the signed URL.

What they miss, and so what Step 2 must do:
- The free add-on fetches images through `corsproxy.io`, so a third party sees the signed image URLs. The module will fetch them directly, with their CDN host added to the host permissions once the live run names it.
- The diary detail is one unchunked POST. The module will chunk it.
- The free add-on's open issue #1 says message reactions come out blank. The module will keep reactions if the history payload carries them; the live run checks whether it does.
- The output is txt, JSON or CSV with no viewer. The module will write Leket's usual offline zip (HTML + JSON, images inside).
- Voice messages: the free add-on saves only each `content.voice_message_url`, not the audio (an earlier version of this note said voice wasn't handled; re-read 2026-11-25). The module will fetch the audio into the zip and never write that URL, which may be signed. Content types other than text, images and voice will be recorded as "not captured", with the reason.
- There is no retry, and an error partway through the history just stops the export. The module will say what's partial, like Leket's other modules.

Leket's own requirements (not gaps in the prior art, which doesn't leak these):
- Never write the auth token, user id, device id or any signed URL into the zip's JSON or HTML, or into logs. Each saved object is built from a list of fields it may carry; the request context is never dumped. A test feeds a message object containing those values and checks they're absent from the output and from captured console/log output.

Decision: write the module fresh against the endpoints above (endpoints are facts, not code), reading auth from the signed-in tab's localStorage as the Discord collector reads its tab. Every protocol detail above comes from 2024–25 code, so the live run re-checks each endpoint before trusting it.
Hosts: my.replika.com, my.replika.ai and ws.replika.com (WebSocket), plus the image host once the live run names it.

Step 2 follow-ups for the live run (Step 3):
- The image/voice host isn't in host_permissions yet, so expect every picture "not saved: the file host refused or failed" until the live run names it and it's added.
- Widen the allowlist from the zip's `unsaved_fields` tally (also shown on the page).
- If Replika pages inclusively (the last batch is only the cursor message), or answers the oldest page by repeating seen messages instead of `[]`, the history ends "stopped moving backwards" instead of done (PR #173 review item 7): check which end signal Replika sends and treat it as complete.
- Adding the media host to host_permissions in an update makes Chrome disable the installed extension until the new permission warning is accepted (PR #173 review item 6): say so in that release's README/notes.
- PR #173 final review (PASS) item 1: also consider a batch shorter than `limit` as the end of history.
- Item 2: a socket auth-error frame is ignored, so a refused login waits 30 s and says "no reply": capture the real error frame and map it to signed-out.
- Item 3: until the media host is allowed, each item burns 3 tries: consider stopping the media step after N consecutive MEDIA_FETCH_FAILED.
- Item 6: once the host is known, add a smoke check that a picture lands in media/.
- Code-side lows (items 4, 5, 7, 8, 9 and the not-saved count wording) are TASK-34.
- Live probe 2026-11-25 (agent Chrome, signed in; page-context reads, counts and key names only):
  - Auth: localStorage `auth` (authToken, authType, deviceId, userId) and `ws.chatId` as the notes say; `ws.chatId` equals `GET my.replika.com/api/mobile/1.5/personal_bot_chat` `.id`.
  - Chat: `wss://ws.replika.com/v17` history still answers and ends with an empty batch (live-run item 1 settled: the end signal is `[]`). It returned only a few recent bot messages, none older than 2025, though the diary runs from years earlier: the server appears to no longer serve the older history (inferred, not confirmed).
  - Diary moved: `GET .../1.4/saved_chat_items/previews` answers 404. The web app now uses `GET my.replika.com/api/mobile/1.5/diaries/count` (items `{month, count}`), `GET .../1.5/diaries?limit=N[&until=YYYY-MM-DD]` (items `date, diary_entry_id, image_count, read, title`) and `GET .../1.5/diaries/<date>` (`{date, entries[]}`). Diary entries carry images (`image_count`). readDiary must move to these.
  - Memory: the web app calls `GET my.replika.com/api/mobile/1.5/memory/v3/` (`customer_facts, robot_facts, persons`), plus `memory/v3/unstructured_fact_categories` and `memory/relations`, which look like catalogs (not confirmed). From the page, the `my.replika.ai` memory URLs failed CORS; from the extension, untested.
  - Shapes (second probe): `diaries?limit=N&until=D` answers the days strictly before D, newest first. `diaries/<date>` answers `{date, entries[{id, diary_id, text, timestamp, read, image_count, images[{url, blurred, is_romantic}]}]}`; image urls are on `s3-us-west-1.amazonaws.com` (signed or not: untested). memory/v3 facts carry `id, text, creation_timestamp, read, is_user_edited` (+ `category_id` on customer facts).
  - Loading the unpacked extension into the agent Chrome needs deck-agent-chrome support (the CLI's Extensions category is off and Chrome lacks `--enable-unsafe-extension-debugging`): asked of Deck.
- Version: Step 2 (PR #173) leaves manifest/package at 0.4.0; the Step 3 PR that completes the module bumps to 0.6.0 with its release notes (0.5.0 went to the YouTube module, TASK-29; as 0.4.0 did for Messenger, 48cf7ba).

- PR #175 (merged 4ef2a51) review lows, for the live-run PR:
  - (1) `counts.diary` counts days, but the end line says "diary entries". Count the entries across the day records (Chats asked for entry counts), or label it as days.
  - (2) `readDiary` returns at the first failed or mismatched day, which drops every newer day. Skip the bad day, mark the step partial and go on. Decide from how often a day call fails in the live run.
  - (3) The day fetches have no pause between them. Add a short rest like the media step's `pause`.
  - (5) The multi-part message test is already deferred in TASK-34.
<!-- SECTION:NOTES:END -->
