---
id: TASK-29
title: 'YouTube site: captions + comments with replies'
status: To Do
assignee: []
created_date: '2026-11-25T19:09:00Z'
updated_date: '2026-11-26T03:37:00Z'
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

Probes 11-25 ~20:35 (headless agent profile, Hebrew UI, test video nwHtAdyEAtQ). (b) ytInitialPlayerResponse captionTracks: 21 asr tracks, every baseUrl exp=xpo and no pot; fetch(baseUrl+&fmt=json3) = 200 with EMPTY body (PO-token wall). The player's own timedtext call carries pot+fmt=json3+lang (200) but is not in performance resource entries, so no passive grab. (c) get_transcript: probe denied by the auto-mode classifier (Unauthorized Access: internal API POST with the page key); not retried. The panel itself now loads via youtubei/v1/get_panel. (a) transcript panel DOM WORKS: description 'more' -> 'Show transcript' -> 44 segments, element transcript-segment-view-model (NOT ytd-transcript-segment-renderer), innerText '0:00 <a11y duration> text'; no language menu shown for an asr-only video. Comments DOM WORKS: 97 in header, 40 ytd-comment-thread-renderer after 6 scrolls + ytd-continuation-item-renderer pending; inner ytd-comment-view-model, ytd-comment-replies-renderer (21 reply buttons), #content-text/#author-text/#published-time-text/#vote-count-middle; time is relative + UI-localized, likes carry bidi marks (U+202B/U+202C) that parseLikes must strip. Design pick: DOM-driven (v3-shaped) for both; no internal-API or pot path.

Correction to the 20:32 probe note (its stamp said ~20:35; date printed 20:32): the classifier said only '[Unauthorized Access]', the 'internal API POST with the page key' reading is my inference; get_transcript and comments via youtubei/v1/next are UNPROBED, not ruled out; 'no language menu' was tested with an old-footer selector only (no positive control), pending the picker probe.

Probes 2, 11-25 20:41 (advisor round). Language: TED arj7oStGLkU has 49 tracks (48 manual + en asr); the panel opened in HEBREW (the agent profile's UI language picks the manual track) and offers NO language picker (controls: close, chapters/transcript chips, 'sync to video time'); this video rendered the panel in an A/B variant (target-id null, not engagement-panel-searchable-transcript): select segments, not the panel id. Segment children are locale-free: div.ytwTranscriptSegmentViewModelTimestamp, div.ytwTranscriptSegmentViewModelTimestampA11yLabel (localized), span.ytAttributedStringHost (text); chapter headings interleave. Panel does NOT follow the player CC track (CC set to en, panel still Hebrew). Player capture: movie_player.setOption('captions','track',{languageCode}) makes the player fetch /api/timedtext fmt=json3 WITH pot (reqs 351 en, 403 fr, 200), but an XHR hook saw 0-byte bodies (headless pot rejected? inferred, unverified). Comments end to end (nwHtAdyEAtQ): 90 threads + 31 reply view-models loaded vs header 97, continuation + 14 unexpanded reply buttons left, loop stalls in headless; header reconcile unreliable -> v1 uses a stall timeout + comments_note. chrome-devtools CLI times out long evaluate_script calls (client.js:120): start long in-page loops, then poll. Open: activeTab vs host permission (engineering, decide at build).

Review (11-25 late): council gpt-6.2 on the driver fixes and Sonnet on the whole branch, all important findings applied (dd48c00, 25968f0). Version bump to 0.5.0 deliberate (driver-side, not the worker). Live-check items for the first real run, none smoke-provable: (1) does YouTube reuse one replies-continuation element per page (3 tries each); (2) comment line breaks as \n or <br> (both read); (3) header count mounted late (re-read at the end); (4) wall time on a large section vs the 15-min budget; (5) the video-changed and superseded stops (no smoke scenario: needs an in-site navigation mid-run); (6) the overlay stays after Done (spec allows; remove on a later pass if it annoys).
<!-- SECTION:NOTES:END -->
