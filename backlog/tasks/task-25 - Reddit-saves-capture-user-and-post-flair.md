---
id: TASK-25
title: 'Reddit saves: capture user and post flair'
status: Done
assignee: []
created_date: '2026-11-20T19:02:00Z'
updated_date: '2026-11-20T19:09:00Z'
labels:
  - enhancement
dependencies: []
priority: medium
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lila 11-20 (via Chats). Reddit saves drop flair: no "flair" anywhere in src/ (checked 11-20). Comment header is built at src/modules/reddit/md.js:667 (**u/author** · score · time), post header at md.js:696. Reddit JSON carries author_flair_text plus author_flair_richtext (parts {e:"text",t} or {e:"emoji",a,u}); posts also carry link_flair_text / link_flair_richtext. Render flair next to the author (and post flair on the post header) through the same plain() escaping as other JSON fields; prefer richtext when present (emoji parts as their :alias: text), fall back to *_flair_text, omit when empty.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Comment headers show the author's flair when present, nothing extra when absent
- [x] #2 Post headers show author flair and post (link) flair when present
- [x] #3 Flair text goes through plain() escaping; tests cover text, richtext with emoji, and no-flair cases
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped in #157; review fixes (flair markdown escaping, header note, two tests) in the follow-up PR task-25-review-fixes.
<!-- SECTION:FINAL_SUMMARY:END -->
