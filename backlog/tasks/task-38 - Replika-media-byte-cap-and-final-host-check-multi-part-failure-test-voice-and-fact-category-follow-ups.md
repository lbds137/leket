---
id: TASK-38
title: >-
  Replika: media byte cap and final-host check, multi-part failure test, voice
  and fact-category follow-ups
status: To Do
assignee: []
created_date: '2026-11-26T04:20:00Z'
updated_date: '2026-11-26T04:37:00Z'
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
<!-- SECTION:NOTES:END -->
