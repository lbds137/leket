---
id: TASK-26
title: >-
  Flair escaping: narrow the escape set for readable raw .md, add ~, tighten
  tests
status: Done
assignee: []
created_date: '2026-11-20T19:14:00Z'
updated_date: '2026-11-20T19:25:00Z'
labels:
  - enhancement
dependencies: []
priority: low
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From PR #158 claude-review (5 low findings, merged with VERDICT PASS). (1) ~ not escaped, so ~~x~~ strikes through; bare URLs autolink (no image load: ! and [ are escaped). (2) Over-escaping hurts raw-file reading: "Mod (retired)" saves as "Mod \(retired\)", ":snoo_joy:" as ":snoo\_joy:". Minimal safe set: \ ` * _ [ ] ~ (keeps links/images/emphasis dead). (3) test "no ()" asserts on the whole doc; scope it to the r/ header line. (4) pin an underscore-alias emoji case. (5) TASK-25 final summary names the branch, not #158.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
flairLine escapes only \ ` * [ ] ~ and non-intraword _; ( ) ! # stay raw; tests pin Mod (retired), :snoo_joy:, _x_, ~~x~~ and scope the no-() check to the r/ header (PR task-26-flair-escape).
<!-- SECTION:FINAL_SUMMARY:END -->
