---
id: TASK-32.5
title: 'leket convert character-chat: character-chat site export to Markdown'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T16:28:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: medium
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row D: the converter only (conversations plus character cards); the toolbar module stays DEFERRED (re-accept prompt for installed users, site named publicly). Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One .md per conversation plus a cards file
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in #203 (0.11.0). AC3: Chats told 11-26 (invocation, deliberate differences, real-export counts).
<!-- SECTION:NOTES:END -->
