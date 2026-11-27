---
id: TASK-42
title: >-
  convert: a heading's trailing ' #' and line breaks in chatgpt, gemini, discord
  and reddit titles
status: Done
assignee: []
created_date: '2026-11-26T17:26:00Z'
updated_date: '2026-11-27T15:33:00Z'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped in 0.18.2 (PR #215, merged c36bc25). Lila ruled 11-27: escape the break-class only — trailing ' #', odd backticks, '<tag's, '&entities;' (escapeTag) — newlines and cosmetics stay raw, zero output change on pattern-free titles (measured 11-27: zero text-loss in 3,048 titles). escapeHeading in src/lib/html-md.js wired into ten sites (chatgpt, gemini, discord render entry, reddit md.js, sms, whatsapp, signal, aim, google-chat, google-voice); escapeTag moved to lib/html-md.js with a re-export. Folded the #214 lows: RESERVED_STEM widened (spaces before dot, CONIN$/CONOUT$), safeTitle strips trailing spaces+dots both paths, --base refuses *?\"<>| + control/bidi, discord nul--2025.md pinned. SMS 'verbatim names' low falsified: sms.js already safeTitles attachment names; pinned by test. Review lows riding the next PR: safeTitle cut path can emit a bare reserved stem (re-pin after the strip), reddit code-span backslash note, badFolder messages, $3 asymmetry comment.
<!-- SECTION:NOTES:END -->
