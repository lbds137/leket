---
id: TASK-32
title: >-
  Epic: Leket as the one tool for pulling and converting data (retire one-off
  scripts)
status: To Do
assignee: []
created_date: '2026-11-25T19:44:00Z'
updated_date: '2026-11-25T20:14:00Z'
labels:
  - epic
dependencies: []
priority: high
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lila 11-25: "I basically just want us to stop having a million one-off scripts everywhere, and anything that makes sense to go into that tool, I think we should try to add to it"; "a Swiss Army knife in terms of being able to pull stuff from various places I care about and do any data massaging that we care about"; "if we have like conversion tools, that can also be added to Leket, because the exports are only as useful as the data we get out of them". She was clear it shouldn't become a kitchen sink: each candidate goes in only on purpose.

Step 1 (this epic's first unit): an inventory and a design doc (docs/) that decide IN or OUT for each candidate, with a reason. The IN/OUT list is Lila's call: it goes to her with a recommendation BEFORE anything is built.

Candidate kinds (the exact list is kept privately, outside this public repo):
- Scrapers that duplicate Leket's sites: Reddit, claude.ai sessions and YouTube console scripts, a Discord console mirror, and one other chat site's console export.
- Converters from chat exports to Markdown: Discord DMs and channels, Gemini, ChatGPT, Claude and similar.
- Probably OUT (a tentative recommendation for the inventory to confirm, not a ruling): Google Takeout and Discord data-package unpackers.

Constraints:
- Leket is public (MIT). Only generic code moves in. Names, paths and real data stay private, where a thin wrapper may call `leket`.
- Retiring a script means the `leket <site|convert>` path ships first, and then the script's owner deletes its own copy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Inventory and design doc in docs/ (docs/tools-inventory.md), with IN or OUT and a reason per candidate
- [ ] #2 Lila has ruled on the IN/OUT list (AskUserQuestion, with a recommendation)
- [ ] #3 After #2's ruling (not before), each IN item has its own task; each retired script's owning session is told once its leket path ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Replika is IN via TASK-33 (owner's direct ask, 2026-11-25); the inventory doesn't need to rule on it.
<!-- SECTION:NOTES:END -->
