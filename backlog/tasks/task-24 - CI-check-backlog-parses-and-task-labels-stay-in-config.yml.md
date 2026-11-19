---
id: TASK-24
title: 'CI: check backlog/ parses and task labels stay in config.yml'
status: Deferred
assignee: []
created_date: '2026-11-19T21:34:00Z'
labels:
  - release
dependencies: []
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Source: PR #152 review, finding 2 (low).

CI never installs deps or runs the backlog CLI, so a hand edit could add an undeclared label or a malformed task unnoticed. Fix shape: a CI step `npm ci && npm run backlog -- task list --plain`, or a node test checking each task's labels against config.yml.

Deferred; trigger: the next CI workflow touch, or a malformed task seen.
<!-- SECTION:DESCRIPTION:END -->
