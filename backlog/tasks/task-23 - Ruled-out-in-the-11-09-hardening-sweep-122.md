---
id: TASK-23
title: Ruled out in the 11-09 hardening sweep (#122)
status: Done
assignee: []
created_date: '2026-11-19T21:22:00Z'
updated_date: '2026-11-19T21:29:00Z'
labels:
  - ruled-out
dependencies: []
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), which stays open until Lila okays closing it. Unverified (PLAUSIBLE) unless marked.

Ruled out (recorded so a later session does not re-raise them):
- Chat: `..` in output paths. Nothing writes to disk from the path; it is recorded as data.
- Cosmetics: `undefined` title in the _titles line, string payload spread, cse_ known-map lookup, Markdown links rendered literally, a double Save opening two tabs, BOM stripped (documented), parseChats echoing a long bad entry. Not worth a PR round each; revisit only alongside a touching change.
<!-- SECTION:DESCRIPTION:END -->
