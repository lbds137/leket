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
import { readHistory, readDiary, readMemories, signedImageUrl, usableMediaUrl, SignedOut, ApiError, MEDIA_LINK_UNUSABLE, MEDIA_VOICE_LINK_UNUSABLE, MEDIA_FETCH_FAILED } from "./api.js";

// fixed reasons for an unexpected throw: its own text never reaches an output
export const MEDIA_SIGN_FAILED = "Replika didn't give a link for this file";
export const STEP_FAILED = "this step failed unexpectedly; what was read before it is kept";
// a SignedOut's or ApiError's message is fixed text; anything else thrown becomes the fallback
const reasonOf = (e, fallback = STEP_FAILED) => (e instanceof SignedOut || e instanceof ApiError ? e.message : fallback);

// ---- the input key paths each builder reads (the tally reports everything else) ----
export const MSG_ALLOWED = new Set([
  "id", "content.type", "content.text", "content.voice_message_url",
  "meta.nature", "meta.timestamp", "reactions[]", "meta.reactions[]",
  "content.originalText", "avatarEmotion.name", "is_romantic", "blurred",
]);
// the diary's two raw shapes: the list items and the day replies
export const DIARY_LIST_ALLOWED = new Set(["date", "title"]);
export const DIARY_DAY_ALLOWED = new Set([
  "date", "entries[].id", "entries[].timestamp", "entries[].text",
  "entries[].images[].url", "entries[].images[].blurred", "entries[].images[].is_romantic",
  "entries[].reaction",
]);
export const FACT_ALLOWED = new Set(["id", "creation_timestamp", "text", "category_id", "is_user_edited"]);
// the v3 memory list's people: not saved yet, so every field they carry shows in the tally
export const PERSON_ALLOWED = new Set([]);

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
  // seen on live messages: the text before Replika changed it, the
  // avatar's emotion name, and two picture flags — each copied only in its plain type
  if (content && typeof content.originalText === "string") record.original_text = content.originalText;
  const emotion = raw && raw.avatarEmotion && raw.avatarEmotion.name;
  if (typeof emotion === "string" && TYPE_NAME.test(emotion)) record.emotion = emotion;
  if (raw && typeof raw.is_romantic === "boolean") record.is_romantic = raw.is_romantic;
  if (raw && typeof raw.blurred === "boolean") record.blurred = raw.blurred;
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

// One diary day: its date, the list item's title, and each entry's id, time and text
// (strings only). Each entry's pictures follow the chat picture's path: the raw link is
// never written — it travels out of band as a plan (the image record plus its url) to
// the media step, which sets `media` or `not_captured` on the record. Only `blurred` and
// `is_romantic` are copied, and only as booleans.
export function buildDiary(day, listItem) {
  const plans = [];
  const entries = [];
  if (day && Array.isArray(day.entries)) {
    for (const e of day.entries) {
      if (!e || typeof e !== "object") continue;
      const entryId = scalar(e.id);
      const images = [];
      if (Array.isArray(e.images)) {
        e.images.forEach((img, i) => {
          const record = { kind: "images", id: `${entryId ?? "entry"}-${i}` };
          if (img && typeof img.blurred === "boolean") record.blurred = img.blurred;
          if (img && typeof img.is_romantic === "boolean") record.is_romantic = img.is_romantic;
          const url = img && img.url;
          if (typeof url !== "string" || !url) record.not_captured = MEDIA_LINK_UNUSABLE;
          else plans.push({ record, url });
          images.push(record);
        });
      }
      const entry = { id: entryId, at: scalar(e.timestamp), text: typeof e.text === "string" ? e.text : null, images };
      if (scalar(e.reaction) != null) entry.reaction = scalar(e.reaction);
      entries.push(entry);
    }
  }
  const record = {
    date: scalar(day && day.date),
    title: listItem && typeof listItem.title === "string" ? listItem.title : null,
    entries,
  };
  return { record, plans };
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
  if (raw && scalar(raw.category_id) != null) record.category_id = scalar(raw.category_id);
  if (raw && typeof raw.is_user_edited === "boolean") record.edited = raw.is_user_edited;
  return record;
}

