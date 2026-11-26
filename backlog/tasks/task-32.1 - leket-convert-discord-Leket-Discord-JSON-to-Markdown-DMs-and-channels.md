---
id: TASK-32.1
title: 'leket convert discord: Leket Discord JSON to Markdown (DMs and channels)'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T12:07:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: high
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row A: merge the DM converter (replies, forwards, embeds, voice transcripts, per-year split) and the channel converter (monthly files, participants table) into one command reading the JSON inside Leket's Discord zip. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Reads a Leket Discord zip or its JSON; --by year|month; merges several saves by message id
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in #196 (0.7.0). AC3: Chats session messaged 11-26 with equivalent calls and the deliberate output differences. Review lows: TASK-39 (security-angled two); five others carried to the TASK-32.2 PR.
<!-- SECTION:NOTES:END -->
