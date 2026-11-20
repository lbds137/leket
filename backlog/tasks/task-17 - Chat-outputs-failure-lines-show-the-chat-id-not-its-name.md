---
id: TASK-17
title: 'Chat outputs: failure lines show the chat id, not its name'
status: Done
assignee: []
created_date: '2026-11-19T21:22:00Z'
updated_date: '2026-11-20T02:16:00Z'
labels:
  - chat-outputs
dependencies: []
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), closed 2026-11-19 per Lila; this task is the record. Unverified (PLAUSIBLE) unless marked.

Deferred; trigger: the next page.js change.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 6c5ad8c (0.3.40, 2026-11-15): failure lines now read 'name (id): error' (src/modules/claude-chat/page.js), smoke covers a nameless failing chat. Closed in the 11-19 prioritization pass after checking the code.
<!-- SECTION:NOTES:END -->
