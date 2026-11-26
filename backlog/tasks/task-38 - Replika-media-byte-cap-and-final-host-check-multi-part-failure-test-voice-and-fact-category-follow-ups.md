---
id: TASK-38
title: >-
  Replika: media byte cap and final-host check, multi-part failure test, voice
  and fact-category follow-ups
status: To Do
assignee: []
created_date: '2026-11-26T04:20:00Z'
updated_date: '2026-11-26T05:46:00Z'
labels:
  - replika
dependencies: []
priority: medium
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-ups from the TASK-33 live run. (1) A per-file media byte cap and a check that a fetch's final URL (after redirects) is still an allowed host. (2) A test for page.js's multi-part download failure message. (3) meta.voice_message showed up as an unread field on live messages; its shape is unknown (the account's served chat had no voice clips), so read it once a save shows one. (4) Facts carry category_id; memory/v3/unstructured_fact_categories looks like the name catalog (unconfirmed): resolve names if it is. Trigger: the next Replika change, or a save that shows a voice clip.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From PR #181's review: the new saved fields (original_text, emotion, diary reaction, fact category and edited) are in data.json but not rendered in index.html. original_text is the one a reader would most expect to see; render it (and the others where they read well) when this task is picked up, or settle that data.json alone is enough.

Lila ruling 11-25 (AskUserQuestion): ADD the in-code check. Before fetching a signed picture link, require https and either host s3-us-west-1.amazonaws.com with a path under /replika-content-images/ or host luka-user-media.s3.us-west-1.amazonaws.com; anything else is not captured. Reason: Chrome ignores the path in host permissions, so the manifest grants the whole s3-us-west-1 host. Ship it with item (1)'s final-host (redirect) check, as its own PR after #182.

Done in the host-check PR (0.6.2): signed picture links must point into replika-content-images on s3-us-west-1 or the luka-user-media host (replikaPictureUrl), else not captured with MEDIA_HOST_NOT_REPLIKA and never fetched; picture fetches use redirect: error so the checked URL is the one read (voice clips still follow redirects: their hosts are unknown). Still open here: the per-file byte cap, the multi-part download test, voice_message's shape, fact category names, rendering the new fields.

#183 review lows: smoke now proves both refusals in Chrome (a link signed into another bucket on the permitted S3 host is never requested; a picture link that 302s is not followed), reddened by each defect; usableMediaUrl test keeps a non-S3 positive; README note reworded. Open, deferred: a picture refused for its redirect is retried 3x (~2 s) and recorded as MEDIA_FETCH_FAILED, because fetch's TypeError can't tell a redirect from a network failure. redirect: manual would let Leket see an opaqueredirect response and label it without retrying (needs a fetchFile change). Promote when a run shows pictures failing that way, i.e. Replika's S3 starts redirecting.

#184 review lows (fold into the next TASK-38 PR): (a) smoke secret scan uses 'stray'/'moved', too generic; use the fixture fragments 'stray.png', 'stray-raw', 'moved.png', 'moved-to', 'moved-raw'. (b) key the smoke sign route on exact raw URLs, not substrings. (c) when redirect: manual lands, the sm6 smoke assertion and the unit test move from MEDIA_FETCH_FAILED to the new reason.

Done in 0.6.3: #184 lows (a) and (b) (the smoke secret scan names the fixture fragments; the sign route is keyed on exact raw links). Per-file cap: fetchFile takes maxBytes (refused on a declared or streamed size over it, not retried); Replika media use 50 MB (MAX_MEDIA_BYTES, the same as Reddit's images), marked MEDIA_TOO_LARGE; smoke proves it in Chrome (sm7, asked once), reddened by dropping the cap. Multi-part failure message: page.js's download loop moved to save.js as downloadParts + downloadProblem, unit-tested (part 2 of 3 failing, single file, no word, refused, all landed). Still open: (c) above; voice_message's shape and fact category names (both need a live save that shows them; trigger unchanged); rendering the new fields in index.html (Lila's call: asked after the 0.6.3 PR).

#185 review lows (PASS): (1) Reddit's prepare.js keeps its own 50 MB MAX_IMAGE_BYTES and length check beside Replika's MAX_MEDIA_BYTES: share one constant from src/lib in the rendering PR (Reddit's reader is its own, not fetchFile, so only the constant is shared). (2) Chrome-level proof of the streamed refusal: ruled out, the branch is plain JS with no chrome.* wiring and its unit test runs on node's WHATWG ReadableStream; a >50 MB body through CDP buys nothing the unit test doesn't. (3) fetchFile's tooBig.error is a raw byte count: in the rendering PR, say in fetchFile's header that callers map tooBig to their own text (Replika does). Rendering itself: Lila 11-26 'Show some': original_text only when it differs from text, emotion and diary reaction as small labels; category_id and edited stay in data.json.

0.6.4 (rendering PR): index.html shows original_text under a message when it differs from text, the message emotion and a diary entry's reaction as worded labels (AA 7.2-8.0:1 both themes, by luminance computation); category_id and edited stay data.json-only per Lila's 'Show some'. Review lows (1) and (3) from #185 done here: src/lib/limits.js holds the one 50 MB cap for Reddit and Replika; fetchFile's header says callers map tooBig. Left in TASK-38: (c) redirect manual, voice_message shape, fact category names — each needs a live save that shows it.

#186 review lows (PASS): (1) emotion showed beside the user's own messages: now the companion's only (README already says so), tested. (3) a whitespace-only change showed a before-line: compared trimmed now, data.json exact. (4) the 'edited' absence assertion keyed on wording: now asserts the memory's exact <li>. All in 0.6.5. (2) DEFERRED: hide a default/neutral emotion if most messages carry one — trigger: a live save shows what share of messages carry which emotion; then it is Lila's taste call, asked with the count.
<!-- SECTION:NOTES:END -->
