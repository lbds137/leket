---
id: TASK-32.9
title: 'leket convert whatsapp: WhatsApp chat export to Markdown'
status: To Do
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T11:51:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row L: WhatsApp chat export to Markdown. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Converts the format the original handles into one Markdown per conversation, the shape leket convert discord writes; names via --me / --name, times via --tz
- [ ] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [ ] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->
