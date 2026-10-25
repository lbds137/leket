// Which attachments an export holds and the name each is saved under, in the layout
// fetch_discord_attachments.py has always written: discord-attachments/ beside the JSON, as
// <date>_<message id>_<n>_<filename>, and discord-attachments.json mapping each file back to
// its message. A forwarded message's attachments are <date>_<message id>_f<k>_<n>_<filename>.

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

// one entry per attachment: {message_id, filename, url, file, forwarded?}; file is the name
// inside FOLDER
export function attachmentList(exp) {
  const out = [];
  for (const m of exp.messages || []) {
    const day = String(m.datetime || "").slice(0, 10);
    const add = (list, mid, extra) => (list || []).forEach((a, n) => {
      out.push({ message_id: m.id, filename: a.filename, url: a.url,
        file: fileName(`${day}_${m.id}_${mid}${n}_`, a.filename), ...extra });
    });
    add(m.attachments, "", {});
    (m.forwarded || []).forEach((f, k) => add(f.attachments, `f${k}_`, { forwarded: k }));
  }
  return out;
}
