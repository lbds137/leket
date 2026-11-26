---
id: TASK-32.10
title: 'leket convert aim: AIM chat logs to Markdown'
status: In Progress
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T20:18:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row L: AIM chat logs to Markdown. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Converts the format the original handles into one Markdown per conversation, the shape leket convert discord writes; names via --me / --name, times via --tz
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [ ] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Ported in 0.16.0 (branch next-after-208): src/convert/aim.js, leket convert aim. Real archive check (counts only, scratch copy): 9,471 kept as the original + 8 multi-line + 15 auto-responses = 9,494; same letters/digits on all 9,471. AC #3 (tell Chats) after merge.
<!-- SECTION:NOTES:END -->
