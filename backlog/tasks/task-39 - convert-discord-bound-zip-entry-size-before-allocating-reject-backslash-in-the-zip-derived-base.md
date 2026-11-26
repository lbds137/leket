---
id: TASK-39
title: >-
  convert discord: bound zip entry size before allocating; reject backslash in
  the zip-derived base
status: Done
assignee: []
created_date: '2026-11-26T12:07:00Z'
updated_date: '2026-11-26T13:10:00Z'
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
- [x] #1 readZipEntry refuses an entry whose declared size runs past the file, before any allocation, with a test
- [x] #2 a deflated entry inflating past its declared size is refused, with a test
- [x] #3 a zip whose save entry name holds a backslash is refused (or its base sanitised), with a test
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 0.8.1 (branch task-39-zip-bounds, c56eb38): readZipEntry checks start + compressedSize against the file before allocating (test mocks Buffer.alloc: nothing past the file's size is asked for); inflate capped at declared size + 1, zlib errors mapped to damaged-zip wording; readDiscordSave refuses a save over buffer.constants.MAX_STRING_LENGTH on its declared size; the derived base gets --base's slash/backslash rule (refused with 'give --base NAME'). All three tests red on eaf2b22 first. Carried #197 lows rode the same PR.
<!-- SECTION:NOTES:END -->
