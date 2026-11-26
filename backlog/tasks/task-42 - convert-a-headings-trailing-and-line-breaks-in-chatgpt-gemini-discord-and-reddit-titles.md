---
id: TASK-42
title: >-
  convert: a heading's trailing ' #' and line breaks in chatgpt, gemini, discord
  and reddit titles
status: To Do
assignee: []
created_date: '2026-11-26T17:26:00Z'
labels:
  - convert
dependencies: []
priority: low
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while fixing the #204 carried low for character-chat (0.12.0 added oneLineText in src/lib/html-md.js). chatgpt.js and gemini.js write a conversation title into '# ' raw (ported as-is from the originals), discord/convert.js writes its heading raw, and reddit md.js's escapeLine collapses whitespace but doesn't keep a trailing ' #' from CommonMark's closing sequence. A title ending ' #' loses the #; a raw title with Markdown characters renders as markup. Decide per converter whether to escape (changes output against the originals, so measure on the real exports) or keep raw.
<!-- SECTION:DESCRIPTION:END -->
