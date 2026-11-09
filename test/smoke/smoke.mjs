// The extension smoke: loads this unpacked extension into a headless Chromium, opens the
// real popup (chrome.action.openPopup on the reddit or Discord tab) and presses its
// buttons, then checks what lands on disk. The unit tests stub the chrome.* APIs, so a
// wiring break (an offscreen document reaching for an API it doesn't get, a click
// listener that vanished, a re-save Chrome renames) passes them; this runs the popup,
// worker, offscreen and export-tab code a person's click runs. Not covered: the toolbar
// button itself, user-gesture checks (the presses are script clicks), and the Discord
// collector's panel — the smoke posts the collector's hand-off message to the bridge
// itself, so the Discord flow is covered from the bridge onward. The claude.ai pages
// (sessions, chat outputs) open from the popup too; the sessions export runs for real
// against a synthetic API, with two test-side levers set on its page: the 15-minute
// no-word wait shrunk to 0 ms and the download call's answer held until released, so
// the page hears nothing first and the part's late end after, on cue (the file itself
// is on disk at once; what's covered is the stop and the late-end narration). The chat
// page runs for real too: its org probe reads the chat tab's resource timeline, then it
// lists and downloads a synthetic chat's outputs and names a second chat that fails,
// then runs again and must replace that day's file, not add a renamed copy.
// The Etsy page, prefilled from the tab, pages a synthetic message-list endpoint and
// saves four times over one file: redact on with a colliding name, then again, then
// with no config from an emptied box (the tab's conversation), then with a second id
// that fails. Each scenario runs on its own: a throw fails it and the next one starts.
// Every page is synthetic and served from this file; no request leaves the machine:
// each target's requests are intercepted, DNS resolves nothing and no proxy is used.
//
//   npm run smoke            (LEKET_CHROME=/path/to/chrome to pick the browser;
//                             LEKET_SMOKE_KEEP=1 keeps the profile and downloads)
//
// The browser: a Chromium build that still honors --load-extension (branded Google
// Chrome dropped it). Without LEKET_CHROME it takes the newest Playwright Chromium in
// ~/.cache/ms-playwright (Linux only); none found exits 2 and says so, never a skipped
// pass. CI runs it on every pull request (.github/workflows/ci.yml).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { postPage } from "../fixtures/reddit.js";
import { NO_WORD_MS } from "../../src/lib/download.js";
import { redactSetup } from "../../src/modules/etsy/messages.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// auto-discovery is Linux-only: Playwright's Linux cache and its two Linux layouts (the
// current chrome-linux64, the older chrome-linux); elsewhere LEKET_CHROME names the browser
function findChrome() {
  if (process.env.LEKET_CHROME) return process.env.LEKET_CHROME;
  // "0" is Playwright's "under node_modules" setting: this repo has none, so the default cache
  const set = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const cache = set && set !== "0" ? set : join(homedir(), ".cache", "ms-playwright");
  const builds = existsSync(cache)
    ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    : [];
  for (const d of builds) {
    for (const layout of ["chrome-linux64", "chrome-linux"]) {
      const bin = join(cache, d, layout, "chrome");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

// ---- the synthetic web: every URL the flows may fetch, and nothing else ----
const REDDIT_POST = "https://www.reddit.com/r/x/comments/abc123/a_post/";
const REDDIT_JSON = "https://www.reddit.com/comments/abc123.json?raw_json=1&limit=500";
const redditBody = JSON.stringify(postPage({}, [
  { kind: "t1", data: { id: "c1", author: "someone_else", body: "a comment", score: 3, created_utc: 1699000100, replies: "" } },
  { kind: "more", data: { count: 2, parent_id: "t1_c1", children: ["x", "y"] } },
]));
const REDDIT_GALLERY = "https://www.reddit.com/r/x/comments/def456/a_gallery/";
const REDDIT_GALLERY_JSON = "https://www.reddit.com/comments/def456.json?raw_json=1&limit=500";
const SMOKE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SMOKE_IMG_A = "https://i.redd.it/smokea.png";
const SMOKE_IMG_B = "https://preview.redd.it/smokeb.jpg";
const SMOKE_IMG_C = "https://images.example.org/smokec.png";
// served, but the save must never ask for them: a non-https one and a loopback one
const SMOKE_IMG_D = "http://images.example.org/smoked.png";
const SMOKE_IMG_E = "https://127.0.0.1/smokee.png";
// named over http on reddit's own host: the save upgrades it and fetches the https URL
const SMOKE_IMG_F = "http://i.redd.it/smokef.png";
const SMOKE_IMG_F_HTTPS = "https://i.redd.it/smokef.png";
const redditGalleryBody = JSON.stringify(postPage({
  id: "def456",
  permalink: "/r/x/comments/def456/a_gallery/",
  is_gallery: true,
  is_self: false,
  selftext: "",
  gallery_data: { items: [{ media_id: "a" }, { media_id: "b" }, { media_id: "c" }, { media_id: "d" }, { media_id: "e" }, { media_id: "f" }] },
  media_metadata: {
    a: { status: "valid", m: "image/png", s: { u: SMOKE_IMG_A } },
    b: { status: "valid", m: "image/jpg", s: { u: SMOKE_IMG_B } },
    c: { status: "valid", m: "image/png", s: { u: SMOKE_IMG_C } },
    d: { status: "valid", m: "image/png", s: { u: SMOKE_IMG_D } },
    e: { status: "valid", m: "image/png", s: { u: SMOKE_IMG_E } },
    f: { status: "valid", m: "image/png", s: { u: SMOKE_IMG_F } },
  },
}, []));
const DISCORD_DM = "https://discord.com/channels/@me/111";
const ATTACHMENT = "https://cdn.discordapp.com/attachments/1/2/note.txt";
const ATTACHMENT_BODY = "hello";
const discordExport = {
  channel: "smoke", guild_name: null,
  messages: [{ id: "10", datetime: "2021-01-01T10:00:00.000Z", author: "Alice", author_id: "1", nick: null,
    text: "a message with a file", reply_to: null, embeds: [],
    attachments: [{ filename: "note.txt", url: ATTACHMENT, size: ATTACHMENT_BODY.length }] }],
};
const html = (title) => `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
// claude.ai: a /code page and a chat page for the popup to match, the session listing
// (one new session, one the pasted known map marks unchanged) and the new one's events
const CLAUDE_CODE = "https://claude.ai/code";
const CLAUDE_CHAT = "https://claude.ai/chat/00000000-0000-4000-8000-000000000000";
const SESSIONS_API = "https://claude.ai/v1/code/sessions";
const NEW_SESSION = "cse_smokenew";
const KNOWN_SESSION = "cse_smokeknown";
const EARLIER_SESSION = "cse_smokeearlier"; // in the pasted resume line only: never listed
const listing = (data) => JSON.stringify({ data, next_cursor: null });
// claude chat: the chat page's own script calls an org-scoped API, so the org probe finds
// the org in the tab's resource timeline; one chat lists an upload and an output (only
// the output is fetched), the other's listing answers 404
const ORG = "00000000-0000-4000-8000-0000000000aa";
const ORG_API = `https://claude.ai/api/organizations/${ORG}/`;
const CHAT_OK = "00000000-0000-4000-8000-000000000001";
const CHAT_GONE = "00000000-0000-4000-8000-000000000002";
const wiggle = (chat) => `${ORG_API}conversations/${chat}/wiggle/`;
const REPORT_PATH = "/mnt/user-data/outputs/report.md";
const REPORT = "# a report\n\nan output's text\n";
const chatPage = `<!doctype html><html><head><title>a claude chat</title></head><body><p>a claude chat</p>`
  + `<script>fetch(${JSON.stringify(`/api/organizations/${ORG}/ping`)})</script></body></html>`;
// etsy: a conversation page for the popup to match and prefill from, its message-list
// pages, and a redact config whose name (the unit tests' synthetic one) also catches
// "etsy" — so the page's redact line carries the collision warning
const ETSY_ID = "424242";
const ETSY_CONVO = `https://www.etsy.com/messages/${ETSY_ID}`;
const ETSY_GONE = "999999";
const etsyPage = (offset, id = ETSY_ID) => `https://www.etsy.com/api/v3/ajax/member/conversations/detail/${id}/message-list?offset=${offset}&fetch_older=true&load_shop_convos=false`;
const ETSY_REDACT = { name: "betsy", short: "bpt", firstSounds: "bpt" };
const WEB = new Map([
  [REDDIT_POST, { type: "text/html", body: html("a reddit post") }],
  [REDDIT_JSON, { type: "application/json", body: redditBody }],
  [REDDIT_GALLERY, { type: "text/html", body: html("a reddit gallery") }],
  [REDDIT_GALLERY_JSON, { type: "application/json", body: redditGalleryBody }],
  [SMOKE_IMG_A, { type: "image/png", body: SMOKE_PNG }],
  [SMOKE_IMG_B, { type: "text/html", body: html("removed") }],
  [SMOKE_IMG_C, { type: "image/png", body: SMOKE_PNG }],
  [SMOKE_IMG_D, { type: "image/png", body: SMOKE_PNG }],
  [SMOKE_IMG_E, { type: "image/png", body: SMOKE_PNG }],
  [SMOKE_IMG_F_HTTPS, { type: "image/png", body: SMOKE_PNG }],
  [DISCORD_DM, { type: "text/html", body: html("a discord dm") }],
  [ATTACHMENT, { type: "text/plain", body: ATTACHMENT_BODY }],
  [CLAUDE_CODE, { type: "text/html", body: html("a claude code page") }],
  [CLAUDE_CHAT, { type: "text/html", body: chatPage }],
  [`${ORG_API}ping`, { type: "application/json", body: "{}" }],
  [`${wiggle(CHAT_OK)}list-files?prefix=`, { type: "application/json", body: JSON.stringify({ files_metadata: [
    { path: "/mnt/user-data/uploads/input.txt", size: 5, created_at: "2021-01-04T00:00:00Z", content_type: "text/plain" },
    { path: REPORT_PATH, size: Buffer.byteLength(REPORT), created_at: "2021-01-04T00:01:00Z", content_type: "text/markdown" },
  ] }) }],
  [`${wiggle(CHAT_OK)}download-file?path=${encodeURIComponent(REPORT_PATH)}`, { type: "text/markdown", body: REPORT }],
  [`${wiggle(CHAT_GONE)}list-files?prefix=`, { type: "application/json", body: "{}", status: 404 }],
  [`${SESSIONS_API}?statuses=active&limit=50`, { type: "application/json", body: listing([
    { id: NEW_SESSION, title: "a new session", last_event_at: "2021-01-03T00:00:00Z" },
    { id: KNOWN_SESSION, title: "an archived session", last_event_at: "2021-01-01T00:00:00Z" },
  ]) }],
  [`${SESSIONS_API}?statuses=paused&limit=50`, { type: "application/json", body: listing([]) }],
  [`${SESSIONS_API}?statuses=archived&limit=50`, { type: "application/json", body: listing([]) }],
  [`${SESSIONS_API}/${NEW_SESSION}/events?limit=500`, { type: "application/json", body: listing([
    { event_type: "user", created_at: "2021-01-03T00:00:00Z", sequence_num: 1, payload: { text: "an event" } },
  ]) }],
  [ETSY_CONVO, { type: "text/html", body: html("an etsy conversation") }],
  // the walk: one page of two messages, then an empty page that ends it
  [etsyPage(0), { type: "application/json", body: JSON.stringify({ messages: [
    { conversation_message_id: 1, create_date: 1609495200, message_order: 1, message: "hello from betsy" },
    { conversation_message_id: 2, create_date: 1609495260, message_order: 2, message: "hi Betsy, thanks" },
  ] }) }],
  [etsyPage(2), { type: "application/json", body: JSON.stringify({ messages: [] }) }],
  // a second conversation whose first page fails: the failure list's one line
  [etsyPage(0, ETSY_GONE), { type: "application/json", body: "{}", status: 500 }],
]);

// ---- a small CDP client over Node's own WebSocket ----
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { ok, fail } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? fail(new Error(`${m.error.message} (${m.error.code})`)) : ok(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    });
    // a dead browser answers nothing: every waiting call fails instead of hanging
    this.closed = null;
    ws.addEventListener("close", () => {
      this.closed = Object.assign(new Error("the browser's DevTools connection closed (did the browser crash?)"), { fatal: true });
      for (const { fail } of this.pending.values()) fail(this.closed);
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((ok, fail) => {
      if (this.closed) return fail(this.closed);
      const id = ++this.id;
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(h) { this.handlers.push(h); }
}

const failures = [];
const blocked = [];
// every URL the browser asked for, served or not: proves a request was never made
const requested = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
// a wait's catch that turns its timeout into an answer for the check after it — but
// never a dead browser's (fatal) error, which ends the run with its own message
const soft = (answer) => (e) => { if (e && e.fatal) throw e; return answer(e); };
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    // a dead browser won't come back: say so now, not after this wait's whole timeout
    try { last = await fn(); if (last) return last; } catch (e) { if (e && e.fatal) throw e; last = e; }
    await sleep(150);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what} (last ${last instanceof Error ? `error: ${last.message}` : `answer: ${JSON.stringify(last)}`})`);
}

async function main() {
  const bin = findChrome();
  if (!bin || !existsSync(bin)) {
    console.error("smoke: no Chromium found. Set LEKET_CHROME to a Chromium binary that honors --load-extension "
      + "(a Playwright Chromium works: npx playwright install chromium), then run npm run smoke again. "
      + "Without LEKET_CHROME the smoke looks only in Playwright's Linux cache (~/.cache/ms-playwright or PLAYWRIGHT_BROWSERS_PATH).");
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), "leket-smoke-"));
  const profile = join(work, "profile");
  const downloads = join(work, "downloads");
  mkdirSync(join(profile, "Default"), { recursive: true });
  mkdirSync(downloads);
  // chrome.downloads keeps the extension's file names only with a profile download
  // folder; CDP's Browser.setDownloadBehavior renames every file to its own choice
  writeFileSync(join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));

  const browser = spawn(bin, [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`,
    // no proxy: a proxy would take the hostnames the resolver rule refuses
    "--host-resolver-rules=MAP * ~NOTFOUND", "--no-proxy-server", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  // the browser's own process group, killed whole: killing the main process alone leaves
  // its zygotes and renderers running. On every way out — a finish, a throw, Ctrl-C, a
  // closed pipe — since a smoke cut short once left a browser behind
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { process.kill(-browser.pid, "SIGKILL"); } catch { /* already gone */ }
    if (process.env.LEKET_SMOKE_KEEP) console.log(`smoke: kept ${work}`);
    else {
      // a dying browser may still write a file: retry, and never let cleanup change the result
      try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (e) { console.error(`smoke: couldn't remove ${work}: ${e.message}`); }
    }
  };
  process.on("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stop(); process.exit(1); });
  let stderr = "";
  // what the browser said: its FATAL and ERROR lines first (a crash's stack trace runs
  // long and would push the line naming the cause out of the tail), then the tail
  const said = () => {
    // FATAL first: a runner prints many unrelated early ERROR lines (dbus, gpu)
    const lines = stderr.split("\n");
    const causes = [...lines.filter((l) => l.includes(":FATAL:")), ...lines.filter((l) => l.includes(":ERROR:"))].slice(0, 10);
    return `${causes.length ? `${causes.join("\n")}\n  ...\n` : ""}${stderr.slice(-2000)}`;
  };
  try {
    const wsUrl = await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`the browser printed no DevTools address in 20s:\n${said()}`)), 20000);
      browser.on("exit", (code) => fail(new Error(`the browser exited (${code}) before it was ready:\n${said()}`)));
      browser.stderr.on("data", (d) => {
        stderr += d;
        const m = /DevTools listening on (ws:\S+)/.exec(stderr);
        if (m) { clearTimeout(t); ok(m[1]); }
      });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => { ws.addEventListener("open", ok); ws.addEventListener("error", fail); });
    const cdp = new Cdp(ws);
    console.log(`smoke: ${(await cdp.send("Browser.getVersion")).product} (${bin})`);
    browser.on("exit", (code, sig) => console.error(`smoke: the browser exited mid-run (${code ?? sig})`));
    // a whole run takes seconds; a call that never answers fails the run, never hangs it
    let watchdog;
    const limit = new Promise((_, fail) => { watchdog = setTimeout(() => fail(new Error("the run took over 5 minutes")), 300_000); });
    try { return await Promise.race([scenarios(cdp, downloads), limit]); } finally { clearTimeout(watchdog); }
  } finally {
    stop();
  }
}

