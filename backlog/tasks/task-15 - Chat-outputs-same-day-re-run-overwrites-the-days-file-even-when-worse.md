---
id: TASK-15
title: 'Chat outputs: same-day re-run overwrites the day''s file even when worse'
status: Deferred
assignee: []
created_date: '2026-11-19T21:22:00Z'
labels:
  - chat-outputs
  - deferred
dependencies: []
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), which stays open until Lila okays closing it. Unverified (PLAUSIBLE) unless marked.

The overwrite is deliberate (page.js comment). Deferred; trigger: a bad overwrite happens -> add a refuse-if-worse guard.
<!-- SECTION:DESCRIPTION:END -->
