---
id: TASK-29
title: 'YouTube site: captions + comments with replies'
status: To Do
assignee: []
created_date: '2026-11-25T19:09:00Z'
updated_date: '2026-11-25T19:26:00Z'
labels: []
dependencies: []
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lila 11-25 14:08 (via Chats): the YouTube grabber 'should just get added to Leket'. New site beside Discord/Messenger/Etsy/Reddit: captions (auto + manual, chosen language) and comments with replies, in the youtube-extract/v1 schema (browser/youtube-extractor-guide.md in deck-platform has the v3 console script). Moved from deck-platform TASK-147. Test video https://youtu.be/nwHtAdyEAtQ.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Builders ready in src/modules/youtube/extract.js (PR #164): buildExtract/renderMarkdown/baseName(title,id)/json3ToTranscript. Before choosing the caption source, probe in a headless agent-profile tab (deck-agent-chrome cli, no window on Lilas screen): (a) transcript panel DOM (v3 script), (b) ytInitialPlayerResponse captionTracks baseUrl + &fmt=json3 (check non-empty body; may need pot), (c) youtubei/v1/get_transcript. Comments: DOM scroll/click (v3) vs youtubei/v1/next continuations. New host permission https://www.youtube.com/* = re-accept prompt (user-visible: say so). Usual wiring: registry, popup commands, background launch table, smoke scenario reddened.
<!-- SECTION:NOTES:END -->
