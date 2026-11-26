---
id: TASK-32.9
title: 'leket convert whatsapp: WhatsApp chat export to Markdown'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T19:47:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row L: WhatsApp chat export to Markdown. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Converts the format the original handles into one Markdown per conversation, the shape leket convert discord writes; names via --me / --name, times via --tz
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Branch next-after-207, 0.15.0: src/convert/whatsapp.js, leket convert whatsapp. AC #1 deviations, deliberate (as in 32.8): no --me (a sender's name as written is the only mark, so --name NAME=LABEL covers the owner); --tz only names the zone (the export writes the phone's local time with no offset). Format: the original's one header shape, day-first 'd.m.yyyy, H:MM - '; other locales and the With-media zip deferred to TASK-32.16. Differences from the original: a sender is whatever comes before a header line's first ': ' (the original took only the names it was given, reading anyone else as a notice), and the senders are listed on stderr so a notice holding ': ' shows; default label is the name as written (phone numbers stay whole); the full bidi-control set is taken out, not five; a blank line inside a message is kept; '<' that would start a tag is escaped (<Media omitted>); a BOM is passed over; an impossible date names its line; no-message file errors; final line break. Parity on the synthetic fixture vs the original (every sender given in its names map): only those lines differ. Also carries the #207 lows: signal range min/max, tag escape (signal, sms too), poll-option indent, .TXT in any case, codeSpan source lines (signal, sms), one shared inputFiles() for claude-code/signal/whatsapp. AC #3 after merge.

Merged as #208 (2026-11-26, 1de3d2d). Gemini PASS, 6 lows fixed in bd9fc72; claude-review PASS, 6 lows carried to the next convert PR. Chats told 11-26 that wa2md.py can retire.
<!-- SECTION:NOTES:END -->
