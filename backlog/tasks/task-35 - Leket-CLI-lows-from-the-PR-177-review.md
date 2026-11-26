---
id: TASK-35
title: 'Leket CLI: lows from the PR #177 review'
status: To Do
assignee: []
created_date: '2026-11-26T01:11:00Z'
labels: []
dependencies: []
priority: low
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the PASS claude-review of 6764679 (PR #177, merged 11-26 01:09 UTC):
1. --out is made before yt-dlp runs, so a run that then fails (yt-dlp missing/too old, no info.json, playlist) leaves a new empty folder while saying "nothing saved": remove it on those paths if this run created it and it is still empty; test it.
2. A file further up the --out path (--out some-file/sub) throws ENOTDIR, shown raw: map it to "a file is in the way" too; test it.
3. lineKeeper can record a match twice (match in the kept 1 KB tail) or catch a straddled partial after the 64 KB cut; harmless for reportedTotal (first match). Skip re-testing a line already cut, or state it in the comment.
4. Chunks are decoded one Buffer at a time, so a multi-byte character split across chunks becomes U+FFFD in a kept line: setEncoding("utf8") on the child streams (pre-existing with log += d).
5. On Windows access(W_OK) checks only the read-only attribute; writePair still reports a later failure. Note only, unless Windows support matters.
(Item 6, TASK-31 note wording, fixed with this filing.)
<!-- SECTION:DESCRIPTION:END -->
