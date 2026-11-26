---
id: TASK-32.13
title: 'convert gemini: a chat mapped to the canvas folder can overwrite a canvas file'
status: To Do
assignee: []
created_date: '2026-11-26T15:48:00Z'
labels: []
dependencies: []
parent_task_id: TASK-32
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From #202 claude-review (low, filed because it loses data silently). In src/convert/gemini.js plan(), chat names (taken) and canvas names (takenCanvas) are de-duplicated separately. With --folders mapping a chat to 'canvases' (or <other>/canvases), a chat whose first prompt matches a same-day canvas title gets the same folder/name, and writeConverted writes the canvas over the chat. Reviewer reproduced it with folders {abc: canvases}. Fix: one taken set across both kinds keyed by folder/name, or refuse a --folders value equal to the canvas folder; add a test.
<!-- SECTION:DESCRIPTION:END -->
