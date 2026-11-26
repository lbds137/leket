---
id: TASK-38
title: >-
  Replika: media byte cap and final-host check, multi-part failure test, voice
  and fact-category follow-ups
status: To Do
assignee: []
created_date: '2026-11-26T04:20:00Z'
updated_date: '2026-11-26T04:30:00Z'
labels:
  - replika
dependencies: []
priority: low
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-ups from the TASK-33 live run. (1) A per-file media byte cap and a check that a fetch's final URL (after redirects) is still an allowed host. (2) A test for page.js's multi-part download failure message. (3) meta.voice_message showed up as an unread field on live messages; its shape is unknown (the account's served chat had no voice clips), so read it once a save shows one. (4) Facts carry category_id; memory/v3/unstructured_fact_categories looks like the name catalog (unconfirmed): resolve names if it is. Trigger: the next Replika change, or a save that shows a voice clip.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From PR #181's review: the new saved fields (original_text, emotion, diary reaction, fact category and edited) are in data.json but not rendered in index.html. original_text is the one a reader would most expect to see; render it (and the others where they read well) when this task is picked up, or settle that data.json alone is enough.
<!-- SECTION:NOTES:END -->
