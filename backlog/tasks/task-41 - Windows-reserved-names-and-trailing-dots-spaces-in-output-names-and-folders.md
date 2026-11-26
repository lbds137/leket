---
id: TASK-41
title: Windows reserved names and trailing dots/spaces in output names and --folders
status: To Do
assignee: []
created_date: '2026-11-26T17:03:00Z'
updated_date: '2026-11-26T17:03:00Z'
labels:
  - convert
dependencies: []
priority: low
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the #204 claude-review (finding 4). safeTitle and badFolder handle the characters Windows refuses (TASK-32.15) but not reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, as a whole base name, any extension) or a folder part ending in a dot or space (a./b, 'a /b'), which Windows refuses or silently changes. Check first which converters can actually emit a bare reserved base name: the reviewer says a character-chat title 'nul' gives nul.md (not yet checked).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 safeTitle never returns a Windows reserved device name as the base name
- [ ] #2 badFolder refuses a part ending in a dot or space and a reserved device name
- [ ] #3 tests for each
<!-- AC:END -->
