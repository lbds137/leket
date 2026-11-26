// Replika's protocol, with every network seam injected (fetchFn, WebSocketCtor, sleep)
// so the tests run it all under node and the page passes its own globals in. The shapes
// come from TASK-33's premise notes about Replika's API; nothing here is copied from any
// other add-on. Two rules the whole module keeps:
//   - no thrown message ever carries a URL, a header value or a response body (the body
//     could carry credentials), and
//   - nothing is ever console.log'd.
import { md5 } from "../../lib/md5.js";

export const HISTORY_SOCKET = "wss://ws.replika.com/v17";
const DIARY_LIST = "https://my.replika.com/api/mobile/1.5/diaries";
const MEMORY_V14 = "https://my.replika.ai/api/mobile/1.4/memory";
const MEMORY_V15 = "https://my.replika.com/api/mobile/1.5/memory/v3/";
const IMAGE_SIGNED = "https://my.replika.ai/api/mobile/1.5/images/signed/actions/get_url";

// fixed, secret-free reasons the save shows when a step stopped partway
export const DIARY_PARTIAL = "Replika stopped answering the diary partway; the entries read so far are kept";
export const DIARY_STUCK = "the diary list stopped moving back in time; the entries read so far are kept";
export const DIARY_PAGE_CAP = "the diary has more pages than one save reads; the entries read so far are kept";
export const MEMORY_V14_PARTIAL = "Replika's older memory list (v1.4) didn't come back; the other memories are kept";
export const MEMORY_V15_PARTIAL = "Replika's newer memory list (v1.5) didn't come back; the other memories are kept";
export const MEMORY_BOTH_PARTIAL = "Replika's memory lists (both versions) didn't come back";
export const HISTORY_NO_LIST = "the history reply had no message list";
export const HISTORY_NO_DATE = "no dated message to page from";
export const HISTORY_STUCK = "the history stopped moving backwards";
export const HISTORY_CLOSED = "the connection to Replika closed early";
export const HISTORY_SILENT = "no reply from Replika for 30 s";
export const MEDIA_LINK_UNUSABLE = "the picture's link was not usable";
export const MEDIA_VOICE_LINK_UNUSABLE = "the voice clip's link was not usable";
export const MEDIA_FETCH_FAILED = "the file host refused or failed";

// an error whose message is one of this module's fixed, secret-free texts
export class ApiError extends Error {}

export class SignedOut extends Error {
  constructor() {
    super("Replika answered 401/403: sign in again on Replika and rerun");
    this.name = "SignedOut";
  }
}

const DIARY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The four REST headers, from the premise notes: the hash is the lowercase hex MD5 of a
// fixed prefix joined onto the device id. `post` adds content-type (POST bodies are JSON).
export function headers(auth, post = false) {
  const h = {
    "x-user-id": auth.userId,
    "x-auth-token": auth.authToken,
    "x-device-id": auth.deviceId,
    "x-timestamp-hash": md5(`time_covfefe_prefix=2020_${auth.deviceId}`),
  };
  if (post) h["content-type"] = "application/json";
  return h;
}

