# Leket design note

Leket (לקט, "gleaning") turns this repo from a Discord-only extension into one generic
browser-tools extension: the toolbar popup detects what the current tab supports and offers
that site's commands. The Discord collector that is the whole extension today becomes one
module among several; the paste-in console scripts in dev-docs/browser/ become the others.
Spec: dev-docs BACKLOG.md Inbox, "One browser-tools extension" (Lila 11-04).

## What stays true

- One MV3 extension, unpacked, no build step; manifest.json keeps listing plain files.
- A module works from the tab's own session: fetches go out with `credentials: "include"`
  against host_permissions origins. No tokens, no copied cookies.
- Destructive and bulk flows keep the scripts' proven guards (see Invariants).

## Module layout

    src/
      background.js        — tab opening + badge flags (today's file, extended)
      popup/               — popup.html/js: detect tab → render module card → launch
      modules/
        registry.js        — [{ id, matches(url), page, title, blurb }]
        discord/           — bridge.js, collector.js (moved), export.js
        claude-sessions/   — export.js, rename.js, delete.js
        claude-chat/       — outputs.js
        reddit/            — json.js
        etsy/              — messages.js (recipe from Jackalope; script text pending)
      lib/                 — build, download, files, render, summary, zip (today's lib)
                             + paging.js (cursor/offset loops), rest.js (jitter + rest, from #16–18)

Two run homes, because an MV3 popup closes the moment it loses focus:

- **Popup** — detects the active tab, renders that module's card, launches. One-shot
  commands that finish in seconds can run inside it (reddit is one fetch).
- **Extension page (tab)** — every long or reviewable flow opens its own page, like
  today's export tab: sessions export (150 MB part files, resume, incremental input),
  rename (progress + failure list), delete (dry run → confirm count → progress),
  chat outputs (per-chat progress), discord (the existing export flow).

The service worker never carries a long run: pages own their loops; the worker opens tabs
and sets badges, as background.js does now.

DOM-reading modules keep the inject pattern — the collector runs in the page's MAIN world
because Discord's message objects live on its React elements. API-only modules need no page
access at all: an extension page's fetch with host_permissions carries the session cookies.
One exception: the chat-outputs module finds the organization id in the claude.ai tab's own
`performance` entries, so it injects a one-liner into the active tab to read it — an
extension page's `performance` has nothing.

## The modules

Each ports its script's behavior as-is — the scripts are the spec; tuning comes later, on
evidence.

- **Discord** — today's extension, re-homed under modules/discord/, behavior unchanged.
- **Claude sessions** (claude.ai/code pages) — three commands:
  - *Export*: lists active + paused + archived sessions (statuses, cursor paging), fetches
    each session's events, flushes part files at ~150 MB always at a session boundary, then
    saves the done marker. Inputs: the incremental payload
    (`claude-sessions-split --incremental-js` generates it), a resume skip-list and a part
    start number. Filenames unchanged.
  - *Rename*: paste the generated rename list (today's `window.CLAUDE_RENAMES = [...]`
    line). First rename must be a real change — otherwise the read-back proves nothing —
    and every rename is read back.
  - *Delete*: title-prefix input; dry run always first, confirm by the count it printed
    (a stale count refuses), first delete verified gone by read-back before the rest.
- **Claude chat outputs** (claude.ai/chat pages) — paste the generated chat list
  (`window.CLAUDE_OUTPUT_CHATS` line); lists and downloads each chat's
  /mnt/user-data/outputs/ files, text inline, the rest base64, into one dated JSON.
- **Reddit** (post pages) — fetch `/comments/<id>.json?raw_json=1&limit=500`, save
  `reddit-<id>.json`. Runs in the popup.
- **Etsy** — pages the same-origin message-list API (`offset` + `fetch_older`, dedupe on
  `conversation_message_id`), saves one JSON per conversation via a download. Script text
  pending from Jackalope; personal-data specifics get parameterized, not copied.

## The popup

Click → popup queries the active tab → `registry.match(url)` renders one module card:
title, one-line blurb, its command buttons. No match → the list of supported sites. Long
flows open their page next to the active tab (background.js already does this for the
export tab). Today's click-to-inject on a Discord tab becomes click → popup → panel: one
extra click, one consistent entry point for every site. The manifest gains
`action.default_popup`; `chrome.action.onClicked` stops firing once a popup exists, so the
badge-flag helper moves behind the popup's launch path.

## The CLI contract

The headline: **the CLI tools change nothing.**

| Saved file (same name, same ~/Downloads) | CLI that reads it |
|---|---|
| `claude-sessions-<run>-partNN.jsonl`, `-done.json` | bin/claude-sessions-weekly → claude-sessions-split |
| `reddit-<post id>.json` | `reddit-export --from-json` |
| `claude-chat-outputs-<date>.json` | read directly (no tool wired yet) |

`chrome.downloads.download` with `saveAs: false` lands in ~/Downloads under the given
filename — the same place the scripts' Blob-plus-click put it. The paste payloads keep
their exact shapes so Deck's generators emit the same lines; the input boxes accept both
the bare JSON and the full `window.X = {...};` line and parse the payload out.

## Invariants (each gets a red-first test)

1. Part flush at session boundaries only; never join a whole export into one string
   (V8 caps strings near 0.5–1 GB; the first full export was 1.5 GB+).
2. A session's lines join a part only after all of its pages arrived.
3. The done marker is written last — a pause mid-export never splits half a run.
4. Rename: the first rename must change a title; every rename is read back; a failed
   first rename stops the list.
5. Delete: dry run by default; the confirm count must match the current count; the first
   delete is verified gone before the rest run.
6. Pacing (`rest.js`) defaults to off for the ported modules, matching the scripts'
   behavior today; the Discord module keeps its proven #16–18 defaults.

## Open

- **The rename** (repo + manifest name → Leket): waits on Lila. The technical answer is
  "no breakage": an unpacked extension's identity is its local path, so Charles's installed
  0.2.4 keeps working untouched; a later Leket install appears as a new entry and the old
  folder gets removed. Her decision is what Charles receives, and when.
- **Etsy script text** — requested from Jackalope (its repo is personal-data; never read
  from this session).
- **Out of scope by spec**: youtube-extractor-guide.md stays a guide, not a module — noted
  here so it isn't lost; promoting it is Lila's call.
