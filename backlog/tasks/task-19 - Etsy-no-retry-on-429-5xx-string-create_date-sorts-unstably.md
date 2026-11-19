---
id: TASK-19
title: 'Etsy: no retry on 429/5xx; string create_date sorts unstably'
status: Deferred
assignee: []
created_date: '2026-11-19T21:22:00Z'
updated_date: '2026-11-19T21:28:00Z'
labels:
  - etsy
dependencies: []
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), which stays open until Lila okays closing it. Unverified (PLAUSIBLE) unless marked.

No retry on 429/5xx (the failure is shown in amber). Messages with a string create_date sort in an unstable order (real data is epoch). Deferred; trigger: either seen live.
<!-- SECTION:DESCRIPTION:END -->
