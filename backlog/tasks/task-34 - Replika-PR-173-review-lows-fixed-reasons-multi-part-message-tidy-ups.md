---
id: TASK-34
title: 'Replika: PR #173 review lows (fixed reasons, multi-part message, tidy-ups)'
status: To Do
assignee: []
created_date: '2026-11-25T23:56:00Z'
updated_date: '2026-11-26T00:25:00Z'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From the step-3 diary migration (08db06d) and its cross-family review (council code_review, openai/gpt-6.2-sol, 2026-11-25):
- `tallyUnknown` does not walk into arrays, so the nested `entries[].…` and `entries[].images[].…` paths in `DIARY_ALLOWED` are inert: an unknown field inside a diary entry or image is not reported in `unsaved_fields`. Fix: walk array items, tallying under `key[].sub`, with a test for an unknown field inside an entry.
- The `maxPages` cap reports `DIARY_STUCK`, the same reason as a list that stopped moving. A non-empty page at the cap means more may exist. Give the cap its own fixed reason ("stopped at the page limit; there may be more").
- Media fetches have no size cap and follow redirects unchecked. MV3 host_permissions bound what the extension can read, but an oversized file could exhaust memory while the zip is built. Add a per-file byte cap with a fixed not_captured reason; check the final URL against the allowed hosts once the live run names the media host.
- Dismissed: impossible calendar dates (2026-02-30) pass DIARY_DATE. The regex keeps the request URL safe, and the server answers such a date with an error, which already ends as DIARY_PARTIAL.
- Dismissed: media path collisions or unsafe ids. safeId plus makeMediaNamer (src/modules/replika/save.js:168-186) sanitize the id and add -2, -3… to repeats.
<!-- SECTION:NOTES:END -->
