---
id: TASK-40
title: >-
  leket reddit: refuse image hosts whose DNS answer is private (Node can
  resolve; the extension can't)
status: To Do
assignee: []
created_date: '2026-11-26T12:40:00Z'
updated_date: '2026-11-26T13:28:00Z'
labels:
  - security
  - reddit
  - cli
dependencies: []
priority: medium
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Council review of #197 (GPT-6.2, 11-26): fetchImageData's isPrivateHost checks the hostname only, so a crafted post's image on a public name that resolves to 127.0.0.1 / 10.x / ::1 gets a TCP connect + TLS ClientHello from the CLI. prepare.js documents this as a known limit for the extension (it can't resolve names). Impact today: https only and certificate validation means no reply body comes back unless the local service holds a cert for the attacker's name; redirects are refused. The CLI could do better: Node's built-in fetch takes no lookup hook, so it needs the undici package (Agent connect.lookup rejecting private answers, v4+v6+mapped) or a dns.lookup pre-check (weaker: TOCTOU). Security dimension, so Lila rules on adding a dependency vs. the pre-check vs. accepting the limit.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Lila 2026-11-26 (AUQ): built-in lookup fix. CLI image fetches go through node:https.request with a lookup hook that refuses private answers (v4, v6, v4-mapped), no new dependency; the extension keeps its documented limit. Probe 11-26: https.get('https://localhost/', {lookup}) refused ::1 before connecting. Next after TASK-39's PR.
<!-- SECTION:NOTES:END -->
