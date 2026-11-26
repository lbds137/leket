---
id: TASK-32.14
title: 'convert gemini: a whole-account Takeout aborts on one huge unrelated JSON'
status: Done
assignee: []
created_date: '2026-11-26T15:48:00Z'
updated_date: '2026-11-26T16:22:00Z'
labels: []
dependencies: []
parent_task_id: TASK-32
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From #202 claude-review (low, filed because it is user-visible: the PR says whole-account Takeouts work). bin/leket.js readGeminiExport: the zip branch throws on any .json entry over MAX_STRING_LENGTH even from another product (e.g. Location History Records.json); the folder branch hits Node's raw ERR_STRING_TOO_LONG. Either way the run stops with nothing written, and every JSON is parsed in full only to be discarded. Fix: skip files outside a Gemini/My Activity path or oversized ones, and list them in the summary; test with a synthetic oversize entry (or an injected size limit).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fixed in 2746903 on branch next-after-202 (0.11.0 PR), with a test.
<!-- SECTION:NOTES:END -->
