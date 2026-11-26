---
id: TASK-32.7
title: 'leket convert sms: SMS backup XML to Markdown'
status: In Progress
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T18:11:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row L: SMS backup XML to Markdown. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Converts the format the original handles into one Markdown per conversation, the shape leket convert discord writes; names via --me / --name, times via --tz
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [ ] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 0.13.0 (branch task-32.7-sms): src/convert/sms.js + src/lib/xml.js, one file per conversation; parity on the synthetic fixture with the original's --number render (with and without --groups). AC #3 after merge.
<!-- SECTION:NOTES:END -->
