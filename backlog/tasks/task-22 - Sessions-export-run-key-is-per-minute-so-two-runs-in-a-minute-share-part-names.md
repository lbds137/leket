---
id: TASK-22
title: >-
  Sessions: export run key is per minute, so two runs in a minute share part
  names
status: Done
assignee: []
created_date: '2026-11-19T21:22:00Z'
updated_date: '2026-11-20T02:16:00Z'
labels:
  - sessions
dependencies: []
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), closed 2026-11-19 per Lila; this task is the record. Unverified (PLAUSIBLE) unless marked.

Deferred; trigger: the next export.js change (add seconds to the key).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 6c5ad8c (0.3.40, 2026-11-15): runKey is now YYYY-MM-DDTHHMMSS (src/modules/claude-sessions/export.js:18). Closed in the 11-19 prioritization pass after checking the code.
<!-- SECTION:NOTES:END -->
