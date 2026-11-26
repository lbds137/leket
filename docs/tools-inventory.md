# Tools inventory: what moves into Leket (TASK-32)

Lila 11-25: stop keeping one-off scrapers and converters scattered across repos; anything that
belongs in a "pull it and make it readable" tool moves into Leket, on purpose, not as a
kitchen sink. This doc lists every candidate found on 2026-11-26 and recommends IN, OUT,
RETIRE (Leket already does it) or DEFERRED (with what promotes it). **Lila ruled on it
2026-11-26** (TASK-32 AC2; see Ruling below); the IN rows are TASK-32.1 to 32.12.

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
| B | ChatGPT export (`conversations.json`) → one Markdown per conversation | **IN, shipped 0.9.0** — `leket convert chatgpt` | Standard export format, small (≈70 lines), generic once the speaker label is a flag. 0.11.1 renames a conversation whose title holds `* ? " < > |`: each becomes `-` (Windows and FAT, exFAT or SMB disks refuse them), and `--folders` refuses a folder holding one; not measured on the real export. |
| C | Gemini (Google Takeout My Activity JSON) → per-chat Markdown | **IN (core only), shipped 0.10.0** — `leket convert gemini` | The Takeout parsing and chat rebuild are generic. Merging extra site dumps and the topic folders stay in the private wrapper (`--folders`, `--titles` and extra row files are its seams). No pandoc: Leket's own HTML-to-Markdown kept every letter and digit of the 443 real replies pandoc 3.7 converted, 263 of them byte for byte in 0.10.0; the rest differ only in layout (list indents, fences, empty links). 0.11.0 changed 5 of the 90 files that Takeout makes, in whitespace and one backslash only: code keeps its trailing spaces, and a pipe in a row title is escaped. 0.11.1 can change a reply holding a link to a scheme other than http(s), mailto or a scripted one (tel:, ftp:, sms:…): its address now follows the label as text instead of being dropped; not measured on the real Takeout. 0.12.0 drops every control character from that address as shown (0.11.1 dropped only tabs and line breaks). Names are unchanged (they never held `* ? " < > |`). |
| D | Character-chat site: console export + JSON → Markdown | **IN, shipped 0.11.0** — `leket convert character-chat`; **site module DEFERRED** | The converter is generic (the site's name is a flag). On the real export it matched the private converter file for file (141 files, 0 renamed) apart from its deliberate differences. 0.11.1 escapes Markdown characters in names, labels, creators and titles (they show as written), writes "undated" for a missing time, leaves out a blank creator or title, and takes the copy with the most message objects when exports overlap; file names are unchanged. 0.12.0 keeps a name, persona, label, creator or title holding a line break on its one line (the break becomes a space), and keeps a heading's trailing `#`; not measured on the real export. A site module means a re-accept prompt for the friend and naming the site in this public repo. Promote it when the console script breaks or Lila wants it in the toolbar. |
| E | Reddit post CLI (Markdown + image folder; `--from-json`) | **IN, shipped 0.8.0** — `leket reddit <url>` | The extension's Reddit module is already a port of this script's converter (`md.js`); the CLI half (images saved to disk, a reddit-*.json read from Downloads) is the only part left outside. One converter instead of two copies that can drift. |
| F | Reddit console snippet (save a post's JSON while signed in) | **RETIRE** | The extension's Reddit button does this (`json.js`). |
| G | claude.ai sessions export console script | **RETIRE** | Ported as the claude-sessions module. Its downstream split/archive pipeline (H) is separate. |
| H | Claude sessions split + weekly archive pipeline (JSONL parts → per-session transcripts, systemd timer) | **OUT** | A consumer of Leket's files, wired to one machine's archive and timer. The design note's CLI contract table keeps it reading Leket's saves unchanged. |
| I | claude.ai chat-outputs console script | **RETIRE** | Ported as the claude-chat module. |
| J | YouTube transcript + comments guide (manual console steps) | **RETIRE** | Leket's YouTube module (extension) and `leket youtube` (CLI) save captions and the comment tree, replies included. Reverses the design note's "stays a guide": the reason is that the module now exists. |
| K | Claude Code transcripts → topic-folder Markdown | **IN, shipped 0.12.0** — `leket convert claude-code` | Generic: one Markdown file per session (`--json` writes the turns instead). The stretches picked out of a session, name redaction and the topic folders stay in the private wrapper, which can build on `--json`. On 14 real transcripts (1,767 turns, up to 150 MB) the port's turns matched the private converter's turn for turn, apart from its deliberate differences: a multi-choice answer lists its choices instead of a Python list's repr, and a record of an unexpected shape is passed over instead of stopping the run. No sampled transcript held subagent records inline, so only the tests cover skipping them. |
| L | Historical chat-log converters: SMS backup XML, Signal, WhatsApp, AIM, Google Voice, Google Chat | **IN** (ruled; recommended DEFERRED) — one `leket convert <format>` each; **SMS shipped 0.13.0** (`leket convert sms`) | Each did a one-time import (last changed 10-05 to 10-18). Recommended waiting for a fresh export; Lila ruled them in now, so the next export of any of these kinds converts with Leket. SMS: one file per conversation (the original wrote one chosen by number; `--number`, `--title`, `--base`, `--me` and `--name` reproduce it). On a synthetic backup covering every case the original handles, the port's `--number` render, with and without `--groups`, matched the original line for line apart from the generic source line, the zone's name and a final line break; the saved attachments matched name for name and md5 for md5. Not run on the real backup (the private wrapper's job). XML is read by Leket's own streaming reader (`src/lib/xml.js`), which also accepts the surrogate-pair references that expat refuses. |
| M | Screenshot OCR stitching, a bot-DM rebuild with voice transcription, a voice-clip fetcher, a mod-log → TSV converter, a DiscordChatExporter-HTML → text converter | **OUT** | One-off, tied to one dataset each. |
| N | claude.ai export → git-history replay (with a transcripts mode) | **OUT** | Built for one repo's import (git replay). The transcripts mode is the only generic piece; see O. |
| O | claude.ai data export → Markdown | **DEFERRED (gap, nothing to move)** | No converter exists; the export sits unconverted. Becomes `leket convert claude` when Lila wants that archive readable. |
| P | Chat-archive → memory-import JSON; a Discord server channel lister | **OUT** | Feed one bot project's import pipeline. |
| Q | Google Takeout extract/plan/verify family, Discord data-package unpacker | **OUT** (tentative, as listed in TASK-32) | They place Takeout contents into Drive folders against that project's own plan files and decisions; no conversion, and not usable standalone. |
| R | The Discord console mirror in the personal archive project | **Pending its owner's answer** | Asked 11-26 whether a `leket` zip + `leket convert discord` would let it retire the console copy. |

## Ruling (Lila 2026-11-26)

"Wider: historical too": everything recommended IN, plus K and L. O (the claude.ai export
converter) stays DEFERRED; D's site module stays DEFERRED; OUT rows stay OUT.

- Each IN item has its own task: A (A1+A2 as one command), B, C, D's converter, E, K, and
  each of L's six formats.
- Owners are told to retire G, I and J now (Leket already ships their paths). F waits for E,
  because the Reddit CLI's error hint points at F; each converter's original is retired
  once its `leket` command ships.
- The design note's CLI contract table gains a `leket convert` row; its "stays a guide"
  line for the YouTube guide gets the retirement and this doc as the reason.
