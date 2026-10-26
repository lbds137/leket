# Discord tools

A Chrome extension (Manifest V3) that saves a Discord DM, channel or thread — attachments
included — as one zip that opens offline. The collector reads the conversation from the open
Discord tab; the export tab fetches the attachments and builds the zip.

- Tests: `npm test` (node --test; the zip and build tests shell out to python3 for the zip check).
- Never commit a real conversation, person's name or attachment as a fixture.
- `src/collector.js` is mirrored in another repo: changes to it get messaged to the Jackalope
  session so its copy stays in step.