// ---- the unknown-key tally ----

// Counts the key paths the raw objects carry but the builders never read, so a live run
// can widen the allowlist from what it shows. Dotted paths only, never values; nested
// plain objects are walked; an array whose path[] is allowed counts as read whole, any
// other array has its object items walked under path[] (a non-object item counts once
// as the leaf path[]; an empty array counts as nothing).
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
      if (Array.isArray(v)) {
        const leaf = `${path}[]`;
        if (allowed.has(leaf)) continue;
        let leafCounted = false;
        for (const item of v) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            if (depth >= TALLY_DEPTH) add(`${leaf}.*`);
            else walk(item, leaf, depth + 1);
          } else if (!leafCounted) {
            leafCounted = true; // non-object items count the leaf once per array
            add(leaf);
          }
        }
      } else if (v && typeof v === "object") {
        if (depth >= TALLY_DEPTH) add(`${path}.*`);
        else walk(v, path, depth + 1);
      } else if (!allowed.has(path)) {
        add(path);
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
        plan.record.not_captured = reasonOf(e, MEDIA_SIGN_FAILED);
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
// the data object, the named zip parts and the file's name. `pause` is a test seam for
// both rests (between diary day calls and between media fetches); left out, each step
// keeps its own default.
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
    chat = { messages: [], partial: reasonOf(e) };
  }
  statuses.chat = chat.partial || "complete";
  const built = chat.messages.map(buildMessage);
  const records = built.map((b) => b.record);
  const plans = [];
  for (const b of built) if (b.media) plans.push({ record: b.record, url: b.media.url });

  onStep("diary");
  let diary = { days: [], list: [], partial: null, signedOut: false };
  try {
    diary = await readDiary({ auth, fetchFn, sleep, pause });
  } catch (e) {
    diary = { days: [], list: [], partial: reasonOf(e), signedOut: false };
  }
  statuses.diary = diary.partial || "complete";
  const titleOf = new Map();
  for (const item of diary.list) if (item && typeof item.date === "string") titleOf.set(item.date, item);
  const diaryRecords = [];
  const diaryPlans = [];
  for (const day of diary.days) {
    const built = buildDiary(day, titleOf.get(day && day.date));
    diaryRecords.push(built.record);
    diaryPlans.push(...built.plans);
  }
  if (diary.signedOut) stopReason = diary.partial;

  onStep("memories");
  let memories = { facts: [], customerFacts: [], robotFacts: [], persons: [], partial: null, signedOut: false };
  if (stopReason) {
    memories.partial = stopReason;
  } else {
    try {
      memories = await readMemories({ auth, fetchFn, sleep });
    } catch (e) {
      memories = { facts: [], customerFacts: [], robotFacts: [], persons: [], partial: reasonOf(e), signedOut: false };
    }
  }
  statuses.memories = memories.partial || "complete";
  const factRecords = memories.facts.map((f) => buildFact(f, null));
  const youRecords = memories.customerFacts.map((f) => buildFact(f, "you"));
  const replikaRecords = memories.robotFacts.map((f) => buildFact(f, "replika"));
  if (memories.signedOut) stopReason = memories.partial;

  onStep("media");
  let media = { files: [], stopped: null };
  const allPlans = [...plans, ...diaryPlans];
  if (stopReason) {
    statuses.media = stopReason;
    for (const plan of allPlans) if (!plan.record.not_captured) plan.record.not_captured = stopReason;
  } else {
    media = await collectMedia(allPlans, {
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
      // entries, not days: the page and the end line both say "diary entries"
      diary: diaryRecords.reduce((n, d) => n + d.entries.length, 0),
      memories: factRecords.length + youRecords.length + replikaRecords.length,
      media: media.files.length,
    },
    unsaved_fields: {
      message: tallyUnknown(chat.messages, MSG_ALLOWED),
      // the diary's raw objects are two answers Replika gave: the list items and the
      // days, so a field on either shows up in its own tally
      diary_list: tallyUnknown(diary.list || [], DIARY_LIST_ALLOWED),
      diary: tallyUnknown(diary.days, DIARY_DAY_ALLOWED),
      fact: tallyUnknown([...memories.facts, ...memories.customerFacts, ...memories.robotFacts], FACT_ALLOWED),
      person: tallyUnknown(memories.persons || [], PERSON_ALLOWED),
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

// every record with a not_captured reason: chat messages and diary pictures
function notCaptured(data) {
  const out = [];
  for (const m of (data && data.messages) || []) if (m && m.not_captured) out.push(m);
  for (const d of (data && data.diary) || []) {
    for (const e of (d && d.entries) || []) {
      for (const img of (e && e.images) || []) if (img && img.not_captured) out.push(img);
    }
  }
  return out;
}

// the page's problems list: every partial reason, then the not-captured media by reason
export function problems(data) {
  const lines = [];
  const status = (data && data.status) || {};
  for (const [key, name] of [["chat", "Chat history"], ["diary", "Diary"], ["memories", "Memories"], ["media", "Media"]]) {
    if (status[key] && status[key] !== "complete") lines.push(`${name}: ${status[key]}`);
  }
  const counts = new Map();
  for (const m of notCaptured(data)) counts.set(m.not_captured, (counts.get(m.not_captured) || 0) + 1);
  for (const [reason, n] of counts) lines.push(`${n} item(s) not saved: ${reason}`);
  // the field paths the builders never read, per kind (paths only, never values)
  const unsaved = (data && data.unsaved_fields) || {};
  const kindLabel = { diary_list: "diary list", person: "memory people" };
  for (const kind of ["message", "diary_list", "diary", "fact", "person"]) {
    const paths = Object.keys(unsaved[kind] || {});
    if (!paths.length) continue;
    lines.push(`Fields Leket didn't save (${kindLabel[kind] || kind}): ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ` and ${paths.length - 20} more` : ""}`);
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
  const missed = notCaptured(data).length;
  const line = `Saved ${filename}: ${c.messages ?? 0} messages, ${c.diary ?? 0} diary entries, ${c.memories ?? 0} memories, ${c.media ?? 0} pictures and voice clips`;
  const unsaved = `${missed} item(s) not saved`;
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
    if (s && s !== "complete") return `<p class="status warn">Saved partway (${esc(s)}) — ${n} here.</p>`;
    return `<p class="status ok">Complete — ${n} here.</p>`;
  };
  const statusWord = (key) => {
    const s = status[key];
    return s && s !== "complete" ? `<p class="status warn">Saved partway (${esc(s)}).</p>` : `<p class="status ok">Complete.</p>`;
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

  const diaryDays = (data && data.diary) || [];
  let diary = "";
  for (const d of diaryDays) {
    let body = `<div class="head"><span class="name">${esc(d.title || "diary entry")}</span><span class="time">${esc(d.date == null ? "unknown date" : d.date)}</span></div>`;
    for (const e of d.entries || []) {
      if (e.text != null) body += `<div class="text">${esc(e.text)}</div>`;
      for (const img of e.images || []) {
        const alt = `picture from the diary, ${esc(d.date == null ? "unknown date" : d.date)}`;
        if (img.media) body += `<div class="media"><img loading="lazy" src="${esc(img.media)}" alt="${alt}"></div>`;
        if (img.not_captured) body += `<div class="missing">picture not saved: ${esc(img.not_captured)}</div>`;
      }
    }
    diary += `<div class="msg">${body}</div>`;
  }
  if (!diaryDays.length) diary = `<p class="empty">No diary entries came back for this save.</p>`;

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
<p>${savedLine}</p>${status.media && status.media !== "complete" ? statusWord("media") : ""}</header>
<section id="chat"><h2>Chat</h2>${statusLine("chat", counts.messages ?? 0)}${chat}</section>
<section id="diary"><h2>Diary</h2>${statusLine("diary", counts.diary ?? 0)}${diary}</section>
<section id="memories"><h2>Memories</h2>${statusWord("memories")}${memories}</section>
</main></body></html>
`;
}
