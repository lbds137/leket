// The Replika save's pure half: allowlisted record builders, the unknown-key tally, the
// media names, the readable index.html, the zip, and the file names — plus runSave, the
// one function that walks the four steps in order and returns everything the page
// downloads. Nothing here touches the DOM or chrome.*: every seam (fetchFn, WebSocket,
// sleeps, the clock) is a parameter, so the tests run a full save under node.
// The rule the builders exist for: no raw Replika object is ever written, spread or
// stringified into an output — only these named fields are.
import { ZipWriter } from "../../lib/zip.js";
import { esc } from "../../lib/render.js";
import { fetchFile } from "../../lib/build.js";
import { readHistory, readDiary, readMemories, signedImageUrl, usableMediaUrl, SignedOut, MEDIA_LINK_UNUSABLE, MEDIA_VOICE_LINK_UNUSABLE, MEDIA_FETCH_FAILED } from "./api.js";

// ---- the input key paths each builder reads (the tally reports everything else) ----
export const MSG_ALLOWED = new Set([
  "id", "content.type", "content.text", "content.voice_message_url",
  "meta.nature", "meta.timestamp", "reactions[]", "meta.reactions[]",
]);
export const DIARY_ALLOWED = new Set(["id", "creation_timestamp", "timestamp", "type", "entries[]"]);
export const FACT_ALLOWED = new Set(["id", "creation_timestamp", "text"]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the rest between media fetches: under a second, so a big save doesn't pull from the
// host as fast as it answers
const restBetweenMedia = () => wait(300 + Math.random() * 400);

// ---- record builders ----

// ids and timestamps are copied only as a string or a finite number, never an object
const scalar = (v) => (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? v : null);
// a type name is kept only when it is short and plain
const TYPE_NAME = /^[A-Za-z0-9_ -]{1,40}$/;

// One message, allowlisted. For "images" the raw link in content.text and for
// "voice_message" the one in voice_message_url are never written anywhere — they travel
// out of band (as the returned media plan) to the media step.
export function buildMessage(raw) {
  const meta = raw && typeof raw === "object" ? raw.meta : undefined;
  const content = raw && typeof raw === "object" ? raw.content : undefined;
  // a missing or empty type stays null; one that is present but not a short plain name
  // (an object, an 80-char string) is "unknown"
  const rawKind = content && content.type;
  const kind = rawKind == null || rawKind === "" ? null : typeof rawKind === "string" && TYPE_NAME.test(rawKind) ? rawKind : "unknown";
  const nature = meta && meta.nature;
  const record = {
    id: scalar(raw && raw.id),
    at: scalar(meta && meta.timestamp),
    from: nature === "Customer" ? "you" : nature === "Robot" ? "replika" : "unknown",
    kind,
  };
  if (kind === "text" && content && typeof content.text === "string") record.text = content.text;
  // reactions: only when a field named exactly `reactions` sits on the message or its
  // meta AND is an array of strings or numbers; those primitives alone are copied
  const reactions = [meta && meta.reactions, raw && raw.reactions]
    .find((r) => Array.isArray(r) && r.every((x) => typeof x === "string" || typeof x === "number"));
  if (reactions) record.reactions = reactions.slice();
  if (kind === "text") return { record, media: null };
  // a kind Leket doesn't read is said so, its short type name in the reason (escaped
  // when it reaches the page)
  if (kind !== "images" && kind !== "voice_message") {
    record.not_captured = kind ? `Leket doesn't read ${kind} messages yet` : "Leket doesn't read this message's type yet";
    return { record, media: null };
  }
  const url = kind === "images" ? content && content.text : content && content.voice_message_url;
  if (typeof url !== "string" || !url) {
    record.not_captured = kind === "voice_message" ? MEDIA_VOICE_LINK_UNUSABLE : MEDIA_LINK_UNUSABLE;
    return { record, media: null };
  }
  return { record, media: { url } };
}

// One diary entry. Its texts are the entries' texts, strings only.
export function buildDiary(raw) {
  const texts = [];
  if (raw && Array.isArray(raw.entries)) {
    for (const e of raw.entries) if (e && typeof e.text === "string") texts.push(e.text);
  }
  return {
    id: scalar(raw && raw.id),
    at: scalar(raw && (raw.creation_timestamp || raw.timestamp)),
    type: raw && typeof raw.type === "string" && TYPE_NAME.test(raw.type) ? raw.type : null,
    texts,
  };
}

// One memory fact; `about` is "you" or "replika" from the list it came from, null for
// the older v1.4 list that doesn't say.
export function buildFact(raw, about) {
  const record = {
    at: scalar(raw && raw.creation_timestamp),
    text: raw && typeof raw.text === "string" ? raw.text : null,
    about,
  };
  if (raw && raw.id != null) record.id = scalar(raw.id);
  return record;
}

// ---- the unknown-key tally ----

// Counts the key paths the raw objects carry but the builders never read, so a live run
// can widen the allowlist from what it shows. Dotted paths only, never values; nested
// plain objects are walked, an array contributes its path with [] and is not entered.
// A key is data too, so it is hardened: a key segment that isn't a short plain
// identifier is written as *, objects deeper than TALLY_DEPTH segments are not entered
// (the path at that depth counts as <path>.*), and past TALLY_PATHS distinct paths the
// rest are counted under "(more)".
const TALLY_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const TALLY_DEPTH = 4;
const TALLY_PATHS = 200;
export function tallyUnknown(objects, allowedPaths) {
  const allowed = allowedPaths instanceof Set ? allowedPaths : new Set(allowedPaths);
  const counts = new Map();
  const add = (leaf) => {
    if (!counts.has(leaf) && counts.size >= TALLY_PATHS) leaf = "(more)";
    counts.set(leaf, (counts.get(leaf) || 0) + 1);
  };
  const walk = (obj, prefix, depth) => {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      const k = TALLY_KEY.test(key) ? key : "*";
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (depth >= TALLY_DEPTH) add(`${path}.*`);
        else walk(v, path, depth + 1);
      } else {
        const leaf = Array.isArray(v) ? `${path}[]` : path;
        if (!allowed.has(leaf)) add(leaf);
      }
    }
  };
  for (const o of objects || []) {
    if (o && typeof o === "object" && !Array.isArray(o)) walk(o, "", 1);
  }
  return Object.fromEntries(counts);
}

