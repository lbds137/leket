---
id: TASK-32.3
title: 'leket convert chatgpt: ChatGPT export to Markdown'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T14:58:00Z'
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
- [x] #1 One .md per conversation, current branch only, speaker labels as flags
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in #201 (0.9.0): 15/15 real-export files byte-identical to the original; three deliberate fixes (collision suffix, voice transcription text, undated prefix). Gemini review lows fixed in-PR (0a1ce52). AC3: Chats session messaged 11-26 with the reproducing invocation and the differences. claude-review's nine lows carried to the next PR in this area (role Next).
<!-- SECTION:NOTES:END -->
