---
id: TASK-24
title: 'CI: check backlog/ parses and task labels stay in config.yml'
status: Deferred
assignee: []
created_date: '2026-11-19T21:34:00Z'
updated_date: '2026-11-19T21:39:00Z'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PR #153 review: `backlog task list` may list a task with an undeclared label without failing, so option 1 may only catch parse errors. Check the CLI on an undeclared label first, or take option 2 (the node test), which covers both.
<!-- SECTION:NOTES:END -->