// ---- media names ----

const EXTENSIONS = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav",
};
export const extFor = (type) => EXTENSIONS[type] || "bin";

// the id keeps only [A-Za-z0-9_-], cut to 80 chars; anything else becomes _
export function safeId(id) {
  const s = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return s || "file";
}

// names are handed out one at a time, so a second file with the same id gets -2, -3…
export function makeMediaNamer() {
  const used = new Set();
  return (id, type) => {
    const stem = safeId(id);
    const ext = extFor(type);
    let name = `${stem}.${ext}`;
    for (let n = 2; used.has(name); n++) name = `${stem}-${n}.${ext}`;
    used.add(name);
    return name;
  };
}

// The media step: one file at a time, a rest between fetches. A picture's raw link is
// signed first (the URL check lives in api.js); a voice clip is fetched by its own link,
// unsigned, after the same check. A SignedOut from a sign call ends the step: what is
// still unplanned keeps that reason, the caller stops its remaining steps. A fetch that
// fails marks the record with a fixed reason — never fetchFile's own error text, which
// can carry server-derived words.
export async function collectMedia(plans, { auth, fetchFn = fetch, sleep = wait, pause = restBetweenMedia, onProgress } = {}) {
  const name = makeMediaNamer();
  const files = [];
  let stopped = null;
  // fetchFile answers a typeless Blob (build.js keeps the raw pieces), so the file's
  // extension comes from the response's content-type, recorded as it streams past
  const types = new Map();
  const noted = async (url, init) => {
    const resp = await fetchFn(url, init);
    try { types.set(url, resp && resp.headers ? resp.headers.get("content-type") : null); } catch { /* a stand-in without headers */ }
    return resp;
  };
  for (let i = 0; i < (plans || []).length; i++) {
    const plan = plans[i];
    if (onProgress) onProgress({ done: i, total: plans.length });
    if (stopped) {
      plan.record.not_captured = stopped;
      continue;
    }
    // where the file comes from: a voice clip is its own link, a picture the signed one
    let target = null;
    if (plan.record.kind === "voice_message") {
      if (usableMediaUrl(plan.url)) target = plan.url;
    } else {
      try {
        target = await signedImageUrl(plan.url, { auth, fetchFn, sleep });
      } catch (e) {
        if (e instanceof SignedOut) {
          stopped = e.message;
          plan.record.not_captured = stopped;
          continue;
        }
        plan.record.not_captured = (e && e.message) || String(e);
        continue;
      }
    }
    if (!target) {
      plan.record.not_captured = plan.record.kind === "voice_message" ? MEDIA_VOICE_LINK_UNUSABLE : MEDIA_LINK_UNUSABLE;
      continue;
    }
    // 3 tries a second apart: a host that refuses fails in ~3 s a file, not ~30 s
    const got = await fetchFile(target, { fetchFn: noted, tries: 3, wait: 1000 });
    if (got.error) {
      plan.record.not_captured = MEDIA_FETCH_FAILED;
    } else {
      const type = (types.get(target) || "").split(";")[0].trim();
      const fileName = name(plan.record.id, type);
      plan.record.media = `media/${fileName}`;
      files.push({ name: fileName, blob: got.blob, crc: got.crc });
    }
    if (i + 1 < plans.length) await pause();
  }
  if (onProgress && plans && plans.length) onProgress({ done: plans.length, total: plans.length });
  return { files, stopped };
}

