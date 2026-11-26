---
id: TASK-32.16
title: 'leket convert whatsapp: other locales'' header shapes and the With-media zip'
status: To Do
assignee: []
created_date: '2026-11-26T19:30:00Z'
updated_date: '2026-11-26T19:47:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deferred from TASK-32.9 (0.15.0): only the day-first 'd.m.yyyy, H:MM - ' header is read, as the original did. Not read yet: 'M/D/YY, H:MM AM - ' (US Android), '[DD/MM/YYYY, HH:MM:SS] ' (iOS) and others, and the 'With media' zip (src/lib/unzip.js could read _chat.txt from it). Trigger: an export in another shape arrives, or Lila asks. Slash dates are ambiguous (D/M vs M/D) and need a flag or inference from days over 12.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Also (claude-review #208 low 6): conversationName strips only the English 'WhatsApp Chat with ' prefix; localized file names (e.g. 'Chat de WhatsApp con X.txt', 'WhatsApp-Chat mit X.txt') keep theirs in the output name and heading.
<!-- SECTION:NOTES:END -->
