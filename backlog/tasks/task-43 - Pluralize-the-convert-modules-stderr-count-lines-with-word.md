---
id: TASK-43
title: Pluralize the convert modules' stderr count lines with word()
status: Done
assignee: []
created_date: '2026-11-27T03:19:00Z'
updated_date: '2026-11-27T13:41:00Z'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 0.18.1 (PR #214). word() sweep over convert stderr count lines, byte-identical per kind on 1-item and >=2-item fixtures (aim signal whatsapp sms discord google-voice google-chat). Kept: aim.js:121 + google-chat.js:75 (body text, not stderr); aim.js:155 + google-voice.js:247 (n=1 names the file); unconditional plurals like 1 messages pinned and deliberately left. The row textlog target = convertTextLogMain in bin/leket.js.
<!-- SECTION:NOTES:END -->