// ---- the four steps, in order ----

// The whole save: chat history, then diary, then memories, then media. One step's
// failure is recorded and the next still runs — except a 401/403 (SignedOut), which
// stops the remaining steps, and still saves everything that was read. Resolves with
// the data object, the named zip parts and the file's name.
export async function runSave({
  auth, leketVersion = null, now = new Date(),
  fetchFn = fetch, sleep = wait, WebSocketCtor, uuid, timeoutMs, pause,
  onStep = () => {}, onProgress = () => {},
} = {}) {
  const statuses = { chat: "complete", diary: "complete", memories: "complete", media: "complete" };
  let stopReason = null; // the SignedOut message, once one step is refused

  onStep("chat");
  onProgress({ step: "chat", count: 0 });
  let chat = { messages: [], partial: null };
  try {
    chat = await readHistory({
      auth, chatId: auth.chatId, WebSocketCtor, timeoutMs, uuid,
      onProgress: (n) => onProgress({ step: "chat", count: n }),
    });
  } catch (e) {
    chat = { messages: [], partial: (e && e.message) || String(e) };
  }
  statuses.chat = chat.partial || "complete";
  const built = chat.messages.map(buildMessage);
  const records = built.map((b) => b.record);
  const plans = [];
  for (const b of built) if (b.media) plans.push({ record: b.record, url: b.media.url });

  onStep("diary");
  let diary = { entries: [], previews: [], partial: null, signedOut: false };
  if (stopReason) {
    diary.partial = stopReason;
  } else {
    try {
      diary = await readDiary({ auth, fetchFn, sleep });
    } catch (e) {
      diary = { entries: [], previews: [], partial: (e && e.message) || String(e), signedOut: false };
    }
  }
  statuses.diary = diary.partial || "complete";
  const diaryRecords = diary.entries.map(buildDiary);
  if (diary.signedOut) stopReason = diary.partial;

  onStep("memories");
  let memories = { facts: [], customerFacts: [], robotFacts: [], partial: null, signedOut: false };
  if (stopReason) {
    memories.partial = stopReason;
  } else {
    try {
      memories = await readMemories({ auth, fetchFn, sleep });
    } catch (e) {
      memories = { facts: [], customerFacts: [], robotFacts: [], partial: (e && e.message) || String(e), signedOut: false };
    }
  }
  statuses.memories = memories.partial || "complete";
  const factRecords = memories.facts.map((f) => buildFact(f, null));
  const youRecords = memories.customerFacts.map((f) => buildFact(f, "you"));
  const replikaRecords = memories.robotFacts.map((f) => buildFact(f, "replika"));
  if (memories.signedOut) stopReason = memories.partial;

  onStep("media");
  let media = { files: [], stopped: null };
  if (stopReason) {
    statuses.media = stopReason;
    for (const plan of plans) if (!plan.record.not_captured) plan.record.not_captured = stopReason;
  } else {
    media = await collectMedia(plans, {
      auth, fetchFn, sleep, pause,
      onProgress: (p) => onProgress({ step: "media", count: p.done, total: p.total }),
    });
    if (media.stopped) statuses.media = media.stopped;
  }

  const data = {
    saved_at: now.toISOString(),
    leket_version: leketVersion,
    names: { you: auth.userName || "You", replika: auth.botName || "Replika" },
    status: statuses,
    counts: {
      messages: records.length,
      diary: diaryRecords.length,
      memories: factRecords.length + youRecords.length + replikaRecords.length,
      media: media.files.length,
    },
    unsaved_fields: {
      message: tallyUnknown(chat.messages, MSG_ALLOWED),
      // the diary's raw objects are both lists Replika answered: the previews and the
      // detailed entries, so a field on either shows up in the tally
      diary: tallyUnknown([...(diary.previews || []), ...diary.entries], DIARY_ALLOWED),
      fact: tallyUnknown([...memories.facts, ...memories.customerFacts, ...memories.robotFacts], FACT_ALLOWED),
    },
    messages: records,
    diary: diaryRecords,
    memories: { facts: factRecords, about_you: youRecords, about_replika: replikaRecords },
  };

  const filename = saveName(now);
  const base = filename.replace(/\.zip$/, "");
  const rawParts = buildZip(data, media.files);
  const parts = rawParts.map((blob, i) => ({
    blob,
    name: rawParts.length === 1 ? `${base}.zip` : `${base}-part${i + 1}-of-${rawParts.length}.zip`,
  }));
  return { data, parts, filename };
}