// One REST call with its retries: 2xx resolves parsed JSON; 401/403 throws SignedOut at
// once (retrying cannot sign in); 429, 5xx and network errors back off 2 s, 4 s, 8 s and
// then throw a fixed message; any other status throws at once. The backoff sleeps and
// the fetch itself are the injected seams.
export async function call(url, { method = "GET", body, auth, fetchFn = fetch, sleep = defaultSleep, tries = 4 } = {}) {
  const init = {
    method,
    credentials: "omit",
    headers: headers(auth, method === "POST"),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let status = null;
  for (let i = 0; i < tries; i++) {
    let resp;
    try {
      resp = await fetchFn(url, init);
    } catch {
      status = null; // a network error: retry, then say exactly that
      if (i + 1 < tries) { await sleep(2000 * 2 ** i); continue; }
      throw new ApiError("network error");
    }
    if (resp.ok) {
      try {
        return await resp.json();
      } catch {
        if (i + 1 < tries) { await sleep(2000 * 2 ** i); continue; }
        throw new ApiError("Replika's answer was not JSON");
      }
    }
    if (resp.status === 401 || resp.status === 403) throw new SignedOut();
    status = resp.status;
    if (status === 429 || status >= 500) {
      if (i + 1 < tries) { await sleep(2000 * 2 ** i); continue; }
    }
    break;
  }
  throw new ApiError(status == null ? "network error" : `Replika answered HTTP ${status}`);
}

// Injected into the my.replika.com tab with chrome.scripting.executeScript, so this
// function must stay self-contained: no imports, no closures, no console. It reads the
// three localStorage keys the signed-in site keeps and answers {ok, auth} or
// {ok: false, missing}. `profile` alone may be missing (the save then labels speakers
// You and Replika); `auth` or `ws` missing is not signed in.
export function readReplikaAuth() {
  const missing = [];
  const parse = (key, required) => {
    let raw = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      missing.push(key);
      return null;
    }
    if (raw == null) {
      missing.push(key);
      return null;
    }
    let value = null;
    try {
      value = JSON.parse(raw);
    } catch {
      missing.push(key);
      return null;
    }
    if (!value || typeof value !== "object") {
      missing.push(key);
      return null;
    }
    for (const field of required) {
      if (typeof value[field] !== "string" || !value[field]) {
        missing.push(key);
        return null;
      }
    }
    return value;
  };
  const auth = parse("auth", ["userId", "deviceId", "authToken"]);
  const ws = parse("ws", ["chatId"]);
  // profile is parsed loosely: any of its two names may be absent without failing
  let profile = null;
  try {
    const raw = localStorage.getItem("profile");
    if (raw != null) {
      profile = JSON.parse(raw);
      if (!profile || typeof profile !== "object") profile = null;
    }
  } catch {
    profile = null;
  }
  if (!profile) missing.push("profile");
  if (!auth || !ws) return { ok: false, missing };
  return {
    ok: true,
    missing,
    auth: {
      userId: auth.userId,
      deviceId: auth.deviceId,
      authToken: auth.authToken,
      chatId: ws.chatId,
      userName: profile && profile.userProfile && typeof profile.userProfile.first_name === "string"
        ? profile.userProfile.first_name : null,
      botName: profile && profile.bot && typeof profile.bot.name === "string" ? profile.bot.name : null,
    },
  };
}

// The diary: the list of days pages back by date (limit 100, newest first; each page
// holds the days strictly before `until`, the oldest date of the page before) until an
// empty array, then each listed day is fetched by its date, oldest first. Only list
// items whose date is a plain YYYY-MM-DD are kept, each date once (the first item for a
// date wins, even within one page), so nothing else is ever put into a request URL.
// `until` only ever moves back: the next one is the smaller of the current one and the
// page's oldest fresh date (a page of only newer unseen dates keeps its days but does
// not page forward). A day reply whose `date` is not the requested date is a failed day
// call, like a reply without an entries array. A reply that is not an array is a failure (not the end of
// the list); a failed page after some days keeps their dates and still fetches those
// days, and a failed day call keeps the days already read — either way the answer
// carries a fixed partial reason. A page with no fresh valid date (or the maxPages cap)
// is stuck. A 401/403 keeps what was read, with signedOut set so the save stops its
// remaining steps. The list items ride along too: the save's tally reports the fields
// they carry that Leket never reads.
export async function readDiary({ auth, fetchFn = fetch, sleep = defaultSleep, limit = 100, maxPages = 1000 } = {}) {
  const list = [];
  const seen = new Set();
  let pages = 0;
  let partial = null;
  let until = null;
  for (;;) {
    const url = until == null ? `${DIARY_LIST}?limit=${limit}` : `${DIARY_LIST}?limit=${limit}&until=${encodeURIComponent(until)}`;
    let page;
    try {
      page = await call(url, { auth, fetchFn, sleep });
    } catch (e) {
      if (e instanceof SignedOut) return { days: [], list, partial: e.message, signedOut: true };
      partial = DIARY_PARTIAL; // the days listed so far still get fetched
      break;
    }
    if (!Array.isArray(page)) {
      partial = DIARY_PARTIAL; // not a list: the days listed so far still get fetched
      break;
    }
    if (!page.length) break;
    const fresh = [];
    for (const p of page) {
      if (!p || typeof p.date !== "string" || !DIARY_DATE.test(p.date) || seen.has(p.date)) continue;
      seen.add(p.date); // as it is accepted, so a date twice in one page counts once (the first wins)
      fresh.push(p);
    }
    if (fresh.length === 0) {
      partial = DIARY_STUCK; // the same page again (or items with no valid date): `until` is being ignored
      break;
    }
    list.push(...fresh);
    // the page's oldest valid date is the smallest one; the cursor only ever moves back
    const oldest = fresh.map((p) => p.date).reduce((a, b) => (b < a ? b : a));
    until = until != null && until < oldest ? until : oldest;
    if (++pages >= maxPages) {
      partial = DIARY_PAGE_CAP;
      break;
    }
  }
  const days = [];
  const dates = list.map((p) => p.date).sort(); // oldest first
  for (const date of dates) {
    let day;
    try {
      day = await call(`${DIARY_LIST}/${date}`, { auth, fetchFn, sleep });
    } catch (e) {
      if (e instanceof SignedOut) return { days, list, partial: e.message, signedOut: true };
      return { days, list, partial: DIARY_PARTIAL, signedOut: false };
    }
    if (!day || day.date !== date || !Array.isArray(day.entries)) return { days, list, partial: DIARY_PARTIAL, signedOut: false };
    days.push(day);
  }
  return { days, list, partial, signedOut: false };
}

