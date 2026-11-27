---
id: TASK-32.12
title: 'leket convert google-chat: Google Chat (Takeout) to Markdown'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-27T03:55:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row L: Google Chat (Takeout) to Markdown. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Converts the format the original handles into one Markdown per conversation, the shape leket convert discord writes; names via --me / --name, times via --tz
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented on the agy gemini lane from a written spec (premise ledger marking what came from the private original); reviewed driver-side, by fresh-context cross-family reviewers, and by the CI claude-review each round; full suite + smoke green before each push. In Progress until AC #3 (telling the original's owning session after merge) is checked. The private original's fixed choices became options (--owner/--me/--name/--tz/--title); its crash paths (undated first row, unknown month word, non-string date, empty conversation) became skips counted on stderr; non-owner names render as written, not first-name-only. The #210 review's nine carried lows ride the same PR (item 8, the task-32.11 annotation, was done on main at merge time). Review round 1: date round-trip check, tag-escaped bodies/attachments, word() counts, --title one-conversation guard, Groups descent + loose-messages.json labeling, gv/gchat name collapse (TASK-43 filed for the remaining hand-rolled plurals). Review round 2: --contact collapse (regression), Hebrew-locale hint on all-dates-fail, Groups hint in the skip message; unreadable-input hard-fail kept (house-wide exit contract).

Shipped in 0.18.0, PR #211 merged 2026-11-27 03:50 EST after four review rounds (rounds 1-2 fresh-context cross-family + CI; rounds 2-4 CI claude-review; the round-2 medium caught a real --contact regression, round-3 medium a missed manifest bump). AC #3 done 2026-11-27: the original's owning session (Chats) told gchat2md.py can retire.
<!-- SECTION:NOTES:END -->