// ---- the outputs ----

// The zip: the data, the readable page, then the media blobs with their crcs. The writer
// is used without onPart; if it seals more than one part the caller names them -partN-of-M.
export function buildZip(data, files) {
  const zip = new ZipWriter();
  const enc = new TextEncoder();
  zip.add("data.json", enc.encode(JSON.stringify(data, null, 1)));
  zip.add("index.html", enc.encode(render(data)));
  for (const f of files || []) zip.add(`media/${f.name}`, f.blob, f.crc);
  return zip.parts();
}

// replika-<local date>-<local time>.zip — the seconds make a re-run land beside, never
// on top of, an earlier save (and the download itself is uniquified, see downloadOptions)
export function saveName(now) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `replika-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

// a re-run NEVER overwrites an earlier save: a partial re-run of a lapsed account must
// not replace a complete one
export function downloadOptions(filename) {
  return { filename, conflictAction: "uniquify" };
}

// the page's problems list: every partial reason, then the not-captured media by reason
export function problems(data) {
  const lines = [];
  const status = (data && data.status) || {};
  for (const [key, name] of [["chat", "Chat history"], ["diary", "Diary"], ["memories", "Memories"], ["media", "Media"]]) {
    if (status[key] && status[key] !== "complete") lines.push(`${name}: ${status[key]}`);
  }
  const counts = new Map();
  for (const m of (data && data.messages) || []) {
    if (m && m.not_captured) counts.set(m.not_captured, (counts.get(m.not_captured) || 0) + 1);
  }
  for (const [reason, n] of counts) lines.push(`${n} picture(s) or voice clip(s) not saved: ${reason}`);
  // the field paths the builders never read, per kind (paths only, never values)
  const unsaved = (data && data.unsaved_fields) || {};
  for (const kind of ["message", "diary", "fact"]) {
    const paths = Object.keys(unsaved[kind] || {});
    if (!paths.length) continue;
    lines.push(`Fields Leket didn't save (${kind}): ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ` and ${paths.length - 20} more` : ""}`);
  }
  return lines;
}

