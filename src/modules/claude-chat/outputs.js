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
import { assignedJson } from "../../lib/paste.js";

// The paste payload in any shape Deck's generator gives her: the whole generated file
// (the `window.CLAUDE_OUTPUT_CHATS = [...];` line, then the console outputs script),
// just that line, or the bare JSON array of [chat, name, source] triples — assignedJson
// strips the first two. Junk gets an error that says what to paste — the page has no
// console to decode a raw SyntaxError in.
export function parseChats(text) {
  const t = assignedJson(text, "CLAUDE_OUTPUT_CHATS");
  let list;
  try {
    list = JSON.parse(t);
  } catch {
    throw new Error("Couldn't parse the chat list. Paste the generated file as-is, the whole window.CLAUDE_OUTPUT_CHATS = [...]; line, or the bare JSON array of [chat, name, source] triples.");
  }
  const ok = Array.isArray(list)
    && list.every((e) => Array.isArray(e) && e.length === 3 && typeof e[0] === "string");
  if (!ok) throw new Error("The chat list isn't [[chat, name, source], ...] triples. Paste the generated file as-is, the whole window.CLAUDE_OUTPUT_CHATS = [...]; line, or the bare JSON array.");
  // a chat id goes straight into the conversation URL, so anything that isn't a chat
  // uuid — a path traversal, a stray paste, an injection — is refused here, before
  // any fetch
  const bad = list.find((e) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e[0]));
  if (bad) {
    throw new Error(`"${bad[0]}" doesn't look like a chat id. Ids are 8-4-4-4-12 hex-and-dash uuids — paste the generated file as-is.`);
  }
  if (!list.length) throw new Error("The chat list is empty. Paste the generated file as-is, the whole window.CLAUDE_OUTPUT_CHATS = [...]; line, or the bare JSON array of [chat, name, source] triples.");
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
export async function collectChats(chats, { fetch: doFetch = fetch, orgPath, onProgress, timeoutMs = 60_000 } = {}) {
  // A fresh signal per request: a hung request fails its chat instead of holding the
  // run, and its button, forever. The timeout is an idle one: every body chunk re-arms
  // it, so a large file on a slow link finishes as long as bytes keep coming, and only
  // timeoutMs with no data at all ends it. `step` names where a timeout landed,
  // including the file's path (the engine's wording says neither). Whether the timer
  // fired is kept in a flag, not read back from the error: an engine that errors the
  // body with a plain AbortError instead of the abort's reason still reports a timeout.
  let step = "";
  const request = async (url, label, read) => {
    step = label;
    const ctl = new AbortController();
    let timer, timedOut = false;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort(new DOMException(`${label} timed out`, "TimeoutError"));
      }, timeoutMs);
    };
    touch();
    try {
      const r = await doFetch(url, { credentials: "include", signal: ctl.signal });
      if (!r.ok) {
        // the error body is never read: cancel it so it doesn't hold the connection
        r.body?.cancel?.().catch(() => {});
        throw new Error(`${r.status} ${url.split("/wiggle/")[1] || url}`);
      }
      touch();
      return await read(r, touch);
    } catch (err) {
      if (timedOut) throw new DOMException(`${label} timed out`, "TimeoutError");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  // the body chunk by chunk, re-arming the idle timer on each; a response with no
  // readable body (a null-body one) falls back to blob() or json()
  const readJson = async (r, touch) =>
    r.body?.getReader ? JSON.parse(await (await readBlob(r, touch)).text()) : r.json();
  const readBlob = async (r, touch) => {
    if (!r.body?.getReader) return r.blob();
    const reader = r.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new Blob(chunks);
      chunks.push(value);
      touch();
    }
  };
  const results = [];
  let fileCount = 0, failed = 0;
  for (const [i, [chat, name, source]] of chats.entries()) {
    const base = orgPath + "conversations/" + chat + "/wiggle/";
    const entry = { chat, name, source, files: [] };
    try {
      const listing = await request(base + "list-files?prefix=", "list-files", readJson);
      if (!Array.isArray(listing?.files_metadata)) {
        throw new Error("list-files: no files_metadata (the API shape changed)");
      }
      for (const meta of listing.files_metadata) {
        // an entry with no path can't be fetched or placed: skip it, counted on the
        // entry, rather than let it end the chat with a TypeError
        if (typeof meta?.path !== "string") { entry.no_path = (entry.no_path || 0) + 1; continue; }
        if (!meta.path.startsWith("/mnt/user-data/outputs/")) continue;
        const blob = await request(base + "download-file?path=" + encodeURIComponent(meta.path),
          `download-file ${meta.path}`, readBlob);
        const file = { path: meta.path, size: meta.size, created_at: meta.created_at, content_type: meta.content_type };
        const text = isText(meta.path, meta.content_type) ? await asText(blob) : null;
        if (text !== null) file.text = text;
        else file.base64 = await toBase64(blob);
        // the listed size is checked only when the listing gives one: a whole byte
        // count, as a number or a string of digits. A missing or odd size (null, "3 B",
        // 3.5, -1) can't be compared, and flagging it would turn every clean run
        // yellow; file.size keeps the listing's raw value.
        const n = typeof meta.size === "string" && /^\d+$/.test(meta.size) ? Number(meta.size) : meta.size;
        const listed = Number.isSafeInteger(n) && n >= 0 ? n : null;
        if (listed !== null && blob.size !== listed) file.size_mismatch = blob.size;
        entry.files.push(file);
        fileCount++;
      }
    } catch (err) {
      entry.error = err?.name === "TimeoutError" ? `${step} timed out: no data for ${timeoutMs / 1000} s` : err.message;
      failed++;
    }
    results.push(entry);
    if (onProgress) onProgress(i + 1, chats.length, fileCount);
  }
  return { results, fileCount, failed };
}

// The end line of a saved run. Anything the file carries that isn't a clean save — a
// failed chat, a file that arrived at another size than listed (size_mismatch, which
// can be 0), a listed file with no path — turns it into a warning that names it.
export function doneLine({ chats, fileCount, results, filename }) {
  const failedChats = results.filter((r) => r.error).length;
  const mismatched = results.reduce((n, r) => n + r.files.filter((f) => f.size_mismatch != null).length, 0);
  const noPath = results.reduce((n, r) => n + (r.no_path || 0), 0);
  const text = `Done: ${chats} chats, ${fileCount} files saved to ${filename}.`
    + (failedChats ? ` ${failedChats} chat(s) failed — their entries carry an "error".` : "")
    + (mismatched ? ` ${mismatched} file(s) arrived at a different size than listed — they carry "size_mismatch".` : "")
    + (noPath ? ` ${noPath} listed file(s) had no path and were skipped — counted in "no_path".` : "");
  return { text, warn: Boolean(failedChats || mismatched || noPath) };
}

// the script's own name: the UTC date, not the local one — an evening save and its
// CLI consumer must agree on which day the file is from
export const outputsName = (date = new Date()) =>
  `claude-chat-outputs-${date.toISOString().slice(0, 10)}.json`;
