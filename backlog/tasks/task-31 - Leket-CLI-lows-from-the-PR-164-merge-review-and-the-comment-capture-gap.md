---
id: TASK-31
title: 'Leket CLI: lows from the PR #164 merge review, and the comment-capture gap'
status: Done
assignee: []
created_date: '2026-11-25T19:39:00Z'
updated_date: '2026-11-26T01:06:00Z'
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

Items 1-5, 7 DONE (branch task-31-cli-lows): (1) a signal-stopped yt-dlp says "was stopped (SIGTERM)" (extractFromInfo ytDlpSignal; kill test updated); (2) fetchTranscript returns language beside kind, extractFromInfo no longer re-picks the track (json3-rows deepEqual widened by language: an existing-assertion change); (3) regional fallback prefers the region of info.language, case-insensitive, else key order; (4) --out is made before yt-dlp runs, a failure is one line "leket: can't save into DIR (...); nothing saved.", exit 1; (5) yt-dlp stdout is echoed to stderr, run() keeps only the estimate and too-old lines (lineKeeper; the fake now logs its estimate on stdout like to_screen); (7) uncapped end-to-end run checks comment_sort=new. Red-first: 5 new/changed tests fail on origin/main code; item 7 test reddened by defaulting maxComments to 500.

Council review (openai/gpt-5.5; cross-family lanes closed: agy at its week gate, z.ai never reviews Claude work) of 281ff34, no blockers. Applied: a match early in an over-64 KB unended line is kept before the cut; --out also checked writable (access W_OK, EACCES one-liner) before yt-dlp runs; regional pick filters before sorting. Ruled out: g/y regex in lineKeeper (no caller passes one; comment states it); split CRLF adds an empty line (never kept); unbounded kept lines (yt-dlp prints the estimate once); one keeper for both streams (would merge a partial stdout line with a stderr chunk); transcript_language on a failed fetch (unchanged from before: cap.kind was set on failure too, and transcript_note says it failed); en_US normalisation (unprobed whether yt-dlp ever emits an underscore form). Version: rides the 0.5.0 batch (TASK-33 Step 3 PR) like #164/#168.
<!-- SECTION:NOTES:END -->