// the page's end line, with (partial: …) and the warn flag when any status isn't complete
export function endLine({ filename, data }) {
  const c = (data && data.counts) || {};
  const status = (data && data.status) || {};
  const reasons = [];
  for (const key of ["chat", "diary", "memories", "media"]) {
    const s = status[key];
    if (s && s !== "complete" && !reasons.includes(s)) reasons.push(s);
  }
  let missed = 0;
  for (const m of (data && data.messages) || []) if (m && m.not_captured) missed++;
  const line = `Saved ${filename}: ${c.messages ?? 0} messages, ${c.diary ?? 0} diary entries, ${c.memories ?? 0} memories, ${c.media ?? 0} pictures and voice clips`;
  const unsaved = `${missed} picture(s) or voice clip(s) not saved`;
  if (reasons.length) return { text: `${line} (partial: ${reasons.join("; ")}${missed ? `; ${unsaved}` : ""})`, warn: true };
  return missed ? { text: `${line} (${unsaved})`, warn: true } : { text: line, warn: false };
}

// ---- the readable page ----

const localStamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
// a message's `at` as the reader's local date-time, or the raw text when it never parsed
const stamp = (at) => {
  if (at == null) return "unknown date";
  const d = new Date(at);
  return Number.isNaN(+d) ? String(at) : localStamp.format(d);
};

// index.html: self-contained — inline CSS only, no script, no remote URL anywhere. Light
// and dark via prefers-color-scheme, the same variables the claude-chat page renders with.
// Every string that came from Replika goes through esc.
export function render(data) {
  const names = (data && data.names) || {};
  const you = names.you || "You";
  const replika = names.replika || "Replika";
  const speaker = (from) => (from === "you" ? you : from === "replika" ? replika : "unknown");
  const status = (data && data.status) || {};
  const counts = (data && data.counts) || {};

  const savedLine = `Saved ${stamp(data && data.saved_at)}` +
    (data && data.leket_version ? ` with Leket ${esc(data.leket_version)}` : "");

  const statusLine = (key, n) => {
    const s = status[key];
    if (s && s !== "complete") return `<p class="status warn">Saved partway — ${esc(s)} ${n} here.</p>`;
    return `<p class="status ok">Complete — ${n} here.</p>`;
  };
  const statusWord = (key) => {
    const s = status[key];
    return s && s !== "complete" ? `<p class="status warn">Saved partway — ${esc(s)}</p>` : `<p class="status ok">Complete.</p>`;
  };

  let chat = "";
  for (const m of (data && data.messages) || []) {
    const when = stamp(m.at);
    const who = speaker(m.from);
    let body = `<div class="head"><span class="name">${esc(who)}</span><span class="time">${esc(when)}</span></div>`;
    if (m.text != null) body += `<div class="text">${esc(m.text)}</div>`;
    if (Array.isArray(m.reactions) && m.reactions.length) {
      body += `<div class="reactions">${m.reactions.map((r) => `<span class="reaction">${esc(r)}</span>`).join("")}</div>`;
    }
    if (m.media) {
      const alt = `${m.kind === "voice_message" ? "voice clip" : "picture"} from ${esc(who)}, ${esc(when)}`;
      if (m.kind === "voice_message") {
        body += `<div class="media"><audio controls src="${esc(m.media)}"></audio> <span class="medialabel">${alt}</span></div>`;
      } else {
        body += `<div class="media"><img loading="lazy" src="${esc(m.media)}" alt="${alt}"></div>`;
      }
    }
    if (m.not_captured) {
      const what = m.kind === "images" ? "picture not saved" : m.kind === "voice_message" ? "voice clip not saved" : "not saved";
      body += `<div class="missing">${esc(what)}: ${esc(m.not_captured)}</div>`;
    }
    chat += `<div class="msg">${body}</div>`;
  }
  if (!(data && data.messages && data.messages.length)) {
    chat = `<p class="empty">No messages came back for this save.</p>`;
  }

  const diaryEntries = (data && data.diary) || [];
  let diary = "";
  for (const d of diaryEntries) {
    let body = `<div class="head"><span class="name">${esc(d.type || "diary entry")}</span><span class="time">${esc(stamp(d.at))}</span></div>`;
    for (const t of d.texts || []) body += `<div class="text">${esc(t)}</div>`;
    diary += `<div class="msg">${body}</div>`;
  }
  if (!diaryEntries.length) diary = `<p class="empty">No diary entries came back for this save.</p>`;

  const factsBlock = (list, label) => {
    let out = `<h3>${esc(label)}</h3>`;
    const items = (list || []).map((f) =>
      `<li>${esc(f.text == null ? "a memory without its text" : f.text)}${f.at ? ` <span class="time">${esc(stamp(f.at))}</span>` : ""}</li>`);
    out += items.length ? `<ul>${items.join("")}</ul>` : `<p class="empty">None.</p>`;
    return out;
  };
  const memories = factsBlock((data && data.memories && data.memories.about_you) || [], `About ${you}`) +
    factsBlock((data && data.memories && data.memories.about_replika) || [], `About ${replika}`) +
    factsBlock((data && data.memories && data.memories.facts) || [], "General memories");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(you)} &amp; ${esc(replika)} — Replika</title>
