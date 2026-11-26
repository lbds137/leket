---
id: TASK-32.4
title: 'leket convert gemini: Google Takeout Gemini activity to Markdown'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T15:48:00Z'
labels:
  - convert
dependencies: []
parent_task_id: TASK-32
priority: medium
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row C: the generic core only (Takeout My Activity JSON, chats rebuilt across snapshots); site-dump merging and topic folders stay private. Decide whether the HTML-to-Markdown step needs pandoc. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real conversation. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rebuilds chats from one or more Takeout snapshots; pandoc question settled with evidence
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
0.10.0 on branch next-after-201. Pandoc: not needed. Leket's own src/lib/html-md.js against pandoc 3.7 gfm on 443 real replies: 263 byte-identical, 136 equal after style normalization, 44 layout-only, 0 letter/digit differences, no unknown tags. Parity with the original's archive: 84 shared chats, 72 with the same letters; the 12 that differ all have site turns, which the private rpc merge adds (wrapper scope). Canvases 5/5 identical, other-activity 56/56 rows. AC3 waits for the merge.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped in #202 (0.10.0, main b84404f): leket convert gemini, pure-JS HTML to GFM (pandoc ruled out: 0 letter/digit differences over 443 real replies), all 9 #201 lows handled. Chats told 11-26 (AC3) with the reproducing invocation and the wrapper scope.
<!-- SECTION:FINAL_SUMMARY:END -->
