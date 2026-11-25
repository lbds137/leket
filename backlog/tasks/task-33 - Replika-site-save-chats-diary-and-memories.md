---
id: TASK-33
title: 'Replika site: save chats, diary and memories'
status: To Do
assignee: []
created_date: '2026-11-25T19:49:00Z'
updated_date: '2026-11-25T19:55:00Z'
labels:
  - replika
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

Step 2: build the module (registry entry, popup command, background wiring, a `host_permissions` entry for my.replika.com in the manifest, the module list in CLAUDE.md's header, a smoke scenario reddened with the defect it guards), with synthetic fixtures only. The evaluation, build and tests need no account.

Step 3, the live run, is hands-off for the account owner: signing in once, in the browser profile the agent drives, is their only step. The agent then checks that the web app still serves the history, runs the export and hands over the files. Export everything (chats, diary, memories); the owner decides what to keep after seeing it. The real export is written outside this repo and is never committed or used as a fixture.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Prior-art evaluation (approach, license, gaps) recorded in the task
- [ ] #2 Live run where the owner's only step is signing in; the agent checks that the history still loads and exports everything
- [ ] #3 Module saves chats, diary and memories; smoke scenario reddened by its defect
<!-- AC:END -->
