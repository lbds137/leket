---
id: TASK-15
title: 'Chat outputs: same-day re-run overwrites the day''s file even when worse'
status: Deferred
assignee: []
created_date: '2026-11-19T21:22:00Z'
updated_date: '2026-11-20T02:17:00Z'
labels:
  - chat-outputs
dependencies: []
priority: low
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), closed 2026-11-19 per Lila; this task is the record. Unverified (PLAUSIBLE) unless marked.

The overwrite is deliberate (page.js comment). Deferred; trigger: a bad overwrite happens -> add a refuse-if-worse guard.
<!-- SECTION:DESCRIPTION:END -->
