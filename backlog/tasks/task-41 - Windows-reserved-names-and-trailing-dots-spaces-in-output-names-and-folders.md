---
id: TASK-41
title: Windows reserved names and trailing dots/spaces in output names and --folders
status: Done
assignee: []
created_date: '2026-11-26T17:03:00Z'
updated_date: '2026-11-27T13:41:00Z'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 0.18.1 (PR #214). safeTitle appends - to reserved stems (COM0/LPT0 + superscript forms included, extending this row 1-9 list); badFolder refuses trailing dot/ASCII-space/reserved parts, folding ./.. into the dot check; --base routed through one badBase helper at all five sites; discord default base through safeTitle. Red-first tests + claim canaries; claude-review PASS with 6 lows, carried to the TASK-42 PR.
<!-- SECTION:NOTES:END -->
