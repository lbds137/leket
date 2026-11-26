---
id: TASK-37
title: 'YouTube module: PR #179 review lows'
status: To Do
assignee: []
created_date: '2026-11-26T03:43:00Z'
updated_date: '2026-11-26T03:48:00Z'
labels: []
dependencies: []
priority: low
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
claude-review on PR #179 (merged 11-26), all low: (1) page.js onLate comment has a duplicated line left by the review-fix edit; (2) package.json description lacks YouTube (manifest has it); (3) the GIVE_UP_MS race timer is never cleared after a normal finish; (4) replies phase waits stepMs/2 per click serially, ~1500 reply threads would exhaust the 15-min budget (watch in the live run, see the live-check notes below); (5) the overlay stays after Done/Stopped (fade it out); (6) driver parsing has no unit tests: readBlock, reply dedup fallback without lc=, the ytd-transcript-segment-renderer branch; (7) the overlay transcript line never reports its result.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Live-check items carried from TASK-29 (closed), for the first real run on a large video: (a) does YouTube reuse one replies-continuation element per page (the driver gives each 3 tries); (b) comment line breaks arrive as \n or <br> (both read); (c) the header count mounts late (re-read at the end); (d) the video-changed and superseded stops have no smoke scenario (needs a mid-run in-site navigation); plus wall time vs the 15-min budget (item 4) and the overlay persistence (item 5).
<!-- SECTION:NOTES:END -->
