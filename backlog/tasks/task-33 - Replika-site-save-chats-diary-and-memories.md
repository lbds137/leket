---
id: TASK-33
title: 'Replika site: save chats, diary and memories'
status: To Do
assignee: []
created_date: '2026-11-25T19:49:00Z'
labels: []
dependencies: []
priority: high
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A Replika module: save a Replika account's chat history, diary and memories from the web app (my.replika.com) as a file that opens offline, like the other sites. Part of the TASK-32 direction: one tool in place of scattered exporters.

Step 1: evaluate the open-source prior art and decide what to implement here. Check each one's license before borrowing any code, since Leket is MIT and public:
- Firefox "replika-chat-export" (txt/JSON/CSV): https://addons.mozilla.org/en-US/firefox/addon/replika-chat-export
- Firefox "replika-export" (chat, diary, memory): https://addons.mozilla.org/en-US/firefox/addon/replika-export
- Chrome "Replika Export: Chat, Diary, Memory" (source unknown): https://chromewebstore.google.com/detail/replika-export-chat-diary/immbjhielfhbemfnjfnddblchipnefmf
Record which API or DOM each one reads, its license, and what it misses.

Step 2: before building, confirm on a live account that the web app still loads the history (a lapsed subscription may limit it); this needs the account owner signed in. Then build the module (registry entry, popup command, background wiring, a smoke scenario reddened with the defect it guards), with synthetic fixtures only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Prior-art evaluation (approach, license, gaps) recorded in the task
- [ ] #2 Live check that the web app still serves the history
- [ ] #3 Module saves chats, diary and memories; smoke scenario reddened by its defect
<!-- AC:END -->
