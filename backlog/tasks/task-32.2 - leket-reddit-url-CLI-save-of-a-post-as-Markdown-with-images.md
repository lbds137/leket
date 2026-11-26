---
id: TASK-32.2
title: 'leket reddit <url>: CLI save of a post as Markdown with images'
status: Done
assignee: []
created_date: '2026-11-26T11:27:00Z'
updated_date: '2026-11-26T12:47:00Z'
labels:
  - cli
dependencies: []
parent_task_id: TASK-32
priority: medium
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Row E: the CLI half of the Reddit exporter (images saved beside the Markdown, --from-json for a browser save), sharing src/modules/reddit/md.js with the extension. Generic only (public repo): every name, timezone and output layout is a flag; the private archive keeps a thin wrapper. Fixtures are synthetic, never a real post. Spec: the existing private converter (path kept in the Leket role file), ported as-is first. TASK-32 ruling 2026-11-26, docs/tools-inventory.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Same Markdown as the extension's md.js for the same JSON; image folder download; --from-json
- [x] #2 Unit tests on a synthetic fixture cover the format's edge cases the original handles
- [x] #3 The original's owning session is told it can retire its copy once this ships
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built in 0.8.0 (branch task-32.2-reddit-cli): leket reddit calls md.js render() directly, so AC1 holds by construction (test: --from-json output byte-equal to render()). Images via prepare.js fetchImageData (extracted; fetchImage wraps it). Default name reddit-<id>.md / reddit-<id>-images/ as the extension writes, not the private script's SUB-ID-slug; no --tz (md.js prints UTC). AC3 (tell Deck its copy can retire, incl. the name change) after merge.

Shipped in #197 (0.8.0, merged 2026-11-26 12:44 UTC). AC3: Deck told by SendMessage the same day (retire bin/reddit-export + browser/reddit-json.js; names, --file, exit 3, no --tz).
<!-- SECTION:NOTES:END -->