async function scenarios(cdp, downloads) {
  // every target, as it appears: intercept its requests before it runs a line
  const sessions = new Map(); // targetId -> { sessionId, type, url }
  // interception on a target that fetches: a failure is said, not swallowed (the DNS wall
  // still keeps such a target offline, but "every request is served" would no longer hold).
  // It is a log line, not a FAIL. A dead browser's error is rethrown, which ends the run
  // from target(); in the attach handler below it is dropped, since the next call fails
  // the same way
  const intercept = (sessionId, type, url) => cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId).catch((e) => {
    if (e && e.fatal) throw e;
    if (type === "page" || type === "service_worker") console.log(`smoke: no interception on ${type} ${url}: ${e.message}`);
  });
  cdp.on(async (m) => {
    if (m.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = m.params;
      sessions.set(targetInfo.targetId, { sessionId, type: targetInfo.type, url: targetInfo.url });
      await intercept(sessionId, targetInfo.type, targetInfo.url).catch(() => {});
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    } else if (m.method === "Target.targetInfoChanged") {
      const s = sessions.get(m.params.targetInfo.targetId);
      if (s) s.url = m.params.targetInfo.url;
    } else if (m.method === "Target.detachedFromTarget") {
      for (const [id, s] of sessions) if (s.sessionId === m.params.sessionId) sessions.delete(id);
    } else if (m.method === "Fetch.requestPaused") {
      const { requestId, request } = m.params;
      requested.push(request.url);
      const page = WEB.get(request.url);
      if (page) {
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: page.status || 200,
          responseHeaders: [{ name: "content-type", value: page.type }, { name: "content-length", value: String(Buffer.byteLength(page.body)) }],
          body: Buffer.from(page.body).toString("base64") }, m.sessionId).catch(() => {});
      } else if (/^(https?|wss?|ftp):/.test(request.url)) {
        blocked.push(request.url);
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, m.sessionId).catch(() => {});
      } else {
        await cdp.send("Fetch.continueRequest", { requestId }, m.sessionId).catch(() => {});
      }
    }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}] });

  // the target matching pred, with a session of our own on it: auto-attach doesn't reach
  // every target (a popup hangs off its tab), so one it missed is attached here — and
  // one that never shows says which ones did
  const target = (pred, what, ms) => waitFor(async () => {
    const info = (await cdp.send("Target.getTargets")).targetInfos.find(pred);
    if (!info) return false;
    if (!sessions.has(info.targetId)) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      if (!sessions.has(info.targetId)) sessions.set(info.targetId, { sessionId, type: info.type, url: info.url });
      await intercept(sessionId, info.type, info.url);
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
    return { ...sessions.get(info.targetId), targetId: info.targetId, type: info.type, url: info.url };
  }, what, ms).catch(async (e) => {
    const all = (await cdp.send("Target.getTargets")).targetInfos.map((t) => `${t.type} ${t.url}${t.attached ? "" : " (not attached)"}`);
    throw new Error(`${e.message}\n  targets now:\n    ${all.join("\n    ")}`);
  });
  const evalIn = async (sessionId, expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // the harness's own hands inside the extension: an extension page it holds open for the
  // whole run. Not the worker — Chrome stops an idle worker and starts a new one, which
  // took a listener with it and once answered an evaluate with no chrome.* at all
  const sw = await target((s) => s.type === "service_worker" && s.url.endsWith("/src/background.js"), "the extension's service worker");
  // protocol + host: Node's URL gives a chrome-extension: url the origin "null"
  const ext = new URL(sw.url);
  const helperUrl = `${ext.protocol}//${ext.host}/src/popup/popup.html?smoke-helper`;
  const { targetId: helperId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const helper = await target((x) => x.targetId === helperId, "the helper page");
  await cdp.send("Page.navigate", { url: helperUrl }, helper.sessionId);
  await waitFor(() => evalIn(helper.sessionId, `location.href === ${JSON.stringify(helperUrl)} && typeof chrome.action?.openPopup === "function" && typeof chrome.downloads === "object"`), "the helper page's chrome.* APIs");
  const extEval = (expression) => evalIn(helper.sessionId, expression);

  const open = async (url) => {
    // blank first, then navigate: the tab's requests are intercepted only once a session
    // is on it, and a page that loaded before that is Chrome's error page
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const s = await target((x) => x.targetId === targetId, `the tab for ${url}`);
    await cdp.send("Page.navigate", { url }, s.sessionId);
    const title = await waitFor(() => evalIn(s.sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === "complete" && document.title`), `${url} to load`);
    if (!check(WEB.get(url).body.includes(`<title>${title}</title>`), `${url} is the synthetic page (title: ${title})`)) throw new Error(`${url} didn't load from the synthetic web`);
    await cdp.send("Target.activateTarget", { targetId });
    return s;
  };
  // the toolbar click: the real popup, on the active tab, and its button for this command
  const clickPopup = async (label) => {
    await extEval("chrome.action.openPopup()");
    const popup = await target((s) => s.type === "page" && s.url.endsWith("/src/popup/popup.html"), "the popup");
    await waitFor(() => evalIn(popup.sessionId,
      `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`),
    `the popup button "${label}"`);
    return popup;
  };
  const landed = () => readdirSync(downloads).filter((f) => !f.endsWith(".crdownload")).sort();
  // a module page's script ran, its whole import graph with it: its run button has a
  // click listener. The HTML is static, so any element shows up even when page.js fails
  // to load. A readyState "complete" wait once let a click land with no listener yet —
  // unexplained (a module script normally holds up load; the first evaluate may have
  // reached a document mid-navigation), and this poll doesn't depend on the cause
  const wired = async (sessionId, button, what) => {
    const ok = await waitFor(async () => {
      const r = await cdp.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true,
        expression: `(() => { const b = document.getElementById(${JSON.stringify(button)}); return !!b && (getEventListeners(b).click || []).length > 0; })()` }, sessionId);
      return r.result.value === true;
    }, `${what}: page.js to wire #${button}`).catch(soft(() => false));
    if (!check(ok, `${what}: the page's script and its imports loaded (#${button} has its click listener)`)) throw new Error(`${what}: page.js never ran`);
  };

  // one module's scenario: a throw inside it (a page that never wired, a target that never
  // showed) fails that scenario and the run moves on to the next one; its cleanup, and the
  // closing of every page it opened (tabs, module pages, popups — all but the helper), run
  // either way, and a failed cleanup fails the scenario. A dead browser (fatal) ends the run
  const scenario = async (name, body, cleanup) => {
    try {
      await body();
    } catch (e) {
      if (e && e.fatal) throw e;
      check(false, `${name}: the scenario stopped: ${(e && e.message) || e}`);
    } finally {
      if (cleanup) await cleanup().catch(soft((e) => check(false, `${name}: its cleanup failed: ${e.message}`)));
      const { targetInfos } = await cdp.send("Target.getTargets").catch(soft(() => ({ targetInfos: [] })));
      for (const t of targetInfos) {
        if (t.type === "page" && t.targetId !== helperId) await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }
    }
  };

  // ---- reddit: popup -> worker -> offscreen document -> worker downloads, twice ----
  await scenario("reddit", async () => {
    console.log("smoke: reddit save");
    await open(REDDIT_POST);
    for (const round of [1, 2]) {
      const popup = await clickPopup("Save this post as Markdown");
      const line = await waitFor(() => evalIn(popup.sessionId,
        `(() => { const p = document.getElementById("card").lastElementChild; const t = p && !p.hidden ? p.textContent : ""; return t && t !== "Working…" ? { t, warn: p.classList.contains("warn") } : false; })()`),
      "the popup's result line", 30000);
      check(!line.warn, `reddit save ${round}: the popup reports success (it said: ${line.t})`);
      check(line.t.includes("2 more comments weren't fetched"), `reddit save ${round}: the popup notes unfetched comments (it said: ${line.t})`);
      // Chrome's own count of finished reddit saves: two per round. The files on disk can't
      // show a second round happened — the first left the very same bytes
      const done = await waitFor(() => extEval(`chrome.downloads.search({ filenameRegex: "reddit-abc123", state: "complete" }).then((d) => d.length)`)
        .then((n) => n >= 2 * round && n), `round ${round}'s two finished downloads`).catch(soft((e) => e.message));
      check(done === 2 * round, `reddit save ${round}: Chrome finished ${2 * round} reddit downloads so far (${done})`);
      await sleep(500); // a duplicate save would have a moment to land: Chrome's count, read again, still matches
      const settled = await extEval(`chrome.downloads.search({ filenameRegex: "reddit-abc123" }).then((d) => d.length)`);
      check(settled === 2 * round, `reddit save ${round}: no further reddit download started (${settled} in Chrome's list)`);
      // its own files only: no scenario's position in the run depends on another's downloads
      const mine = landed().filter((f) => f.startsWith("reddit-abc123"));
      check(JSON.stringify(mine) === JSON.stringify(["reddit-abc123.json", "reddit-abc123.md"]),
        `reddit save ${round}: exactly reddit-abc123.json + .md on disk, no renamed copy (found: ${mine.join(", ")})`);
      if (existsSync(join(downloads, "reddit-abc123.json"))) {
        check(readFileSync(join(downloads, "reddit-abc123.json"), "utf8") === redditBody, `reddit save ${round}: the json is the post's json, byte for byte`);
      }
      await evalIn(popup.sessionId, "window.close()").catch(() => {});
      await waitFor(async () => !(await cdp.send("Target.getTargets")).targetInfos.some((t) => t.url.endsWith("/src/popup/popup.html")), "the popup to close");
    }
  });

  // ---- reddit images: gallery post with one good image, one HTML placeholder, one CORS-blocked host, one http and one loopback image never requested, one http reddit image upgraded to https ----
  await scenario("reddit images", async () => {
    console.log("smoke: reddit images save");
    await open(REDDIT_GALLERY);
    const popup = await clickPopup("Save this post as Markdown");
    const line = await waitFor(() => evalIn(popup.sessionId,
      `(() => { const p = document.getElementById("card").lastElementChild; const t = p && !p.hidden ? p.textContent : ""; return t && t !== "Working…" ? { t, warn: p.classList.contains("warn") } : false; })()`),
    "the popup's result line", 30000);
    check(!line.warn, `reddit images: the popup reports success (it said: ${line.t})`);
    check(line.t.includes("2 of 6 images saved in reddit-def456-images"), `reddit images: the popup reports 2 of 6 images saved (it said: ${line.t})`);
    check(requested.includes(SMOKE_IMG_F_HTTPS) && !requested.includes(SMOKE_IMG_F),
      "reddit images: the http i.redd.it image was fetched over https, never http");
    check(!requested.includes(SMOKE_IMG_D) && !requested.includes(SMOKE_IMG_E),
      `reddit images: the http and loopback images were never requested (asked for: ${requested.filter((u) => u === SMOKE_IMG_D || u === SMOKE_IMG_E).join(", ") || "neither"})`);
    const mine = landed().filter((f) => f.startsWith("reddit-def456"));
    check(JSON.stringify(mine) === JSON.stringify(["reddit-def456-images", "reddit-def456.json", "reddit-def456.md"]),
      `reddit images: folder, json and md on disk (found: ${mine.join(", ")})`);
    const imgDir = join(downloads, "reddit-def456-images");
    const imgs = existsSync(imgDir) ? readdirSync(imgDir).filter((f) => !f.endsWith(".crdownload")).sort() : [];
    check(JSON.stringify(imgs) === JSON.stringify(["01.png", "06.png"]),
      `reddit images: only 01.png and 06.png landed in reddit-def456-images, no 02.* to 05.* (found: ${imgs.join(", ") || "none"})`);
    for (const name of ["01.png", "06.png"]) {
      if (existsSync(join(imgDir, name))) {
        check(readFileSync(join(imgDir, name)).equals(SMOKE_PNG), `reddit images: ${name} has the exact served bytes`);
      } else {
        check(false, `reddit images: ${name} has the exact served bytes (missing)`);
      }
    }
    if (existsSync(join(downloads, "reddit-def456.md"))) {
      const md = readFileSync(join(downloads, "reddit-def456.md"), "utf8");
      check(md.includes("](<reddit-def456-images/01.png>)") && md.includes("](<reddit-def456-images/06.png>)"),
        "reddit images: the .md links 01.png and 06.png relatively");
      check([SMOKE_IMG_B, SMOKE_IMG_C, SMOKE_IMG_D, SMOKE_IMG_E].every((u) => md.includes(u)),
        "reddit images: the .md keeps remote links for the failed images");
    } else {
      check(false, "reddit images: reddit-def456.md exists on disk (missing)");
    }
  });

  // ---- discord: popup -> worker injects -> bridge -> export tab; the zip's first try is
  // cancelled, so the part's link must take a click to save it (the export tab's listener) ----
  await scenario("discord", async () => {
    console.log("smoke: discord save");
    // the cancel comes while Chrome is still asking for the file's name: a download can't
    // finish before that, so the cancel can't lose to a fast local blob (an onCreated
    // cancel could). Unarmed, the listener returns without suggesting and Chrome keeps
    // the extension's own name; the cleanup takes it off again
    await extEval(`(() => {
      self.smokeCancelArmed = true;
      self.smokeCancelled = null;
      self.smokeNaming = (d) => {
        if (!self.smokeCancelArmed) return;
        self.smokeCancelArmed = false;
        chrome.downloads.cancel(d.id).then(() => { self.smokeCancelled = d.id; }, (e) => { self.smokeCancelled = "failed: " + e.message; });
      };
      // live for the whole scenario: if a future Chrome treats this silent return as a
      // suggestion, a rename regression shows up here first
      chrome.downloads.onDeterminingFilename.addListener(self.smokeNaming);
      return true; })()`);
    const dm = await open(DISCORD_DM);
    const launcher = await clickPopup("Save this conversation");
    // a launch closes the popup; a refusal keeps it open with a warning that says why
    const launched = await waitFor(async () => {
      if (!(await cdp.send("Target.getTargets")).targetInfos.some((t) => t.targetId === launcher.targetId)) return "closed";
      const warn = await evalIn(launcher.sessionId, `document.querySelector("#card p.warn")?.textContent || ""`).catch(() => "");
      return warn && `warned: ${warn}`;
    }, "the popup to close (launched) or warn", 30000).catch(soft((e) => e.message));
    check(launched === "closed", `discord: the popup launches the save (${launched})`);
    await waitFor(() => evalIn(dm.sessionId, `document.documentElement.dataset.leketBridge === "1"`), "the bridge on the Discord tab");
    // what the collector posts when its Save is pressed (its panel needs Discord's own app)
    await evalIn(dm.sessionId, `window.postMessage({ type: "leket:export", id: 1, file: "discord-smoke-111.json",
      attachments: true, json: ${JSON.stringify(JSON.stringify(discordExport))} }, location.origin), true`);
    const tab = await target((s) => s.type === "page" && s.url.includes("/src/modules/discord/export.html"), "the export tab");
    const link = `document.querySelector("#downloads a")`;
    const first = await waitFor(() => evalIn(tab.sessionId, `${link}?.textContent.includes("didn't finish") && ${link}.textContent`),
      "the cancelled part's link to say it didn't finish", 30000);
    console.log(`     the cancelled first try shows on its link: ${first}`);
    // the cancel's promise may settle a moment after the link says so
    const cancelled = await waitFor(() => extEval("self.smokeCancelled"), "the smoke's cancel to settle", 5000).catch(soft(() => null));
    check(typeof cancelled === "number", `discord: the smoke cancelled the zip's first try (${cancelled})`);
    await evalIn(tab.sessionId, `${link}.click(), true`);
    // saved: the link says so, or the summary closed the tab — it closes only once every
    // part's saved() hook ran, which only the page's click listener can bring about here
    // (a bare a[download] click saves a file but never tells the page). Either way Chrome
    // holds a finished zip that isn't the cancelled try
    const after = await waitFor(async () => {
      if (!sessions.get(tab.targetId)) return { saved: true, how: "the export tab closed itself: every part saved" };
      const t = await evalIn(tab.sessionId, `${link}?.textContent || ""`);
      return t.endsWith("— saved") && { saved: true, how: t };
    }, "the clicked part to save", 30000).catch(soft((e) => ({ saved: false, how: e.message })));
    check(after.saved, `discord: a click on the part's link saves it (${after.how})`);
    // the cancelled try, by id (cancelled before it was named, its filename is empty, so a
    // name search can't find it), stays interrupted; and every zip Chrome knows, in any
    // state, is one other download — the retry — which completed
    // only a numeric id is searched: a soft-failed cancel (null, a "failed: …" string)
    // would make Chrome throw a schema error and end the scenario before the zip checks
    const [gone] = typeof cancelled === "number"
      ? await extEval(`chrome.downloads.search({ id: ${cancelled} }).then((d) => d.map((x) => [x.state, x.filename]))`)
      : [];
    const zipsSeen = await extEval(`chrome.downloads.search({ filenameRegex: "\\\\.zip$" }).then((d) => d.map((x) => [x.id, x.state]))`);
    const seen = zipsSeen.map(([id, state]) => `${id} ${state}`).join(", ") || "none";
    check(gone?.[0] === "interrupted", `discord: the cancelled try stays interrupted (${gone ? `${gone[0]}, filename "${gone[1]}"` : "not in Chrome's list"})`);
    check(zipsSeen.length === 1 && zipsSeen[0][0] !== cancelled && zipsSeen[0][1] === "complete",
      `discord: Chrome holds one other zip, the retry, complete (${seen}; cancelled: ${cancelled})`);
    const zips = landed().filter((f) => f.endsWith(".zip"));
    if (check(zips.length === 1, `discord: one zip on disk (found: ${zips.join(", ") || "none"})`)) {
      const names = JSON.parse(execFileSync("python3", ["-I", "-c",
        "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", join(downloads, zips[0])], { encoding: "utf8" }));
      check(names.includes("discord-smoke-111.json"), "discord: the zip holds the messages json");
      check(names.some((n) => n.endsWith("note.txt")), `discord: the zip holds the attachment (names: ${names.join(", ")})`);
    }
  },
  // the cleanup: disarmed and unhooked whatever happened above — a discord block that
  // failed before its first download must not leave the cancel waiting for a later
  // scenario's, nor the naming listener on every later download
  () => extEval(`(() => { self.smokeCancelArmed = false;
    if (self.smokeNaming) chrome.downloads.onDeterminingFilename.removeListener(self.smokeNaming);
    return true; })()`));

  // ---- claude sessions: popup -> the module's page -> a real export whose one part gets
  // no word from Chrome, stops the run, then lands late and rebuilds the resume line ----
  await scenario("sessions", async () => {
    console.log("smoke: claude sessions export");
    await open(CLAUDE_CODE);
    await clickPopup("Export sessions");
    const sp = (await target((s) => s.type === "page" && s.url.includes("/src/modules/claude-sessions/page.html#export"), "the sessions page")).sessionId;
    await wired(sp, "export-run", "sessions");
    // two test-side levers, set after load (page.js looks both up at call time): the
    // 15-minute no-word wait (NO_WORD_MS) becomes 0 ms, and the download call's answer is
    // held until released — Chrome saves the file at once, but the page hears of it only
    // after release, so it is silent first and its late end narrated after, every run.
    // Both live on this page's own window and chrome object, so no undo is needed: the
    // page closes with the scenario, and that is what keeps them out of later ones
    const levers = await evalIn(sp, `(() => {
      const st = window.setTimeout;
      window.setTimeout = (f, ms, ...a) => st(f, ms === ${NO_WORD_MS} ? 0 : ms, ...a);
      const dl = chrome.downloads.download.bind(chrome.downloads);
      const held = new Promise((r) => { window.smokeRelease = r; });
      const hold = (req) => { const p = dl(req); return held.then(() => p); };
      chrome.downloads.download = hold;
      return chrome.downloads.download === hold; })()`);
    if (!check(levers, "sessions: the smoke holds the page's download call (chrome.downloads.download is writable)")) throw new Error("no hold on the sessions page's download");
    // the generator's whole file, script tail included: only paste.js's strip parses it.
    // And a resume line from an earlier run, so the stop's recorded state (its pasted skip
    // and part numbering) shows in both resume lines below, apart from the landed ids
    await evalIn(sp, `document.getElementById("known").value = ${JSON.stringify(
      `window.CLAUDE_EXPORT_KNOWN = ${JSON.stringify({ [KNOWN_SESSION]: "2021-01-02T00:00:00Z" })};\n(() => { console.log("the console script"); })();\n`)};
      document.getElementById("resume").value = ${JSON.stringify(`window.CLAUDE_EXPORT_SKIP = ["${EARLIER_SESSION}"]; window.CLAUDE_EXPORT_PART_START = 2;`)};
      document.getElementById("export-run").click(), true`);
    const status = `(() => { const p = document.getElementById("export-status"); return { t: p.hidden ? "" : p.textContent, cls: p.className }; })()`;
    const resume = `document.getElementById("export-resume").textContent`;
    const silent = await waitFor(() => evalIn(sp, status).then((s) => s.t.includes("got no word from Chrome") && s), "the part to go silent and stop the run", 15000)
      .catch(soft((e) => ({ t: e.message })));
    check(/^Part claude-sessions-\S+-part03\.jsonl got no word from Chrome/.test(silent.t), `sessions: the silent part stops the run (it said: ${silent.t})`);
    check(await evalIn(sp, resume) === `window.CLAUDE_EXPORT_SKIP = ["${EARLIER_SESSION}"]; window.CLAUDE_EXPORT_PART_START = 2;`,
      `sessions: the stop's resume line names only what the earlier run saved (${await evalIn(sp, resume)})`);
    await evalIn(sp, "window.smokeRelease(), true");
    const late = await waitFor(() => evalIn(sp, status).then((s) => s.t.endsWith("landed — the resume line below is updated.") && s), "the silent part to land late", 15000)
      .catch(soft((e) => ({ t: e.message, cls: "" })));
    // every field the stop recorded shows here: message (the text's start), name (this
    // branch, not the other-part one), cls, and state + ids (the rebuilt line)
    check(late.t.startsWith(silent.t) && /The silent part \(claude-sessions-\S+-part03\.jsonl\) landed — /.test(late.t),
      `sessions: the late landing appends to the stop message (it said: ${late.t})`);
    check(late.cls === "warn", `sessions: the late line keeps the stop's warn class (${late.cls})`);
    check(await evalIn(sp, resume) === `window.CLAUDE_EXPORT_SKIP = ["${EARLIER_SESSION}","${NEW_SESSION}"]; window.CLAUDE_EXPORT_PART_START = 3;`,
      `sessions: the resume line is rebuilt with the landed part (${await evalIn(sp, resume)})`);
    check(await evalIn(sp, `document.getElementById("export-failures").children.length`) === 0, "sessions: no session failed (the known one was skipped, not fetched)");
    const parts = landed().filter((f) => f.startsWith("claude-sessions-"));
    if (check(parts.length === 1 && /-part03\.jsonl$/.test(parts[0]), `sessions: one part on disk, no done marker (found: ${parts.join(", ") || "none"})`)) {
      const [titles, ...events] = readFileSync(join(downloads, parts[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      check(Object.keys(titles._titles || {}).length === 2, "sessions: the part opens with both sessions' titles");
      check(events.length === 1 && events[0]._session === NEW_SESSION, `sessions: the part holds the new session's one event (${events.length})`);
    }
  });

  // ---- claude chat: popup -> the module's page, which parses a pasted whole file, then
  // runs a real list: org probe on the tab, list, download, one failed chat, the file ----
  await scenario("chat", async () => {
    console.log("smoke: claude chat outputs");
    const chatTab = await open(CLAUDE_CHAT);
    await clickPopup("Save chat outputs");
    const cp = (await target((s) => s.type === "page" && /\/src\/modules\/claude-chat\/page\.html\?tab=\d+$/.test(s.url), "the chat outputs page (with its tab id)")).sessionId;
    await wired(cp, "outputs-run", "chat");
    // an empty list in the generator's whole-file form: past the strip it parses and is
    // refused as empty; without page.js or its imports the click says nothing at all
    await evalIn(cp, `document.getElementById("chats").value = ${JSON.stringify(
      `window.CLAUDE_OUTPUT_CHATS = [];\n(() => { console.log("the console script"); })();\n`)};
      document.getElementById("outputs-run").click(), true`);
    const said = await waitFor(() => evalIn(cp, `(() => { const p = document.getElementById("outputs-status"); return !p.hidden && p.textContent; })()`),
      "the chat page's status line", 15000).catch(soft((e) => e.message));
    check(said.startsWith("The chat list is empty."), `chat: the page parses the pasted file and refuses the empty list (it said: ${said})`);

    // the real run: the probe needs the tab's org call in its timeline first
    const seen = await waitFor(() => evalIn(chatTab.sessionId, `performance.getEntriesByType("resource").some((e) => e.name.includes("/api/organizations/"))`),
      "the chat tab's org call in its resource timeline").catch(soft(() => false));
    check(seen === true, "chat: the chat tab's own org call is in its resource timeline");
    // the empty list's line is blanked with the click, so the wait reads this run's end
    await evalIn(cp, `(() => { const p = document.getElementById("outputs-status"); p.textContent = ""; p.className = "";
      document.getElementById("chats").value = ${JSON.stringify(JSON.stringify([[CHAT_OK, "a chat", "smoke"], [CHAT_GONE, "a gone chat", "smoke"]]))};
      document.getElementById("outputs-run").click(); return true; })()`);
    const end = await waitFor(() => evalIn(cp, `(() => { const p = document.getElementById("outputs-status");
      const t = p.hidden ? "" : p.textContent;
      return (t.startsWith("Done:") || p.className === "warn") && { t, cls: p.className,
        fails: [...document.getElementById("outputs-failures").children].map((li) => li.textContent) }; })()`),
    "the chat page's end line", 15000).catch(soft((e) => ({ t: e.message, fails: [] })));
    const name = landed().find((f) => f.startsWith("claude-chat-outputs-"));
    check(end.t === `Done: 2 chats, 1 files saved to ${name}. 1 chat(s) failed — their entries carry an "error".` && end.cls === "warn",
      `chat: the run probes the org, saves one output and names the failed chat (it said: ${end.t} [${end.cls}])`);
    check(JSON.stringify(end.fails) === JSON.stringify([`${CHAT_GONE}: 404 list-files?prefix=`]), `chat: the failure list names the gone chat (${JSON.stringify(end.fails)})`);
    if (check(/^claude-chat-outputs-\d{4}-\d{2}-\d{2}\.json$/.test(name || ""), `chat: the dated file is on disk (${name})`)) {
      const [ok, gone] = JSON.parse(readFileSync(join(downloads, name), "utf8"));
      check(ok?.chat === CHAT_OK && ok.files.length === 1 && ok.files[0].path === REPORT_PATH && ok.files[0].text === REPORT && !ok.files[0].size_mismatch,
        "chat: the file holds the one output, as text, at its size (the upload was not fetched)");
      check(gone?.chat === CHAT_GONE && gone.error === "404 list-files?prefix=" && gone.files.length === 0, `chat: the gone chat's entry carries its error (${gone?.error})`);
    }

    // a same-day re-save replaces the day's file: no "(1)" copy beside it
    await evalIn(cp, `(() => { const p = document.getElementById("outputs-status"); p.textContent = ""; p.className = "";
      document.getElementById("outputs-run").click(); return true; })()`);
    const again = await waitFor(() => evalIn(cp, `(() => { const p = document.getElementById("outputs-status"); const t = p.hidden ? "" : p.textContent;
      return (t.startsWith("Done:") || (p.className === "warn" && t !== "")) && t; })()`), "the chat page's second end line", 15000).catch(soft((e) => e.message));
    const twice = await waitFor(() => extEval(`chrome.downloads.search({ filenameRegex: "claude-chat-outputs-", state: "complete" }).then((d) => d.length)`)
      .then((n) => n >= 2 && n), "the second chat save to finish").catch(soft((e) => e.message));
    check(twice === 2 && again.startsWith("Done: 2 chats, 1 files saved to"), `chat: a second run saves again (${twice} finished; it said: ${again})`);
    await sleep(500); // a stray third save would have a moment to land: Chrome's count, read again, still matches
    const settled = await extEval(`chrome.downloads.search({ filenameRegex: "claude-chat-outputs-" }).then((d) => d.length)`);
    check(settled === 2, `chat: no further chat download started (${settled} in Chrome's list)`);
    const files = landed().filter((f) => f.startsWith("claude-chat-outputs-"));
    // one file, or two when a UTC midnight fell between the runs — never a "(1)" copy
    check(files.length >= 1 && files.length <= 2 && files.every((f) => /^claude-chat-outputs-\d{4}-\d{2}-\d{2}\.json$/.test(f)) && (files.length === 1 || files[1] > files[0]),
      `chat: the second run replaced the day's file, no renamed copy (found: ${files.join(", ")})`);
  });

  // ---- etsy: popup -> the module's page, prefilled from the tab, which pages the synthetic
  // message-list endpoint under a stored redact config whose name collides with Etsy's own
  // words, and saves over one file four times: redact on twice, then off from an emptied
  // box, then with a second id that fails ----
  await scenario("etsy", async () => {
    console.log("smoke: etsy save");
    await extEval(`chrome.storage.local.set({ etsyRedact: ${JSON.stringify(ETSY_REDACT)} }).then(() => true)`);
    await open(ETSY_CONVO);
    await clickPopup("Save conversations");
    const etsyPageTarget = await target((s) => s.type === "page" && /\/src\/modules\/etsy\/page\.html\?tab=\d+$/.test(s.url), "the Etsy page (with its tab id)");
    const ep = etsyPageTarget.sessionId;
    await wired(ep, "etsy-run", "etsy");
    const prefilled = await waitFor(() => evalIn(ep, `document.getElementById("ids").value`), "the ids box to prefill from the tab")
      .catch(soft((e) => e.message));
    check(prefilled === ETSY_ID, `etsy: the ids box prefills from the tab's address (${prefilled})`);
    const etsyState = `(() => { const s = document.getElementById("etsy-status"), r = document.getElementById("etsy-redact"), b = document.getElementById("etsy-bar");
      return { t: s.hidden ? "" : s.textContent, cls: s.className, rt: r.hidden ? "" : r.textContent, rcls: r.className,
        bar: b.hidden ? null : [b.value, b.max], fails: [...document.getElementById("etsy-fails").children].map((li) => li.textContent) }; })()`;
    // one save: the box set to ids (null leaves it as it is), the lines blanked with the
    // click — a round's "Saved" stays up until the next run's first progress line, and
    // each round must read its own end — then its end line, Chrome's finished count and
    // the file on disk
    const first = {}; // round 1's file name and extracted_at
    const save = async (round, ids) => {
      await evalIn(ep, `(() => { for (const id of ["etsy-status", "etsy-redact"]) { const p = document.getElementById(id); p.textContent = ""; p.className = ""; }
        ${ids === null ? "" : `document.getElementById("ids").value = ${JSON.stringify(ids)};`}
        document.getElementById("etsy-run").click(); return true; })()`);
      // progress lines ("Conversation 1/1 …", "Saving…") carry no class, so any warn line is an end
      const end = await waitFor(() => evalIn(ep, etsyState).then((s) => (s.t.startsWith("Saved") || s.t.startsWith("The download") || s.cls === "warn") && s),
        `etsy save ${round}'s end line`, 20000).catch(soft((e) => ({ t: e.message, fails: [] })));
      const done = await waitFor(() => extEval(`chrome.downloads.search({ filenameRegex: "etsy-conversations-", state: "complete" }).then((d) => d.length)`)
        .then((n) => n >= round && n), `etsy round ${round}'s finished download`).catch(soft((e) => e.message));
      check(done === round, `etsy save ${round}: Chrome finished ${round} Etsy download(s) so far (${done})`);
      await sleep(500); // a renamed copy would have a moment to land: Chrome's count, read again, still matches
      const settled = await extEval(`chrome.downloads.search({ filenameRegex: "etsy-conversations-" }).then((d) => d.length)`);
      check(settled === round, `etsy save ${round}: no further Etsy download started (${settled} in Chrome's list)`);
      // one dated file, overwritten each round. Named by the UTC date, so a midnight UTC
      // between rounds puts the later rounds' file beside round 1's; the name is read
      // from disk, not recomputed here, so a midnight between the page's naming and this
      // check can't redden it (sorted, a later date sorts after round 1's)
      const files = landed().filter((f) => f.startsWith("etsy-"));
      const name = files[files.length - 1];
      const shapeOk = round === 1 ? files.length === 1
        : files[0] === first.name && (files.length === 1 || (files.length === 2 && name > first.name));
      let saved = null, text = "";
      if (check(shapeOk && files.every((f) => /^etsy-conversations-\d{4}-\d{2}-\d{2}\.json$/.test(f)),
        `etsy save ${round}: one dated file on disk, no renamed copy (found: ${files.join(", ") || "none"})`)) {
        text = readFileSync(join(downloads, name), "utf8");
        saved = JSON.parse(text);
        // each round's file is that round's: the overwrite replaced the content, not just ran
        if (round === 1) Object.assign(first, { name, at: saved.extracted_at });
        else check(typeof saved.extracted_at === "string" && saved.extracted_at !== first.at,
          `etsy save ${round}: the file is this save's (extracted_at ${first.at} -> ${saved.extracted_at})`);
        first.at = saved.extracted_at;
      }
      // the later rounds compare against round 1's file: without it each would fail for
      // round 1's reason, so the scenario stops here with that reason alone
      if (round === 1 && !first.name) throw new Error("etsy save 1 landed no file, so the overwrite rounds have nothing to compare against");
      return { end, saved, text };
    };

    // rounds 1 and 2: redact on, with a name that also catches "etsy"
    const expectedRedact = redactSetup(ETSY_REDACT).line;
    for (const round of [1, 2]) {
      const { end, saved, text } = await save(round, null);
      check(end.t === "Saved 1 conversation, 2 messages. Redact: on." && end.cls === "ok",
        `etsy save ${round}: the page reports a clean save (it said: ${end.t} [${end.cls}])`);
      // the collision warning, spelled out here as well as compared: the page's line is the
      // pure chain's line (which a change to that chain moves too), and that line names
      // the colliding words, each on its own, with the warn class
      check(end.rt === expectedRedact.text && end.rcls === expectedRedact.cls,
        `etsy save ${round}: the redact line is the config's line (it said: ${end.rt} [${end.rcls}])`);
      const named = /\(([^)]*)\) — those read \[redacted\]/.exec(end.rt || "")?.[1].split(", ") || [];
      check(named.includes("etsy") && named.includes("www.etsy.com") && end.rcls === "warn",
        `etsy save ${round}: the redact line warns of the collision with Etsy's own words (named: ${named.join(", ") || "none"})`);
      check(JSON.stringify(end.bar) === "[1,1]" && end.fails.length === 0, `etsy save ${round}: the bar is full and nothing failed (bar ${JSON.stringify(end.bar)}, ${end.fails.length} failures)`);
      if (saved) {
        check(saved.redact === "on" && saved.conversations?.[0]?.messages?.length === 2,
          `etsy save ${round}: the file says redact on and holds the conversation's 2 messages`);
        check(!/betsy/i.test(text) && text.includes("[redacted]"), `etsy save ${round}: the configured name is redacted in the file`);
      }
    }

    // round 3: no config, and an emptied box — the click falls back to the tab's
    // conversation, and the off state is loud on both lines and in the file
    await extEval(`chrome.storage.local.remove("etsyRedact").then(() => true)`);
    {
      const { end, saved, text } = await save(3, "");
      check(end.t === "Saved 1 conversation, 2 messages. Redact: off (no etsyRedact config)." && end.cls === "warn",
        `etsy save 3: an emptied box saves the tab's conversation, and an unredacted save warns (it said: ${end.t} [${end.cls}])`);
      check(end.rt === "Redact: off — no etsyRedact config; the export is unredacted." && end.rcls === "warn",
        `etsy save 3: the redact line says it is off (it said: ${end.rt} [${end.rcls}])`);
      if (saved) check(saved.redact === "off (no etsyRedact config)" && /betsy/i.test(text), `etsy save 3: the file says redact off and is unredacted (${saved.redact})`);
    }

    // round 4: a second id whose first page fails — named on the end line, in the
    // failure list and in the file
    {
      const { end, saved } = await save(4, `${ETSY_ID}, ${ETSY_GONE}`);
      check(end.t === "Saved 2 conversations, 2 messages, 1 with errors (listed in the file). Redact: off (no etsyRedact config)." && end.cls === "warn",
        `etsy save 4: the failed conversation reaches the end line (it said: ${end.t} [${end.cls}])`);
      check(JSON.stringify(end.fails) === JSON.stringify([`${ETSY_GONE}: HTTP 500 at offset 0`]), `etsy save 4: the failure list names it (${JSON.stringify(end.fails)})`);
      if (saved) check(saved.conversations?.[1]?.id === ETSY_GONE && saved.conversations[1].error === "HTTP 500 at offset 0",
        `etsy save 4: the file carries its error (${saved.conversations?.[1]?.error})`);
    }

    // rounds 5 and 6: Chrome refuses the download, by a throw at the call (as its schema
    // check does) and by a rejected promise. The page's own downloads.download is
    // replaced for these rounds; the tab closes with the scenario. Nothing will ever read
    // the blob, so the page must free its URL: the browser's fetch of it then fails.
    // A refusal at the call ends the run with no export, so the redact line is hidden; a
    // rejected promise ends it through the normal finish, which keeps the line.
    const refusals = [
      [5, "() => { throw new Error('smoke: refused at the call'); }", "smoke: refused at the call", ""],
      [6, "() => Promise.reject(new Error('smoke: refused by Chrome'))",
        "The download didn't finish — Chrome interrupted or refused it, and ",
        "Redact: off — no etsyRedact config; the export is unredacted."],
    ];
    for (const [round, stub, said, redactSaid] of refusals) {
      await evalIn(ep, `(() => {
        if (!window.smokeBlobs) {
          window.smokeBlobs = [];
          const make = URL.createObjectURL;
          URL.createObjectURL = (b) => { const u = make.call(URL, b); window.smokeBlobs.push(u); return u; };
        }
        window.smokeBlobs.length = 0;
        chrome.downloads.download = ${stub};
        for (const id of ["etsy-status", "etsy-redact"]) { const p = document.getElementById(id); p.textContent = ""; p.className = ""; }
        document.getElementById("ids").value = ${JSON.stringify(ETSY_ID)};
        document.getElementById("etsy-run").click(); return true; })()`);
      const end = await waitFor(() => evalIn(ep, etsyState).then((s) => s.cls === "warn" && s),
        `etsy save ${round}'s end line`, 20000).catch(soft((e) => ({ t: e.message, fails: [] })));
      check(end.t.startsWith(said), `etsy save ${round}: the refusal reaches the end line (it said: ${end.t})`);
      check(end.rt === redactSaid && (redactSaid === "" || end.rcls === "warn") && end.fails.length === 0,
        `etsy save ${round}: the redact line is ${redactSaid ? "the off line, warned" : "hidden"} and nothing is listed as failed (it said: ${end.rt} [${end.rcls}]; ${end.fails.length} failures)`);
      const blobs = await evalIn(ep, `Promise.all(window.smokeBlobs.map((u) => fetch(u).then(() => "readable", () => "freed")))`);
      check(JSON.stringify(blobs) === '["freed"]', `etsy save ${round}: the page made one blob and freed its URL (${JSON.stringify(blobs)})`);
    }
  },
  // the cleanup: the stored config never reaches a later scenario (scenario() closes the tabs)
  () => extEval(`chrome.storage.local.remove("etsyRedact").then(() => true)`));

  if (blocked.length) console.log(`smoke: blocked ${blocked.length} request(s) the synthetic web doesn't serve:\n  ${[...new Set(blocked)].join("\n  ")}`);
  console.log(failures.length ? `smoke: ${failures.length} FAILED` : "smoke: all passed");
  return failures.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`smoke: FAIL ${e && e.stack || e}`);
  process.exit(1);
});
