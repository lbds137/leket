---
id: TASK-32.15
title: >-
  convert: safeTitle keeps Windows-forbidden * ? " < > | in chatgpt and gemini
  file names
status: To Do
assignee: []
created_date: '2026-11-26T16:11:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: low
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
src/convert/common.js safeTitle drops controls and slashes but keeps * ? " < > |, which Windows (and a FAT/exFAT or SMB disk on Linux) refuses, so a chatgpt or gemini title holding one fails to write there. character-chat replaces them with - after safeTitle (as the converter it ports did). Found porting TASK-32.5. Fix: move that replacement into safeTitle for every converter, with a test; it renames such files for existing users, so note it in the release.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 safeTitle replaces * ? " < > | for every converter
- [ ] #2 a test pins it for chatgpt and gemini
<!-- AC:END -->
