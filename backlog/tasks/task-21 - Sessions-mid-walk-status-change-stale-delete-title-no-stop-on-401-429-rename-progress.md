---
id: TASK-21
title: >-
  Sessions: mid-walk status change, stale delete title, no stop on 401/429,
  rename progress
status: Deferred
assignee: []
created_date: '2026-11-19T21:22:00Z'
labels:
  - sessions
  - deferred
dependencies: []
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), which stays open until Lila okays closing it. Unverified (PLAUSIBLE) unless marked.

A session changing status mid-walk can be missed; the delete title is not re-checked per DELETE in a long batch; delete and rename keep going after a systemic 401/429; rename has no read progress counter. Deferred; trigger: any live report of one.
<!-- SECTION:DESCRIPTION:END -->
