---
id: TASK-13
title: 'Discord: unguarded zip.add in build.js non-streamed tail'
status: Deferred
assignee: []
created_date: '2026-11-19T21:22:00Z'
updated_date: '2026-11-20T02:17:00Z'
labels:
  - discord
dependencies: []
priority: low
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), which stays open until Lila okays closing it. Unverified (PLAUSIBLE) unless marked.

The zip.add in build.js's non-streamed tail (~:245 at the time) is unguarded; it needs a lying size field to fail. Deferred; trigger: any build crash report.
<!-- SECTION:DESCRIPTION:END -->