// The memories, from both endpoints. A reply missing its array is a failure (not an
// empty list): the part that failed is named in partial and the other part's facts kept.
export async function readMemories({ auth, fetchFn = fetch, sleep = defaultSleep } = {}) {
  const out = { facts: [], customerFacts: [], robotFacts: [], partial: null, signedOut: false };
  let v14 = false, v15 = false;
  try {
    const reply = await call(MEMORY_V14, { auth, fetchFn, sleep });
    if (!Array.isArray(reply && reply.facts)) throw new Error("not a memory list");
    out.facts = reply.facts;
  } catch (e) {
    if (e instanceof SignedOut) return { ...out, partial: e.message, signedOut: true };
    v14 = true;
  }
  try {
    const reply = await call(MEMORY_V15, { auth, fetchFn, sleep });
    if (!Array.isArray(reply && reply.customer_facts) || !Array.isArray(reply && reply.robot_facts)) {
      throw new Error("not a memory list");
    }
    out.customerFacts = reply.customer_facts;
    out.robotFacts = reply.robot_facts;
  } catch (e) {
    if (e instanceof SignedOut) return { ...out, partial: e.message, signedOut: true };
    v15 = true;
  }
  out.partial = v14 && v15 ? MEMORY_BOTH_PARTIAL : v14 ? MEMORY_V14_PARTIAL : v15 ? MEMORY_V15_PARTIAL : null;
  return out;
}

// The chat history's state machine, kept apart from the socket so the tests can pin the
// paging rules exactly: the cursor is the id of the message with the smallest timestamp
// in the batch (ties keep the first in array order; undated messages never cursor), a
// batch that adds nothing unseen or pages from the same cursor again is a stuck guard,
// and everything collected sorts oldest first with undated messages last.
export function createHistoryPager({ auth, chatId, limit = 1000, uuid } = {}) {
  const token = typeof uuid === "function" ? uuid : uuid != null ? () => uuid : () => crypto.randomUUID();
  const seen = new Set();
  const all = [];
  let cursor = null; // the id the next request pages backwards from
  const timeOf = (m) => Date.parse(m && m.meta && m.meta.timestamp);
  return {
    request() {
      const payload = { chat_id: chatId, limit };
      if (cursor != null) payload.last_message_id = cursor;
      return {
        event_name: "history",
        token: token(),
        auth: { user_id: auth.userId, auth_token: auth.authToken, device_id: auth.deviceId },
        payload,
      };
    },
    accept(reply) {
      if (!reply || reply.event_name !== "history") return { ignore: true };
      const batch = reply.payload && reply.payload.messages;
      if (!Array.isArray(batch)) return { error: HISTORY_NO_LIST };
      if (!batch.length) return { done: true };
      let added = 0;
      for (const m of batch) {
        const key = m && m.id != null ? m.id : m; // an idless message still counts once
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(m);
        added++;
      }
      // the cursor is the oldest timestamp in THIS batch, whichever end the array holds it
      let oldest = null, oldestTime = Infinity;
      for (let i = 0; i < batch.length; i++) {
        const t = timeOf(batch[i]);
        if (Number.isNaN(t)) continue;
        if (t < oldestTime) { oldestTime = t; oldest = batch[i]; }
      }
      if (!oldest) return { error: HISTORY_NO_DATE };
      const next = oldest.id;
      if (added === 0 || next === cursor) return { error: HISTORY_STUCK };
      cursor = next;
      return { next: true };
    },
    messages() {
      return all.slice().sort((a, b) => {
        const ta = timeOf(a), tb = timeOf(b);
        const na = Number.isNaN(ta), nb = Number.isNaN(tb);
        if (na && nb) return 0;
        if (na) return 1; // undated last, stable
        if (nb) return -1;
        return ta - tb;
      });
    },
    size() {
      return all.length;
    },
  };
}

