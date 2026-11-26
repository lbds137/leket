---
id: TASK-37
title: 'YouTube module: PR #179 review lows'
status: To Do
assignee: []
created_date: '2026-11-26T03:43:00Z'
updated_date: '2026-11-26T09:09:00Z'
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

Items 1-3, 5-7 DONE (branch task-37-youtube-lows, 0.6.6): (1) duplicated onLate comment line removed; (2) package.json description names YouTube, and Messenger (also missing; manifest has both); (3) GIVE_UP_MS timer cleared in a finally; (5) the overlay lingers 6 s after Done or the video-changed stop, then fades (.6s; removed at once under prefers-reduced-motion), unless a newer run took the panel; a superseded run no longer writes into the newer run's panel (say() checks the run token); (7) the transcript line ends as 'Transcript: N lines.' or 'Transcript: none. <note>'. (6) covered in the smoke, not node unit tests (the driver is DOM-only and the repo has no DOM library; adding jsdom for one module ruled out): a youtube-old scenario serves the ytd-transcript-segment-renderer A/B and lc-less replies with one re-rendered; readBlock was already covered (\n and <br> checks). Red-first: main's driver fails the two overlay checks; removing the author+text fallback and the old-renderer branch fails the two youtube-old checks. Accessibility: white on #1e1f22 ~16.5:1 by luminance arithmetic, theme-independent (panel paints its own background); no colour signal; no targets. Item 4 stays open: live-run gated (wall time of the serial reply clicks on a ~1500-thread video), with the live-check items (a)-(d) above.

Council review (openai/gpt-5.5; agy at its week cap, z.ai never reviews Claude work) of fd893ef: no blockers; token races, TDZ and the smoke checks judged sound. Applied: runToken set before say (no TDZ trap for a future early say) with an owned() helper. Ruled out: a Symbol/UUID token (a Math.random collision between two runs on one tab is not a real risk); guarding the detached transcriptLine write (harmless on a detached node).

#189 claude-review (PASS, 3 lows): (2) smoke overlay read raced the 6 s linger: lines now polled from the run's start (overlayDone) [decided, test-only]; (3) youtube-old checks the overlay and runs under emulated prefers-reduced-motion, asserting the panel goes with no opacity fade (red-first: disabling the reduced-motion branch fails it). (1) a stop during the transcript wait leaves the overlay line saying 'YouTube shows no transcript' (only reachable on video-changed in the first ~15 s; time can't fire there, superseded and video-changed save nothing): user-visible wording, asked of Lila 11-26.

#191 merged (claude-review PASS, one low: pending overlay promise could be an unhandled rejection; fixed in overlayDone with a no-op catch). Finding 1, Lila 11-26 picked 'Transcript: not read': when a stop cuts the transcript wait, the overlay says 'Transcript: not read (the save stopped).' and transcript_note 'Not read: the save stopped before the transcript loaded.'; also found in the new run: after a stop the comments/replies phases still printed their opening lines though their loops never ran, now gated on aborted. New smoke youtube-moves (no transcript section, pushState mid-wait) covers the video-changed stop, which closes live-check (d) for video-changed (superseded mid-run still has no scenario). Red-first: main's driver fails youtube-moves's overlay check. 0.6.7.

Gemini review (gemini-4-argon-high, cross-family) of 480f177: PASS, 2 nits, both decided and fixed: stopped() is sticky (returns !!aborted, so a tab that moved away and back no longer runs the reply clicks for a discarded result), and stops are checked directly at the transcript note and both narration gates and first in the comments-mount loop (a stop in a wait's final slice was short-circuited unrecorded). The sticky path is code-read only: the smoke can't place a move-and-return between the driver's noticing and its next gate deterministically.
<!-- SECTION:NOTES:END -->
