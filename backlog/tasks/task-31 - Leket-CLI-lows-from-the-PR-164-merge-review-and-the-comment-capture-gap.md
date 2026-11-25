---
id: TASK-31
title: 'Leket CLI: lows from the PR #164 merge review, and the comment-capture gap'
status: To Do
assignee: []
created_date: '2026-11-25T19:39:00Z'
labels: []
dependencies: []
priority: low
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the PASS review of 7895c0d (PR #164, merged 11-25) plus one gap seen live:
1. A signal-killed yt-dlp is reported in the files as "yt-dlp exited 1": pass the signal into extractFromInfo and say "was stopped (SIGTERM)" (the kill test pins the current wording; update it with the fix).
2. extractFromInfo picks the caption track a second time for transcript_language; have fetchTranscript return language with kind (needs the json3-rows test expectation widened by one field: an existing-assertion change, mention it in the PR).
3. Regional fallback picks alphabetically (en-GB before en-US); prefer the region of info.language when it has one. Optional.
4. --out naming an existing file throws from mkdir and prints a stack; give a one-line "leket: ..." error, exit 1.
5. yt-dlp stdout progress is captured but not shown (long comment fetches look hung) and the whole log is kept in memory; echo stdout to stderr and keep only the lines reportedTotal needs.
6. Live run on nwHtAdyEAtQ captured 59 comments + 26 replies of ~97 reported (~88%): find out whether the rest are hidden/held comments YouTube counts but never serves, or a yt-dlp paging limit (compare against the browser count).
Ruled out: a caption-host check (URL comes from the yt-dlp the user runs; raised as optional in all three rounds). Dismissed: "TASK-30 notes empty" (they were filled; the reviewer read an older tree).
<!-- SECTION:DESCRIPTION:END -->
