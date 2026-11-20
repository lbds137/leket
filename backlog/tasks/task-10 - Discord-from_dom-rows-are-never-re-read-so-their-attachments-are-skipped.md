---
id: TASK-10
title: 'Discord: from_dom rows are never re-read, so their attachments are skipped'
status: Deferred
assignee: []
created_date: '2026-11-19T21:21:00Z'
updated_date: '2026-11-20T02:17:00Z'
labels:
  - discord
dependencies: []
priority: low
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrated from GitHub issue #122 (hardening sweep 11-09), which stays open until Lila okays closing it. Unverified (PLAUSIBLE) unless marked.

A row first read without its React object (from_dom) is never re-read, so its attachments are never fetched. The loss is announced in the panel and index.html. Deferred; trigger: a real save showing from_dom rows.
<!-- SECTION:DESCRIPTION:END -->
