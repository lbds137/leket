---
id: TASK-36
title: 'YouTube: transcript in a chosen language'
status: To Do
assignee: []
created_date: '2026-11-26T01:50:00Z'
labels: []
dependencies: []
priority: low
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lila 11-25 (AskUserQuestion): TASK-29 v1 ships the transcript in the language YouTube's panel picks (viewer UI language's track if present, else original), recorded in metadata. Chosen language is deferred here. Paths, both unproven (TASK-29 notes, Probes 2): (1) youtubei get_panel/get_transcript with a language param; probing it from Claude needs Lila's yes (classifier denied 11-25); (2) player capture via movie_player.setOption captions track + XHR hook, which saw 0-byte json3 bodies in the headless profile; retest in a visible window with her go-ahead. Trigger: the friend or Lila asks for a non-default language, or v1 ships and the queue is empty.
<!-- SECTION:DESCRIPTION:END -->
