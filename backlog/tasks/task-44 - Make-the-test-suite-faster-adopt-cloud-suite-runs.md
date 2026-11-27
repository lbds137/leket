---
id: TASK-44
title: Make the test suite faster; adopt cloud suite runs
status: In Progress
assignee: []
created_date: '2026-11-27T03:50:00Z'
updated_date: '2026-11-27T04:39:00Z'
labels:
  - testing
dependencies: []
priority: medium
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lila (11-26 22:43, via Deck): "the other fix is faster tests and running tests in cloud sessions" / "I just want us to get that speed boost from sorting out our test woes". Context: tonight every suite queued 30-60 min on the shared /tmp/gate.lock at load ~24 (agy worker gates timed out waiting there; TASK-400, fleet-side). Local numbers measured 11-26 (this session, idle machine): full npm test 24-29s wall (951 tests), CI test 27-29s, smoke ~2m10 (Chromium launch dominates). Unit: run seyag:testing-discipline first — time the full suite and its slowest tests under stated conditions (load, -j), then fix in the skill order (time before any speed claim), record before/after. Candidates: smoke Chromium startup, zip/build tests shelling to python3/openssl. AFTER #211 closes, not before (Deck order). Deliverable: before/after suite wall time sent to Deck. Cloud: DP-A is drafting .claude/cloud/suite.md per repo; when it arrives, take it, get the suite to 100% on the VM; from then a cloud green on the exact tree counts as the push stamp (Lila 11-25).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope ruling (Deck, 11-26 22:5x): keep the unit SMALL — smoke startup plus whatever the measurement shows, stop there; no deep sweep for a 30s suite. The suite.md handoff stands as written.

Result (11-26 23:13-23:31, load 15-19 on 8 cpus): smoke 71.8s -> 32.5s wall, all green (suite-time names leket-smoke / leket-smoke-after); npm test unchanged within noise, 27.3 -> 30.2s wall, CPU ~68s. Per-scenario wall: youtube 16.1 -> 7.9, youtube-old 15.0 -> 7.4, replika 10.1 -> 1.2, messenger-collector 9.8 -> 1.3, etsy 9.0 -> 2.6. Fix class: page-carried pacing hint (<meta name="leket-poll-ms"> for the injected youtube driver + messenger collector, capped at the old default; harness-seeded __leketSmokePauseMs for the etsy/replika extension pages -> collectConversations pauseMs, collectMedia pause + new fileRetryMs pass-through), harness poll 150 -> 40ms, settle sleeps 500 -> 200ms, synthetic continuation batch 300 -> 20ms. Per-scenario timing now printed by the harness. Cloud half still open: waiting on DP-A .claude/cloud/suite.md.

Local half shipped via PR #212 (merged 11-27 04:37 as a468f3f2). Cloud half still open: take DP-A .claude/cloud/suite.md when it arrives.

Cloud half progress (11-27 ~13:15, Leket session): Lila sent "get it done rather than wait" — drafted the trio myself (machloket-client's as template; its header gives post-adoption ownership to the repo session). .claude/cloud/{setup.sh,step0.md,suite.md} on branch task-44-cloud-suite: suite = npm test only, as root, no browser tier (smoke stays local; ci.yml already proves the chromium recipe on runners if ever ported — decision in PR #217). Cross-family review (gemini-4-argon-high, read-only): 14 findings, all fixed in 6fcb8e5 — critical was my `installed $3` typo (set -u aborts on a successful install; the three landed sibling copies are clean, verified); also caught: pgrep wrapper self-match (bracket form specced), CommonMark oracle cold cache (setup pre-warms; `node -e "import('./test/md-oracle.js').then(m=>m.loadCommonmark())"` verified), step-3 green-run exit-1 shape, stdout-only MISSING lines. Every new command block ran locally before landing. PR #217 open, pr-ci-wait armed. DP published leket's usage-meter (a0fb8aa8; verified ls-remote + cloud-gate go test-only). FIRST-RUN BLOCKER: cloud-test never passes --class to cloud-launch → implementation class at week 77% = `cloud-gate: stop: week=77% gate 75%`; reported to DP with line numbers (fleet-wide: any suite run at ≥75% blocked; refused attempts also leave a stray cloud-test/base-<sha> ref). Fleet-wide step-3 quirks reported to DP too. Next: PR merge → cloud-test --dry-run → real run → iterate → `cloud-test record` → close the half.
<!-- SECTION:NOTES:END -->
