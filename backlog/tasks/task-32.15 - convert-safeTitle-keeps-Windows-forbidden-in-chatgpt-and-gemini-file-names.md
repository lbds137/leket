---
id: TASK-32.15
title: >-
  convert: safeTitle keeps Windows-forbidden * ? " < > | in chatgpt and gemini
  file names
status: Done
assignee: []
created_date: '2026-11-26T16:11:00Z'
updated_date: '2026-11-26T16:44:00Z'
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
- [x] #1 safeTitle replaces * ? " < > | for every converter
- [x] #2 a test pins it for chatgpt and gemini
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 0.11.1 (convert-lows PR): UNSAFE in common.js now holds * ? " < > |, so safeTitle replaces them for every converter and badFolder refuses them; character-chat's own replace removed. Gemini was never affected: clean() keeps only letters, digits and _ , ' ( ) - in chat and canvas names (probed: slug of 'a*b?c"d<e>f|g' is 'a b c d e f g'); its test pins that.
<!-- SECTION:NOTES:END -->