<style>
:root{--bg:#fff;--fg:#1e1f22;--muted:#4e5058;--line:#e3e5e8;--card:#f2f3f5;--accent:#3945d1;--warn:#7d4600;--ok:#116329}
@media (prefers-color-scheme: dark){:root{--bg:#313338;--fg:#dbdee1;--muted:#bec5cd;--line:#3f4147;--card:#2b2d31;--accent:#b6beff;--warn:#f5bc36;--ok:#6ede75}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:16px}
header h1{font-size:20px;margin:0 0 4px}header p{margin:2px 0;color:var(--muted)}
section{border-top:1px solid var(--line);margin-top:24px;padding-top:12px}
h2{font-size:17px;margin:0 0 6px}h3{font-size:14px;margin:14px 0 4px;color:var(--muted)}
.status{font-size:14px;margin:4px 0}.status.warn{color:var(--warn)}.status.ok{color:var(--ok)}
.msg{padding:2px 0;margin-top:10px}
.head .name{font-weight:600;margin-right:8px}.head .time{font-size:12px;color:var(--muted)}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.media img{max-width:min(100%,520px);max-height:420px;border-radius:6px;margin-top:4px;display:block}
audio{margin-top:4px}.medialabel{font-size:13px;color:var(--muted)}
.missing{color:var(--warn);font-size:13px;margin-top:2px}
.reactions{margin-top:2px}.reaction{display:inline-block;background:var(--card);border-radius:10px;padding:0 8px;margin-right:4px;font-size:13px}
.empty{color:var(--muted);font-style:italic}
ul{margin:4px 0;padding-left:20px}li{margin:2px 0}
</style></head><body><main>
<header><h1>${esc(you)} &amp; ${esc(replika)}</h1>
<p>${counts.messages ?? 0} messages · ${counts.diary ?? 0} diary entries · ${counts.memories ?? 0} memories · ${counts.media ?? 0} pictures and voice clips</p>
<p>${savedLine}</p></header>
<section id="chat"><h2>Chat</h2>${statusLine("chat", counts.messages ?? 0)}${chat}</section>
<section id="diary"><h2>Diary</h2>${statusLine("diary", counts.diary ?? 0)}${diary}</section>
<section id="memories"><h2>Memories</h2>${statusWord("memories")}${memories}</section>
</main></body></html>
`;
}
