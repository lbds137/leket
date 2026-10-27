// Which attachments an export holds and the name each is saved under, in the layout
// fetch_discord_attachments.py has always written: discord-attachments/ beside the JSON, as
// <date>_<message id>_<n>_<filename>, and discord-attachments.json mapping each file back to
// its message. A forwarded message's attachments are <date>_<message id>_f<k>_<n>_<filename>.

import { PART_LIMIT } from "./zip.js";

export const FOLDER = "discord-attachments";
export const MANIFEST = "discord-attachments.json";
// the only hosts Discord serves attachments from; anything else in an export is not fetched
const HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

const utf8 = new TextEncoder();

// a filename may hold 255 bytes; 240 leaves room, as the Python fetcher did
export function fileName(prefix, filename) {
  const clean = String(filename || "file").replace(/[^\p{L}\p{N}\p{M}_.-]+/gu, "_");
  const dot = clean.lastIndexOf(".");
  let [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
  if (utf8.encode(ext).length > 40) [stem, ext] = [clean, ""];
  const room = 240 - utf8.encode(prefix).length - utf8.encode(ext).length;
  while (utf8.encode(stem).length > room) stem = [...stem].slice(0, -1).join("");
  return prefix + stem + ext;
}

export function fetchable(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// whether the attachments alone would not comfortably fit one part, so the save streams a
// part at a time instead of building every part before any is downloaded. A size Discord
// didn't give makes the estimate untrusted on its own, so the save streams; the 4 MiB per
// unknown used in the export tab's disk warning lives there, not here. The margin leaves
// room for the JSON, the page and zip overhead.
export function needsParts(records, partLimit = PART_LIMIT) {
  if (!records.length) return false;
  let bytes = 0;
  for (const r of records) {
    if (r.size == null) return true;
    bytes += Number(r.size) + 128;
  }
  return bytes > partLimit - 64 * 1024 * 1024;
}

// one entry per attachment: {message_id, filename, url, file, size?, forwarded?}; file is
// the name inside FOLDER, size the bytes Discord said the file is (absent when it didn't
// say — an old export, or an attachment kind without one)
export function attachmentList(exp) {
  const out = [];
  for (const m of exp.messages || []) {
    const day = String(m.datetime || "").slice(0, 10);
    const add = (list, mid, extra) => (list || []).forEach((a, n) => {
      out.push({ message_id: m.id, filename: a.filename, url: a.url,
        file: fileName(`${day}_${m.id}_${mid}${n}_`, a.filename),
        ...(a.size != null ? { size: Number(a.size) } : {}), ...extra });
    });
    add(m.attachments, "", {});
    (m.forwarded || []).forEach((f, k) => add(f.attachments, `f${k}_`, { forwarded: k }));
  }
  return out;
}