// One pass over the history socket: open, send a request, accept each reply, send the
// next, close at done or error. Always resolves what was collected. The WebSocket
// constructor is the seam (the smoke swaps it); a socket that goes quiet past timeoutMs,
// or errors or closes before done, ends the pass with a fixed reason.
export function readHistory({ auth, chatId, WebSocketCtor, timeoutMs = 30000, onProgress, uuid } = {}) {
  const pager = createHistoryPager({ auth, chatId, uuid });
  return new Promise((resolve) => {
    let socket;
    let timer = null;
    let finished = false;
    const finish = (partial) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket) {
        try { socket.close(); } catch { /* a stand-in may not close */ }
      }
      resolve({ messages: pager.messages(), partial: partial || null });
    };
    const arm = () => {
      if (finished) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(HISTORY_SILENT), timeoutMs);
    };
    try {
      socket = new WebSocketCtor(HISTORY_SOCKET);
    } catch {
      resolve({ messages: [], partial: HISTORY_CLOSED });
      return;
    }
    const send = () => {
      arm();
      try {
        socket.send(JSON.stringify(pager.request()));
      } catch {
        finish(HISTORY_CLOSED);
      }
    };
    const onFrame = (e) => {
      if (finished) return;
      let reply;
      try {
        reply = JSON.parse(e.data);
      } catch {
        return; // not a reply; the quiet timer keeps running
      }
      const r = pager.accept(reply);
      if (r.ignore) return; // any other event name: keep waiting for the history reply
      clearTimeout(timer);
      if (onProgress) onProgress(pager.size());
      if (r.error) return finish(r.error);
      if (r.done) return finish(null);
      send();
    };
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("message", onFrame);
      socket.addEventListener("close", () => finish(HISTORY_CLOSED));
      socket.addEventListener("error", () => finish(HISTORY_CLOSED));
    } else {
      socket.onmessage = onFrame;
      socket.onclose = () => finish(HISTORY_CLOSED);
      socket.onerror = () => finish(HISTORY_CLOSED);
    }
    // a real WebSocket connects first and refuses send() until then; the smoke's
    // stand-in has no readyState and answers send() right away — send now when the
    // socket looks open or is a stand-in, else wait for its open event; the timer
    // covers the connect too, so a socket that never opens goes quiet
    // a socket already closing or closed (readyState 2 or 3) never opens: done at once
    if (socket.readyState === 2 || socket.readyState === 3) return finish(HISTORY_CLOSED);
    const ready = socket.readyState == null || socket.readyState === 1;
    if (ready) send();
    else {
      arm();
      if (typeof socket.addEventListener === "function") socket.addEventListener("open", () => send(), { once: true });
      else socket.onopen = () => send();
    }
  });
}

// A signed https URL for one piece of media, Replika's way: POST the raw link the
// message carried, get a signed one back. The signed URL must be https and not point at
// an IP literal or localhost — anything else is refused here, before any fetch. Answers
// the signed URL, or null when the link never became usable.
export async function signedImageUrl(rawUrl, { auth, fetchFn = fetch, sleep = defaultSleep } = {}) {
  const reply = await call(IMAGE_SIGNED, { method: "POST", body: { image_url: rawUrl }, auth, fetchFn, sleep });
  const signed = reply && reply.image_url;
  return typeof signed === "string" && usableMediaUrl(signed) ? signed : null;
}

// the check the signed URL and the voice link must pass before Leket fetches them
export function usableMediaUrl(u) {
  let p;
  try {
    p = new URL(u);
  } catch {
    return false;
  }
  if (p.protocol !== "https:" || !p.hostname) return false;
  if (p.hostname === "localhost" || p.hostname.endsWith(".localhost")) return false;
  if (p.hostname.includes(":")) return false; // a bracketed IPv6 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(p.hostname)) return false; // an IPv4 literal
  return true;
}
