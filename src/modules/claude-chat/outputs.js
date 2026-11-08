// The chat-outputs half, ported from dev-docs/browser/claude-chat-outputs.js — the
// script is the spec. GET .../conversations/<chat>/wiggle/list-files?prefix= lists a
// chat's uploads and outputs; GET .../wiggle/download-file?path=<full path> serves the
// file's current, i.e. final, contents. Everything under /mnt/user-data/outputs/ in
// each listed chat is downloaded — text inline, the rest base64 — into one dated JSON.
// No pacing: the script has none (invariant 6 — ported modules default to no pause).
//
// One entry's whole fetch chain sits in one try/catch, exactly as the script runs it:
// a failure sets entry.error and keeps whatever files already arrived, so partial
// files and the error coexist in the same entry.

// The paste payload in either shape Deck's generator emits: the bare JSON array of
// [chat, name, source] triples, or the whole `window.CLAUDE_OUTPUT_CHATS = [...];`
// line. Junk gets an error that says what to paste — the page has no console to
// decode a raw SyntaxError in.
export function parseChats(text) {
  let t = String(text ?? "").trim();
  const m = /^window\.CLAUDE_OUTPUT_CHATS\s*=\s*([\s\S]*)$/.exec(t);
  if (m) t = m[1].trim();
  t = t.replace(/;\s*$/, "");
  let list;
  try {
    list = JSON.parse(t);
  } catch {
    throw new Error("Couldn't parse the chat list. Paste either the bare JSON array of [chat, name, source] triples or the whole window.CLAUDE_OUTPUT_CHATS = [...]; line.");
  }
  const ok = Array.isArray(list)
    && list.every((e) => Array.isArray(e) && e.length === 3 && typeof e[0] === "string");
  if (!ok) throw new Error("The chat list isn't [[chat, name, source], ...] triples — paste the generated file as-is (the bare JSON array, or the whole window.CLAUDE_OUTPUT_CHATS = [...]; line).");
  // a chat id goes straight into the conversation URL, so anything that isn't a chat
  // uuid — a path traversal, a stray paste, an injection — is refused here, before
  // any fetch
  const bad = list.find((e) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e[0]));
  if (bad) {
    throw new Error(`"${bad[0]}" doesn't look like a chat id. Ids are 8-4-4-4-12 hex-and-dash uuids — paste the generated file as-is.`);
  }
  if (!list.length) throw new Error("The chat list is empty — paste the generated file: the bare JSON array of [chat, name, source] triples.");
  return list;
}

// the script's own split: a text content type, or a text extension, lands in the entry
// as text; anything else (a png, a pdf, a docx) rides as base64. The type match is
// anchored to the whole media type: a bare `xml` would also match the Office types
// (…wordprocessingml.document, …spreadsheetml.sheet), whose zip bytes a text decode corrupts.
export function isText(path, type) {
  return /^(text\/|application\/(json|jsonl|json5|x-jsonlines|xml|yaml|x-yaml|javascript|x-javascript|ecmascript|x-ndjson)\s*(;|$)|[\w.-]+\/[\w.-]+\+(json|xml)\s*(;|$))/i.test(type || "") ||
    /\.(json|jsonl|json5|md|txt|csv|tsv|yaml|yml|html|xml|js|py|sh)$/i.test(path);
}

// a text label (or a text extension, which wins over the type) is a claim, not a
// guarantee: bytes that are not valid UTF-8 return null and go to base64. A leading
// BOM is stripped, as blob.text() did: readers JSON-parse a .json output's text.
export async function asText(blob) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

// the script's chunked base64: String.fromCharCode takes a bounded argument list, so
// the bytes go through 0x8000-wide slices — a pdf big enough to hit the limit must
// still encode whole
export async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The org probe. DELIBERATELY self-contained — no imports, no closures: the page
// hands this function to chrome.scripting.executeScript, which serializes its
// source, and an imported regex or helper would be undefined at the other end.
// It reads the browser's own resource timeline: any API call this claude.ai tab
// has made carries the org id in its URL.
export function readOrgPath() {
  const entries = performance.getEntriesByType("resource");
  for (const e of entries) {
    const m = e.name.match(/\/api\/organizations\/[0-9a-f-]{36}\//);
    if (m && m[0]) return m[0];
  }
  return null;
}

// The probe's capture is a relative /api/... prefix — correct only on the claude.ai
// tab itself, where the console script ran. This page fetches from the extension
// page instead, where a relative URL would resolve against chrome-extension://, so
// the tab's origin goes back in front before any fetch.
export const absolutizeOrgPath = (tabUrl, orgPath) => new URL(tabUrl).origin + orgPath;

// The run: per chat, list the sandbox, download each outputs/ file, valid UTF-8 text
// inline and the rest (binary, or a text label over bytes that aren't UTF-8) base64.
// A chat's failure is recorded on its entry (partial files kept) and the walk moves
// on; onProgress(done, total, fileCount) fires after each chat.
export async function collectChats(chats, { fetch: doFetch = fetch, orgPath, onProgress } = {}) {
  const get = async (url) => {
    const r = await doFetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`${r.status} ${url.split("/wiggle/")[1] || url}`);
    return r;
  };
  const results = [];
  let fileCount = 0, failed = 0;
  for (const [i, [chat, name, source]] of chats.entries()) {
    const base = orgPath + "conversations/" + chat + "/wiggle/";
    const entry = { chat, name, source, files: [] };
    try {
      const listing = await (await get(base + "list-files?prefix=")).json();
      if (!Array.isArray(listing?.files_metadata)) {
        throw new Error("list-files: no files_metadata (the API shape changed)");
      }
      for (const meta of listing.files_metadata) {
        if (!meta.path.startsWith("/mnt/user-data/outputs/")) continue;
        const blob = await (await get(base + "download-file?path=" + encodeURIComponent(meta.path))).blob();
        const file = { path: meta.path, size: meta.size, created_at: meta.created_at, content_type: meta.content_type };
        const text = isText(meta.path, meta.content_type) ? await asText(blob) : null;
        if (text !== null) file.text = text;
        else file.base64 = await toBase64(blob);
        if (blob.size !== meta.size) file.size_mismatch = blob.size;
        entry.files.push(file);
        fileCount++;
      }
    } catch (err) {
      entry.error = err.message;
      failed++;
    }
    results.push(entry);
    if (onProgress) onProgress(i + 1, chats.length, fileCount);
  }
  return { results, fileCount, failed };
}

// the script's own name: the UTC date, not the local one — an evening save and its
// CLI consumer must agree on which day the file is from
export const outputsName = (date = new Date()) =>
  `claude-chat-outputs-${date.toISOString().slice(0, 10)}.json`;
