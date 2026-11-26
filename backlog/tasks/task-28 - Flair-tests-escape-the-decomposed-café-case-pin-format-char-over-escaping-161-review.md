---
id: TASK-28
title: >-
  Flair tests: escape the decomposed café case; pin format-char over-escaping
  (#161 review)
status: Done
assignee: []
created_date: '2026-11-24T01:16:00Z'
updated_date: '2026-11-26T16:22:00Z'
labels:
  - chore
dependencies: []
priority: low
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From PR #161 claude-review (PASS, two lows). (1) test/md.test.js:676, the decomposed café_ünder case, holds raw combining marks U+0301 and U+0308 (the Edit tool decoded the backslash-u escapes in transport), so it looks identical to the precomposed case at :668; an NFC-normalizing editor or a dedupe would silently drop the combining-mark coverage. Write the marks as JS backslash-u escapes (build the text with chr(92) or similar, since Edit/Write decode them) and verify with a codepoint dump, not by eye; or add assert.notEqual(s, s.normalize("NFC")). (2) Optional: pin that an underscore next to a zero-width joiner (U+200D) or a variation selector is escaped (harmless, conservative). Leket is parked (Lila 11-23, low priority); pick this up when it resumes.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fixed in fcc368f on branch next-after-202 (0.11.0 PR): escapes, an NFC assertion (reddened on a precomposed case), ZWJ and VS16 cases.
<!-- SECTION:NOTES:END -->
