---
id: TASK-32.3
title: 'leket convert chatgpt: ChatGPT export to Markdown'
status: To Do
assignee: []
created_date: '2026-11-26T11:27:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: medium
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row B: conversations.json from the ChatGPT data export, one Markdown per conversation (current branch). Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One .md per conversation, current branch only, speaker labels as flags
- [ ] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [ ] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->
