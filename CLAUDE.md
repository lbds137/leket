# Leket

A Chrome extension (Manifest V3) with one module per site (`src/modules/registry.js`):
Discord, Etsy, Reddit, claude.ai sessions and claude.ai chat outputs. The Discord module
saves a DM, channel or thread — attachments included — as one zip that opens offline: the
collector reads the conversation from the open Discord tab; the export tab fetches the
attachments and builds the zip.

- Tests: `npm test` (node --test; the zip and build tests shell out to python3 for the zip check).
- Smoke: `npm run smoke` must be green before pushing any change to `src/background.js`, the popup,
  an offscreen document, an export/download path or a module's launch — the unit tests stub
  `chrome.*` and can't see wiring breaks. A new flow of that kind adds a scenario to
  `test/smoke/smoke.mjs`, and proves it by reddening it with the defect it guards. Exit 2 =
  no usable Chromium: set `LEKET_CHROME` or `npx playwright install chromium`, never skip it.
- Never commit a real conversation, person's name or attachment as a fixture.
- `src/modules/discord/collector.js` and the Etsy logic (`src/modules/etsy/`, per the header of
  `docs/etsy-script-spec.md`) are mirrored in another repo: a change to either goes, as its
  diff verbatim, into the Jackalope session's inbox file (the role file's Charter names it)
  so its copy stays in step.
