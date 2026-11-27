---
id: TASK-32.11
title: 'leket convert google-voice: Google Voice (Takeout) to Markdown'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-27T00:59:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row L: Google Voice (Takeout) to Markdown. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Converts the format the original handles into one Markdown per conversation, the shape leket convert discord writes; names via --me / --name, times via --tz
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done: shipped in 0.17.0 (PR #210, automerge-merged to main as d96d069; branch commits rebased to 51a5708/2609aef/d96d069). Generic port of the private voice2md.py: contacts from file names, Hebrew+English kind words, multi-label tag fallback, dedup on rollover, --me/--name/--tz/--contact/--title/--base. claude-review: 2 BLOCK rounds fixed in-PR (bare English kind words + multi-label tag fallback; htmlInputs Source-path regression + RFC 1950 deflate sniff), PASS round 3 with 9 lows carried to the next PR. Parity exact on 3 real contacts, counts only (937/937/0, 98/800/781, 322/1060/883 rows/files mapping in the PR body). Chats told 2026-11-26 its voice2md.py can retire (no redaction in the port; wrapper keeps it).
<!-- SECTION:NOTES:END -->
