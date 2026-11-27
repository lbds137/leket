---
id: TASK-43
title: Pluralize the convert modules' stderr count lines with word()
status: To Do
assignee: []
created_date: '2026-11-27T03:19:00Z'
labels:
  - convert
dependencies: []
priority: low
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude-review round 1 on PR #211 (TASK-32.12) noted src/convert/common.js now exports word(n, one, many) and google-chat/google-voice use it for count lines and errors, while the older convert modules (aim, signal, whatsapp, sms, discord, textlog) hand-roll singular/plural in their stderr summary lines. Sweep those stderr strings onto word() in one pass; byte-compare each module stderr before/after (the aim Source line already went singular in this PR). Filed as a batch, not per-finding: one PR sweeping all convert modules.
<!-- SECTION:DESCRIPTION:END -->
