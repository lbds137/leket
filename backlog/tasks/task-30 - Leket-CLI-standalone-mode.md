---
id: TASK-30
title: Leket CLI / standalone mode
status: Done
assignee: []
created_date: '2026-11-25T19:09:00Z'
updated_date: '2026-11-25T19:26:00Z'
labels: []
dependencies: []
priority: high
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lila 11-25 14:08: 'maybe have a way to use Leket from the command line as a standalone option'. Sessions run a save from a shell without the toolbar click. First backend: YouTube via yt-dlp (uvx yt-dlp is allow-listed on the Deck). Chats' probe 11-25: --print title/description works; --write-auto-subs --sub-langs en --sub-format vtt wrote no file, warning 'No supported JavaScript runtime could be found. Only deno is enabled by default' (try --js-runtimes node; node is under mise); --write-comments unprobed. Output the same schema as the extension. Reply to Chats with the command name.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PR #164: `leket youtube <url>` (bin/leket.js; package.json bin). yt-dlp with --js-runtimes node:<execPath> + --ignore-config writes info.json with comments; the CLI fetches the json3 caption track itself (manual > <lang>-orig > plain auto), so a caption 429 keeps comments (exit 3). 11-25 probes: timedtext 429 with Google "Sorry" page at 14:14, later run fetched en-orig fine (176 segs); comments need no cookies. Cookies/PO-token question for Lila: moot unless 429s recur. Live: nwHtAdyEAtQ -> 59 comments + 26 replies of ~97 reported. Shared builder src/modules/youtube/extract.js is TASK-29s output.
<!-- SECTION:NOTES:END -->
