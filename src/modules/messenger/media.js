// The Messenger export tab's media bookkeeping, apart from the page so tests can run it:
// which files the save lists, reading one file from the Messenger tab's bridge, and
// settling the save's media lists against what the zip holds.
import { crc32 } from "../../lib/zip.js";

export function decodeBase64(b64) {
  if (!b64) return new Uint8Array(0);
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const kindOf = (med) => (med && med.kind === "video" ? "video" : "photo");

// Names are compared with case folded: a zip unpacked on macOS or Windows puts a.JPG and
// a.jpg in one file.
export const foldName = (name) => name.toLowerCase();

export const messagesOf = (exp) => (Array.isArray(exp.messages) ? exp.messages : []).filter((m) => m && typeof m === "object");

// Every media file the save lists, by folded name → { name, m, med }: the first entry for a
// name wins; an invalid or repeated name becomes a not-captured entry on its own message.
export function listMedia(exp, validMediaName) {
  const listed = new Map();
  const notCaptured = [];
  for (const m of messagesOf(exp)) {
    if (!Array.isArray(m.media)) {
      m.media = [];
      continue;
    }
    for (const med of m.media) {
      const name = med && med.file;
      if (validMediaName(name) && !listed.has(foldName(name))) listed.set(foldName(name), { name, m, med });
      else notCaptured.push({ message_id: m.id ?? null, kind: kindOf(med), reason: `invalid or repeated media file name "${name}"` });
    }
  }
  return { listed, notCaptured };
}

// Reads file `index` from the bridge, slice by slice. `accept(name)` says whether the
// save lists that name and it hasn't come yet. Resolves to one of:
//   { status: "saved", name, data, crc }  data: a Uint8Array (one slice, crc undefined)
//                                         or a Blob with its running crc32
//   { status: "failed", name, reason }    the file named itself, then a slice failed
//   { status: "error", reason }           no usable name: shown on the page only
//   { status: "gone", reason }            the bridge no longer holds this save
//   { status: "tab-gone", name, reason }  the Messenger tab stopped answering at all
export async function readMediaFile(ask, index, accept) {
  let name = null;
  const call = async (offset) => {
    try {
      return { r: await ask({ type: "leket:file", index, offset }) };
    } catch (e) {
      return { thrown: (e && e.message) || String(e) };
    }
  };
  const tabGone = (why) => ({ status: "tab-gone", name, reason: `the Messenger tab stopped answering (${why})` });

  const { r: first, thrown } = await call(0);
  if (thrown) return tabGone(thrown);
  if (first && first.gone) return { status: "gone", reason: first.error };
  if (!first || first.error) return { status: "error", reason: `media file ${index + 1}: ${(first && first.error) || "unreadable"}` };
  if (typeof first.name !== "string" || !accept(first.name)) {
    return { status: "error", reason: `media file ${index + 1}: "${first.name}" is not in the save's list, or came twice; skipped` };
  }
  name = first.name;
  const size = first.size;
  if (!Number.isSafeInteger(size) || size < 0) return { status: "failed", name, reason: `file ${name} gave no usable size` };
  // a malformed slice fails this file by name (null), not as an unnamed read error
  const decode = (b64) => {
    try {
      return decodeBase64(b64);
    } catch {
      return null;
    }
  };
  const badSlice = (offset, what) => ({ status: "failed", name, reason: `file ${name} ${what} at offset ${offset} of ${size}` });

  const chunk0 = decode(first.data);
  if (!chunk0) return badSlice(0, "sent bad base64");
  if (!chunk0.byteLength && size > 0) return badSlice(0, "returned 0 bytes");
  if (chunk0.byteLength > size) return { status: "failed", name, reason: `file ${name} sent more than its ${size} bytes` };
  const chunks = [chunk0];
  let crc = crc32(chunk0, 0);
  let offset = chunk0.byteLength;
  while (offset < size) {
    const { r: next, thrown: lost } = await call(offset);
    if (lost) return tabGone(lost);
    if (next && next.gone) return { status: "gone", reason: next.error };
    if (!next || next.error) return { status: "failed", name, reason: (next && next.error) || `file ${name} stopped at ${offset} of ${size} bytes` };
    if (next.name !== name) return { status: "failed", name, reason: `file ${name} turned into "${next.name}" at offset ${offset}` };
    const bytes = decode(next.data);
    if (!bytes) return badSlice(offset, "sent bad base64");
    if (!bytes.byteLength) return badSlice(offset, "returned 0 bytes");
    if (offset + bytes.byteLength > size) return { status: "failed", name, reason: `file ${name} sent more than its ${size} bytes` };
    crc = crc32(bytes, crc);
    offset += bytes.byteLength;
    chunks.push(bytes);
  }
  if (chunks.length === 1) return { status: "saved", name, data: chunks[0], crc: undefined };
  return { status: "saved", name, data: new Blob(chunks), crc };
}

// After the reads: every listed file the zip doesn't hold becomes a not-captured entry on
// its message, and each message keeps only the media entries the zip holds — by identity,
// so a repeated name's second entry goes too. `saved` and `whyNot` are keyed by folded
// name; `fallback` is the reason for a file nobody said anything about.
export function settleMedia(exp, listed, saved, whyNot, notCaptured, fallback = "not handed over by the Messenger tab") {
  for (const [folded, { m, med }] of listed) {
    if (saved.has(folded)) continue;
    notCaptured.push({ message_id: m.id ?? null, kind: kindOf(med), reason: whyNot.get(folded) || fallback });
  }
  for (const m of messagesOf(exp)) {
    m.media = m.media.filter((med) => med && typeof med.file === "string"
      && saved.has(foldName(med.file)) && listed.get(foldName(med.file))?.med === med);
  }
  exp.media_not_captured = notCaptured;
}
