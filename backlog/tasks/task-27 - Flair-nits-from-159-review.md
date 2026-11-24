---
id: TASK-27
title: 'Flair nits from #159 review'
status: Done
assignee: []
created_date: '2026-11-20T19:31:00Z'
updated_date: '2026-11-24T00:57:00Z'
labels:
  - chore
dependencies: []
priority: low
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Round-3 claude-review lows on #159 (merged, PASS), parked to stop the review loop: (1) TASK-26 final summary says branch, make it #159; (2) pin intraword _ boundary beyond ASCII letter-letter (digits, Unicode, edges); (3) assert the r/ header line exists before .includes("()") so a miss reads clearly; (4) flairLine comment: "smallest set" overclaims, say "a small set that keeps links, images and emphasis dead".
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All four #159 lows: TASK-26 summary names PR #159; intraword _ pinned for digits, Unicode letters, edges, space and punctuation; r/ header asserted before the () check; flairLine comment says "a small set that keeps links, images and emphasis dead".
<!-- SECTION:FINAL_SUMMARY:END -->
