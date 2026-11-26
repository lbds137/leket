---
id: TASK-39
title: >-
  convert discord: bound zip entry size before allocating; reject backslash in
  the zip-derived base
status: To Do
assignee: []
created_date: '2026-11-26T12:07:00Z'
labels:
  - cli
  - security
dependencies: []
priority: medium
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the #196 claude-review (lows with a security angle). (1) src/lib/unzip.js readZipEntry allocates entry.compressedSize (up to 4 GiB from the central directory) before checking entry.offset + 30 + compressedSize against the file size; a damaged or hostile entry gets RangeError/OOM instead of the 'cut short' error. Also cap inflate output (inflateRawSync maxOutputLength) to the entry's declared size. (2) bin/leket.js readDiscordSave: the entry filter ^[^/]+\.json$ lets a backslash through, so on Windows an entry like ..\..\x.json becomes the default base and join(out, base + '.md') writes outside --out. Apply --base's slash/backslash rule to the derived base.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 readZipEntry refuses an entry whose declared size runs past the file, before any allocation, with a test
- [ ] #2 a deflated entry inflating past its declared size is refused, with a test
- [ ] #3 a zip whose save entry name holds a backslash is refused (or its base sanitised), with a test
<!-- AC:END -->
