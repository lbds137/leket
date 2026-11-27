---
id: TASK-44
title: Make the test suite faster; adopt cloud suite runs
status: To Do
assignee: []
created_date: '2026-11-27T03:50:00Z'
updated_date: '2026-11-27T03:52:00Z'
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
<!-- SECTION:NOTES:END -->
