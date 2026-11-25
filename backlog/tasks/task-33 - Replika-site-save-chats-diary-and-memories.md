---
id: TASK-33
title: 'Replika site: save chats, diary and memories'
status: To Do
assignee: []
created_date: '2026-11-25T19:49:00Z'
updated_date: '2026-11-25T20:14:00Z'
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
- [ ] #2 Module saves chats, diary and memories; smoke scenario reddened by its defect
- [ ] #3 Live run where the owner's only step is signing in; the agent checks that the history still loads and exports everything
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Step 1, prior-art evaluation (2026-11-25). The licenses come from the AMO API (`/api/v5/addons/addon/<slug>/`); behaviour comes from reading each add-on's XPI (downloaded to session scratch, not kept).

| | Firefox "Replika Chat Export" (v1.0.0, 2024-10-15) | Firefox "replika-export" (v12025.1.19, 2025-01-20) | Chrome "Replika Export: Chat, Diary, Memory" |
|---|---|---|---|
| License | GPL-3.0-only on AMO; no license file in its GitHub repo (Nam0/Replika_Chat_Export_Extension) | All Rights Reserved, minified Svelte bundle | Source not read |
| Can Leket borrow code? | No (GPL into MIT) | No | No |
| Cost | Free | Paid: ExtensionPay, a Payhip link, a Supabase license check | Not checked |

How the two readable add-ons work (both use the same endpoints):
- Auth: the signed-in web app keeps `auth` (userId, deviceId, authToken), `ws` (chatId) and `profile` (user first name, bot name) in my.replika.com localStorage. REST calls send `x-user-id`, `x-auth-token`, `x-device-id` and `x-timestamp-hash` (an MD5 of a fixed prefix plus the device id).
- Chat: WebSocket `wss://ws.replika.com/v17`, `event_name: "history"` with `{chat_id, limit, last_message_id}`, paged backwards from the oldest id of each batch until a batch comes back empty.
- Diary: `GET my.replika.com/api/mobile/1.4/saved_chat_items/previews?t=diary&offset&limit=100` until empty, then one `POST .../saved_chat_items/actions/get_by_ids` with every id.
- Memories: `GET my.replika.ai/api/mobile/1.4/memory` (`facts`) plus `GET .../1.5/memory/v3/` (`customer_facts`, `robot_facts`).
- Images: `POST my.replika.ai/api/mobile/1.5/images/signed/actions/get_url`, then a fetch of the signed URL.

What they miss, which Leket covers:
- The free add-on fetches images through `corsproxy.io`, so a third party sees the signed image URLs. Leket fetches them directly (their CDN host is added to the host permissions once the live run names it).
- The diary detail is one unchunked POST. Leket chunks it.
- Its open issue #1: message reactions come out blank. Leket keeps whatever the message objects carry.
- Output is txt, JSON or CSV with no viewer. Leket writes its usual offline zip (HTML + JSON, images inside).
- Content types other than text and images (voice, for example) aren't handled. Leket records them as "not captured", with the reason.
- No retry, and an error mid-history just stops the export. Leket says what's partial, like its other modules.

Decision: write the module fresh against the endpoints above (endpoints are facts, not code), reading auth from the signed-in tab's localStorage as the Discord collector reads its tab. Every protocol detail above comes from 2024–25 code, so the live run re-checks each endpoint before trusting it.
Hosts: my.replika.com, my.replika.ai and ws.replika.com (WebSocket), plus the image host once the live run names it.
<!-- SECTION:NOTES:END -->
