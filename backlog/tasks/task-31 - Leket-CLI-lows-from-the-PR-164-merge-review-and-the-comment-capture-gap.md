---
id: TASK-31
title: 'Leket CLI: lows from the PR #164 merge review, and the comment-capture gap'
status: To Do
assignee: []
created_date: '2026-11-25T19:39:00Z'
updated_date: '2026-11-25T20:23:00Z'
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
6. Live run on nwHtAdyEAtQ captured 59 comments + 26 replies of ~97 reported (~88%): find out whether the rest are hidden/held comments YouTube counts but never serves, or a yt-dlp paging limit (compare against the browser count). DONE in PR #168 (see notes).
7. (From the #168 review.) The end-to-end bin test (test/cli.test.js, the fake yt-dlp run) covers only the capped path. Add an uncapped run that checks comment_sort=new, so a break in passing maxComments from main to youtube() shows.
Ruled out: a caption-host check (URL comes from the yt-dlp the user runs; raised as optional in all three rounds). Dismissed: "TASK-30 notes empty" (they were filled; the reviewer read an older tree).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Item 6 DONE (PR #168, merged 11-25): the gap was YouTube's top order, not hidden comments or paging. Live 11-25 on nwHtAdyEAtQ: comment_sort=top extracted 85, comment_sort=new 97 (= reported ~97); the 12 missing were all 0-like, 1-3 days old (7 roots, 5 replies); shared 85 identical in text/likes/author/reply order. Fix: uncapped saves use comment_sort=new (file is sorted by likes anyway); --max-comments keeps top so a capped save keeps YouTube's top selection. CLI rerun: 66 + 31 = 97, exit 0. Scope: one video measured.
Ruled out (from the #168 review): pinning the order of equal-like comments. Ties keep fetch order (now newest first), which the ytDlpArgs comment states; a fixed tie order would mean recording YouTube's rank per comment for no reader-visible gain.
<!-- SECTION:NOTES:END -->
