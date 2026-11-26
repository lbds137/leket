---
id: TASK-32.8
title: 'leket convert signal: Signal plain-text export to Markdown'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T19:10:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row L: Signal plain-text export to Markdown. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Converts the format the original handles into one Markdown per conversation, the shape leket convert discord writes; names via --me / --name, times via --tz
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 0.14.0 (branch next-after-206): src/convert/signal.js, leket convert signal. Spec was upstream's writer (signalbackup-tools signalbackup/exporttxt.cc), not only the original. AC #1 deviations, deliberate: no --me (a display name is the only way the export marks a sender, so --name NAME=LABEL covers the owner too; the wrapper passes its own full name); --tz only names the zone (the export writes the exporting computer's local time with no offset, so nothing can be converted). Differences from the original: Signal's own events ('[date] *** text', no <name>) are their own entries from 'Signal' (the original folded them into the previous message as raw text: 148 such lines in one real transcript; dropped one at file start); empty <> name shows as '(no name)' (original crashed); empty file errors (original crashed); final line break. Parity on the synthetic fixture vs the stubbed original: only those lines differ. AC #3 after merge.

Merged as #207 (2026-11-26). Gemini r1 BLOCK, 4 fixed in b39f378 (one-export check after reading, *** <Name> is a file only with 'sent file', names holding >, any month word refused, year <1000 refused); r2 PASS; claude-review PASS, 7 lows carried to the next convert PR. Chats told 11-26 (SendMessage) that sigtxt2md.py can retire.
<!-- SECTION:NOTES:END -->
