# Tools inventory: what moves into Leket (TASK-32)

Lila 11-25: stop keeping one-off scrapers and converters scattered across repos; anything that
belongs in a "pull it and make it readable" tool moves into Leket, on purpose, not as a
kitchen sink. This doc lists every candidate found on 2026-11-26 and recommends IN, OUT,
RETIRE (Leket already does it) or DEFERRED (with what promotes it). **The list is Lila's
call** (TASK-32 AC2); nothing below is built until she has ruled.

Public-repo rule: the candidates live in private repos. This doc names them by kind and
input format only; the exact script paths are kept privately with the Leket session.

## How the sweep was done

- Searched the project folders for scraper, exporter and `*2md` converter files by name
  (`find` over ~/Projects, node_modules, .git and worktrees skipped), then read each one.
- Checked overlaps against Leket's modules (`src/modules/`) and CLI (`bin/leket.js`).
- The Discord converters (A1, A2) read the fields Leket's collector writes (`author_id`,
  `author_username`, `reply_to`, `forwarded`, `forward_of`, `embeds`, `datetime`,
  `extracted_at`, `channel_id`: each one appears in `src/modules/discord/collector.js`).
  One extra field, `hand_added`, marks rows typed in by hand and is not Leket's.
- No converter exists for the claude.ai data export (`conversations.json` with
  `chat_messages`): searched for both names and for the upload index across the private
  chat archive's scripts; the same search finds the ChatGPT converter, so it works.

## Leket's shape for new work

- **Site modules** (extension) pull data with the tab's own sign-in. A new site adds host
  permissions, so Chrome asks every installed user to re-accept on update. That cost lands
  on Lila's friend, not just on Lila.
- **CLI** (`bin/leket.js`, `leket <site|convert> …`) runs from a shell. Converters belong here:
  no permissions, no friend-facing change.
- Converters take everything personal as flags (`--me NAME`, `--tz ZONE`, output folder).
  The private archive keeps a thin wrapper that calls `leket` with its own names, paths and
  folder layout (topic folders, indexes). Leket writes one plain Markdown per conversation;
  arranging files is the archive's job.

## Candidates

| # | Kind | Recommendation | Reason |
|---|---|---|---|
| A1 | Discord DM JSON → Markdown (replies, forwards, embeds, voice transcripts; per-year split) | **IN** — `leket convert discord` | Reads the same JSON Leket's Discord zip carries, so Leket's own saves get a readable transcript. Highest value: in active use (last changed 10-25); its saves come from a console copy of the collector, per the inventory read. |
| A2 | Discord channel JSON → monthly Markdown + participants table | **IN** — same command, `--by month` | Same input as A1; merge into one converter rather than two near-duplicates. Last changed 10-20; whether it still runs regularly is not confirmed. |
| B | ChatGPT export (`conversations.json`) → one Markdown per conversation | **IN** — `leket convert chatgpt` | Standard export format, small (≈70 lines), generic once the speaker label is a flag. |
| C | Gemini (Google Takeout My Activity JSON) → per-chat Markdown | **IN (core only)** — `leket convert gemini` | The Takeout parsing and chat rebuild are generic. Merging extra site dumps, topic folders and the HTML-to-Markdown step (pandoc in a container) stay in the private wrapper. Whether Leket can skip pandoc (the export holds HTML) is settled in its task. |
| D | Character-chat site: console export + JSON → Markdown | **IN, CLI converter now; site module DEFERRED** | The converter is generic. A site module means a re-accept prompt for the friend and naming the site in this public repo. Promote it when the console script breaks or Lila wants it in the toolbar. |
| E | Reddit post CLI (Markdown + image folder; `--from-json`) | **IN** — `leket reddit <url>` | The extension's Reddit module is already a port of this script's converter (`md.js`); the CLI half (images saved to disk, a reddit-*.json read from Downloads) is the only part left outside. One converter instead of two copies that can drift. |
| F | Reddit console snippet (save a post's JSON while signed in) | **RETIRE** | The extension's Reddit button does this (`json.js`). |
| G | claude.ai sessions export console script | **RETIRE** | Ported as the claude-sessions module. Its downstream split/archive pipeline (H) is separate. |
| H | Claude sessions split + weekly archive pipeline (JSONL parts → per-session transcripts, systemd timer) | **OUT** | A consumer of Leket's files, wired to one machine's archive and timer. The design note's CLI contract table keeps it reading Leket's saves unchanged. |
| I | claude.ai chat-outputs console script | **RETIRE** | Ported as the claude-chat module. |
| J | YouTube transcript + comments guide (manual console steps) | **RETIRE** | Leket's YouTube module (extension) and `leket youtube` (CLI) save captions and the comment tree, replies included. Reverses the design note's "stays a guide": the reason is that the module now exists. |
| K | Claude Code transcripts → topic-folder Markdown | **DEFERRED** | Generic input, but it lives inside the archive's folder layout and changed 11-10. Promote when a second consumer wants it, or when it next needs real work. |
| L | Historical chat-log converters: SMS backup XML, Signal, WhatsApp, AIM, Google Voice, Google Chat | **DEFERRED** | Each did a one-time import (last changed 10-05 to 10-18). Promote one when a fresh export of that kind arrives; moving them earlier is upkeep with no new use. |
| M | Screenshot OCR stitching, a bot-DM rebuild with voice transcription, a voice-clip fetcher, a mod-log → TSV converter, a DiscordChatExporter-HTML → text converter | **OUT** | One-off, tied to one dataset each. |
| N | claude.ai export → git-history replay (with a transcripts mode) | **OUT** | Built for one repo's import (git replay). The transcripts mode is the only generic piece; see O. |
| O | claude.ai data export → Markdown | **DEFERRED (gap, nothing to move)** | No converter exists; the export sits unconverted. Becomes `leket convert claude` when Lila wants that archive readable. |
| P | Chat-archive → memory-import JSON; a Discord server channel lister | **OUT** | Feed one bot project's import pipeline. |
| Q | Google Takeout extract/plan/verify family, Discord data-package unpacker | **OUT** (tentative, as listed in TASK-32) | They place Takeout contents into Drive folders against that project's own plan files and decisions; no conversion, and not usable standalone. |
| R | The Discord console mirror in the personal archive project | **Pending its owner's answer** | Asked 11-26 whether a `leket` zip + `leket convert discord` would let it retire the console copy. |

## If Lila rules as recommended

- Five IN items become tasks: A (A1+A2), B, C, D's converter, E; plus one task to tell each
  owner which scripts to retire (F, G, I, J now; A/B/C/D/E once each `leket` path ships).
- TASK-32 AC3 (a task per IN item, owners told) starts only after AC2 (her ruling).
- The design note's CLI contract table gains a `leket convert` row; its "stays a guide"
  line for the YouTube guide gets the retirement and this doc as the reason.
