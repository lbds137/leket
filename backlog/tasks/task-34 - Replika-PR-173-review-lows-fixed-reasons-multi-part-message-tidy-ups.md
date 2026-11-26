---
id: TASK-34
title: 'Replika: PR #173 review lows (fixed reasons, multi-part message, tidy-ups)'
status: To Do
assignee: []
created_date: '2026-11-25T23:56:00Z'
labels:
  - replika
dependencies: []
priority: medium
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From PR #173's passing claude-review (6c8a943), to fix before or with Step 3:
- (4) collectMedia writes e.message into not_captured for a non-SignedOut signedImageUrl error (save.js:201). Safe today only because call() throws fixed strings; use a fixed constant so a future call() change can't leak text into data.json/the page. Add a canary.
- (5) page.js says "${filename} was not saved" when any part of a multi-part zip fails; name the failed part and how many landed.
- (7) runSave's first if (stopReason) before the diary step is unreachable (the chat step never sets it): remove, or wire it up with live-run item 2.
- (8) unsaved_fields.diary tallies previews and entries against one allowlist, so preview-only field names over-report: tally previews separately.
- (9) the media step briefly shows "0 of 1" before the first progress callback.
- (round 1) the not-saved count says "picture(s) or voice clip(s)" but also counts messages of a kind Leket doesn't read (stickers, say); word it as "item(s)" or split the count (moved here from TASK-33 per PR #174 review).
Live-run items (1, 2, 3, 6) are in TASK-33's notes.
<!-- SECTION:DESCRIPTION:END -->
