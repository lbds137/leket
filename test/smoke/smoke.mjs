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
// is on disk at once; what's covered is the stop and the late-end narration). The chat page is driven only as far as
// its paste parse — its org probe and fetches are not covered. The Etsy page runs for
// real: prefilled from the tab, it pages a synthetic message-list endpoint under a stored
// redact config and saves twice, the second save over the first. Not covered there: an
// emptied ids box falling back to the tab's conversation (this run never empties the prefilled box).
// Every page is synthetic and served from this file; no request leaves the machine:
// each target's requests are intercepted, DNS resolves nothing and no proxy is used.
//
//   npm run smoke            (LEKET_CHROME=/path/to/chrome to pick the browser;
//                             LEKET_SMOKE_KEEP=1 keeps the profile and downloads)
//
// The browser: a Chromium build that still honors --load-extension (branded Google
// Chrome dropped it). Without LEKET_CHROME it takes the newest Playwright Chromium in
// ~/.cache/ms-playwright; none found exits 2 and says so, never a skipped pass.
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

function findChrome() {
  if (process.env.LEKET_CHROME) return process.env.LEKET_CHROME;
  const cache = join(homedir(), ".cache", "ms-playwright");
  const builds = existsSync(cache)
    ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    : [];
  for (const d of builds) {
    const bin = join(cache, d, "chrome-linux64", "chrome");
    if (existsSync(bin)) return bin;
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
// etsy: a conversation page for the popup to match and prefill from, its message-list
// pages, and a redact config whose name (the unit tests' synthetic one) also catches
// "etsy" — so the page's redact line carries the collision warning
const ETSY_ID = "424242";
const ETSY_CONVO = `https://www.etsy.com/messages/${ETSY_ID}`;
const etsyPage = (offset) => `https://www.etsy.com/api/v3/ajax/member/conversations/detail/${ETSY_ID}/message-list?offset=${offset}&fetch_older=true&load_shop_convos=false`;
const ETSY_REDACT = { name: "betsy", short: "bpt", firstSounds: "bpt" };
const WEB = new Map([
  [REDDIT_POST, { type: "text/html", body: html("a reddit post") }],
  [REDDIT_JSON, { type: "application/json", body: redditBody }],
  [DISCORD_DM, { type: "text/html", body: html("a discord dm") }],
  [ATTACHMENT, { type: "text/plain", body: ATTACHMENT_BODY }],
  [CLAUDE_CODE, { type: "text/html", body: html("a claude code page") }],
  [CLAUDE_CHAT, { type: "text/html", body: html("a claude chat") }],
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
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
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
      + "(a Playwright Chromium works: npx playwright install chromium), then run npm run smoke again.");
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
  try {
    const wsUrl = await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`the browser printed no DevTools address in 20s:\n${stderr.slice(-2000)}`)), 20000);
      browser.on("exit", (code) => fail(new Error(`the browser exited (${code}) before it was ready:\n${stderr.slice(-2000)}`)));
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
    const limit = new Promise((_, fail) => { watchdog = setTimeout(() => fail(new Error("the run took over 3 minutes")), 180_000); });
    try { return await Promise.race([scenarios(cdp, downloads), limit]); } finally { clearTimeout(watchdog); }
  } finally {
    stop();
  }
}

async function scenarios(cdp, downloads) {
  // every target, as it appears: intercept its requests before it runs a line
  const sessions = new Map(); // targetId -> { sessionId, type, url }
  cdp.on(async (m) => {
    if (m.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = m.params;
      sessions.set(targetInfo.targetId, { sessionId, type: targetInfo.type, url: targetInfo.url });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId).catch(() => {});
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    } else if (m.method === "Target.targetInfoChanged") {
      const s = sessions.get(m.params.targetInfo.targetId);
      if (s) s.url = m.params.targetInfo.url;
    } else if (m.method === "Target.detachedFromTarget") {
      for (const [id, s] of sessions) if (s.sessionId === m.params.sessionId) sessions.delete(id);
    } else if (m.method === "Fetch.requestPaused") {
      const { requestId, request } = m.params;
      const page = WEB.get(request.url);
      if (page) {
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
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
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId).catch(() => {});
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
    }, `${what}: page.js to wire #${button}`).catch((e) => { if (e && e.fatal) throw e; return false; });
    if (!check(ok, `${what}: the page's script and its imports loaded (#${button} has its click listener)`)) throw new Error(`${what}: page.js never ran`);
  };

  // ---- reddit: popup -> worker -> offscreen document -> worker downloads, twice ----
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
      .then((n) => n >= 2 * round && n), `round ${round}'s two finished downloads`).catch((e) => e.message);
    check(done === 2 * round, `reddit save ${round}: Chrome finished ${2 * round} reddit downloads so far (${done})`);
    await sleep(500); // a duplicate save would have a moment to land
    check(JSON.stringify(landed()) === JSON.stringify(["reddit-abc123.json", "reddit-abc123.md"]),
      `reddit save ${round}: exactly reddit-abc123.json + .md on disk, no renamed copy (found: ${landed().join(", ")})`);
    if (existsSync(join(downloads, "reddit-abc123.json"))) {
      check(readFileSync(join(downloads, "reddit-abc123.json"), "utf8") === redditBody, `reddit save ${round}: the json is the post's json, byte for byte`);
    }
    await evalIn(popup.sessionId, "window.close()").catch(() => {});
    await waitFor(async () => !(await cdp.send("Target.getTargets")).targetInfos.some((t) => t.url.endsWith("/src/popup/popup.html")), "the popup to close");
  }

  // ---- discord: popup -> worker injects -> bridge -> export tab; the zip's first try is
  // cancelled, so the part's link must take a click to save it (the export tab's listener) ----
  console.log("smoke: discord save");
  await extEval(`(() => {
    self.smokeCancelArmed = true;
    chrome.downloads.onCreated.addListener((d) => { if (self.smokeCancelArmed) { self.smokeCancelArmed = false; chrome.downloads.cancel(d.id); } });
    return true; })()`);
  const dm = await open(DISCORD_DM);
  const launcher = await clickPopup("Save this conversation");
  // a launch closes the popup; a refusal keeps it open with a warning that says why
  const launched = await waitFor(async () => {
    if (!(await cdp.send("Target.getTargets")).targetInfos.some((t) => t.targetId === launcher.targetId)) return "closed";
    const warn = await evalIn(launcher.sessionId, `document.querySelector("#card p.warn")?.textContent || ""`).catch(() => "");
    return warn && `warned: ${warn}`;
  }, "the popup to close (launched) or warn", 30000).catch((e) => e.message);
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
  await evalIn(tab.sessionId, `${link}.click(), true`);
  // saved: the link says so, or the summary closed the tab — it closes only once every
  // part's saved() hook ran, which only the page's click listener can bring about here
  // (a bare a[download] click saves a file but never tells the page)
  const after = await waitFor(async () => {
    if (!sessions.get(tab.targetId)) return { saved: true, how: "the export tab closed itself: every part saved" };
    const t = await evalIn(tab.sessionId, `${link}?.textContent || ""`);
    return t.endsWith("— saved") && { saved: true, how: t };
  }, "the clicked part to save", 30000).catch((e) => ({ saved: false, how: e.message }));
  check(after.saved, `discord: a click on the part's link saves it (${after.how})`);
  const zips = landed().filter((f) => f.endsWith(".zip"));
  if (check(zips.length === 1, `discord: one zip on disk (found: ${zips.join(", ") || "none"})`)) {
    const names = JSON.parse(execFileSync("python3", ["-I", "-c",
      "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", join(downloads, zips[0])], { encoding: "utf8" }));
    check(names.includes("discord-smoke-111.json"), "discord: the zip holds the messages json");
    check(names.some((n) => n.endsWith("note.txt")), `discord: the zip holds the attachment (names: ${names.join(", ")})`);
  }
  // disarmed whatever happened above: a discord block that failed before its first
  // download must not leave the cancel waiting for a later scenario's
  await extEval("self.smokeCancelArmed = false, true");

  // ---- claude sessions: popup -> the module's page -> a real export whose one part gets
  // no word from Chrome, stops the run, then lands late and rebuilds the resume line.
  // After this block: the files below would break the reddit block's exact-files check ----
  console.log("smoke: claude sessions export");
  await open(CLAUDE_CODE);
  await clickPopup("Export sessions");
  const sp = (await target((s) => s.type === "page" && s.url.includes("/src/modules/claude-sessions/page.html#export"), "the sessions page")).sessionId;
  await wired(sp, "export-run", "sessions");
  // two test-side levers, set after load (page.js looks both up at call time): the
  // 15-minute no-word wait (NO_WORD_MS) becomes 0 ms, and the download call's answer is
  // held until released — Chrome saves the file at once, but the page hears of it only
  // after release, so it is silent first and its late end narrated after, every run
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
  const silent = await waitFor(() => evalIn(sp, status).then((s) => s.t.includes("got no word from Chrome") && s), "the part to go silent and stop the run", 30000)
    .catch((e) => ({ t: e.message }));
  check(/^Part claude-sessions-\S+-part03\.jsonl got no word from Chrome/.test(silent.t), `sessions: the silent part stops the run (it said: ${silent.t})`);
  check(await evalIn(sp, resume) === `window.CLAUDE_EXPORT_SKIP = ["${EARLIER_SESSION}"]; window.CLAUDE_EXPORT_PART_START = 2;`,
    `sessions: the stop's resume line names only what the earlier run saved (${await evalIn(sp, resume)})`);
  await evalIn(sp, "window.smokeRelease(), true");
  const late = await waitFor(() => evalIn(sp, status).then((s) => s.t.endsWith("landed — the resume line below is updated.") && s), "the silent part to land late", 30000)
    .catch((e) => ({ t: e.message, cls: "" }));
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

  // ---- claude chat: popup -> the module's page, which parses a pasted whole file ----
  console.log("smoke: claude chat outputs");
  await open(CLAUDE_CHAT);
  await clickPopup("Save chat outputs");
  const cp = (await target((s) => s.type === "page" && /\/src\/modules\/claude-chat\/page\.html\?tab=\d+$/.test(s.url), "the chat outputs page (with its tab id)")).sessionId;
  await wired(cp, "outputs-run", "chat");
  // an empty list in the generator's whole-file form: past the strip it parses and is
  // refused as empty; without page.js or its imports the click says nothing at all
  await evalIn(cp, `document.getElementById("chats").value = ${JSON.stringify(
    `window.CLAUDE_OUTPUT_CHATS = [];\n(() => { console.log("the console script"); })();\n`)};
    document.getElementById("outputs-run").click(), true`);
  const said = await waitFor(() => evalIn(cp, `(() => { const p = document.getElementById("outputs-status"); return !p.hidden && p.textContent; })()`),
    "the chat page's status line", 15000).catch((e) => e.message);
  check(said.startsWith("The chat list is empty."), `chat: the page parses the pasted file and refuses the empty list (it said: ${said})`);

  // ---- etsy: popup -> the module's page, prefilled from the tab, which pages the synthetic
  // message-list endpoint under a stored redact config whose name collides with Etsy's own
  // words, and saves the file twice: the second save overwrites the first ----
  console.log("smoke: etsy save");
  await extEval(`chrome.storage.local.set({ etsyRedact: ${JSON.stringify(ETSY_REDACT)} }).then(() => true)`);
  const etsyTab = await open(ETSY_CONVO);
  await clickPopup("Save conversations");
  const etsyPageTarget = await target((s) => s.type === "page" && /\/src\/modules\/etsy\/page\.html\?tab=\d+$/.test(s.url), "the Etsy page (with its tab id)");
  const ep = etsyPageTarget.sessionId;
  const etsyFirst = {}; // round 1's file name and extracted_at
  await wired(ep, "etsy-run", "etsy");
  const prefilled = await waitFor(() => evalIn(ep, `document.getElementById("ids").value`), "the ids box to prefill from the tab")
    .catch((e) => e.message);
  check(prefilled === ETSY_ID, `etsy: the ids box prefills from the tab's address (${prefilled})`);
  const etsyState = `(() => { const s = document.getElementById("etsy-status"), r = document.getElementById("etsy-redact"), b = document.getElementById("etsy-bar");
    return { t: s.hidden ? "" : s.textContent, cls: s.className, rt: r.hidden ? "" : r.textContent, rcls: r.className,
      bar: b.hidden ? null : [b.value, b.max], fails: document.getElementById("etsy-fails").children.length }; })()`;
  const expectedRedact = redactSetup(ETSY_REDACT).line;
  for (const round of [1, 2]) {
    // the lines are blanked with the click: round 1's "Saved" stays up until the run's
    // first progress line, and round 2 must read its own end, not that one
    await evalIn(ep, `(() => { for (const id of ["etsy-status", "etsy-redact"]) { const p = document.getElementById(id); p.textContent = ""; p.className = ""; }
      document.getElementById("etsy-run").click(); return true; })()`);
    const end = await waitFor(() => evalIn(ep, etsyState).then((s) => (s.t.startsWith("Saved") || s.t.startsWith("The download") || s.cls === "warn") && s),
      `etsy save ${round}'s end line`, 30000).catch((e) => ({ t: e.message }));
    check(end.t === "Saved 1 conversation, 2 messages. Redact: on." && end.cls === "ok",
      `etsy save ${round}: the page reports a clean save (it said: ${end.t} [${end.cls}])`);
    // the collision warning, spelled out here as well as compared: the page's line is the
    // pure chain's line, and that line names the colliding words with the warn class
    check(end.rt === expectedRedact.text && end.rcls === expectedRedact.cls,
      `etsy save ${round}: the redact line is the config's line (it said: ${end.rt} [${end.rcls}])`);
    check(end.rt?.includes("(etsy, www.etsy.com, ") && end.rcls === "warn",
      `etsy save ${round}: the redact line warns of the collision with Etsy's own words`);
    check(JSON.stringify(end.bar) === "[1,1]" && end.fails === 0, `etsy save ${round}: the bar is full and nothing failed (bar ${JSON.stringify(end.bar)}, ${end.fails} failures)`);
    const done = await waitFor(() => extEval(`chrome.downloads.search({ filenameRegex: "etsy-conversations-", state: "complete" }).then((d) => d.length)`)
      .then((n) => n >= round && n), `etsy round ${round}'s finished download`).catch((e) => e.message);
    check(done === round, `etsy save ${round}: Chrome finished ${round} Etsy download(s) so far (${done})`);
    await sleep(500); // a renamed copy would have a moment to land
    // the file is named by the UTC date: round 1's name, plus today's when midnight UTC
    // fell between the rounds (then round 2's file is the new one, beside round 1's)
    const files = landed().filter((f) => f.startsWith("etsy-"));
    // (read from disk, not recomputed here, so a midnight between the page's naming and
    // this check can't redden it): sorted, a later date sorts after round 1's
    const dated = (f) => /^etsy-conversations-\d{4}-\d{2}-\d{2}\.json$/.test(f || "");
    const name = files[files.length - 1];
    const shapeOk = round === 1 ? files.length === 1
      : files[0] === etsyFirst.name && (files.length === 1 || (files.length === 2 && name > etsyFirst.name));
    if (check(shapeOk && files.every(dated),
      `etsy save ${round}: one dated file on disk, no renamed copy (found: ${files.join(", ") || "none"})`)) {
      const text = readFileSync(join(downloads, name), "utf8");
      const saved = JSON.parse(text);
      check(saved.redact === "on" && saved.conversations?.[0]?.messages?.length === 2,
        `etsy save ${round}: the file says redact on and holds the conversation's 2 messages`);
      check(!/betsy/i.test(text) && text.includes("[redacted]"), `etsy save ${round}: the configured name is redacted in the file`);
      // round 2's file is round 2's: the overwrite replaced round 1's content
      if (round === 1) Object.assign(etsyFirst, { name, at: saved.extracted_at });
      else check(typeof saved.extracted_at === "string" && saved.extracted_at !== etsyFirst.at,
        `etsy save 2: the file is the second save's (extracted_at ${etsyFirst.at} -> ${saved.extracted_at})`);
    }
  }
  // nothing of this scenario reaches a later one: the stored config, its tabs
  await extEval(`chrome.storage.local.remove("etsyRedact").then(() => true)`);
  for (const t of [etsyTab, etsyPageTarget]) await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});

  if (blocked.length) console.log(`smoke: blocked ${blocked.length} request(s) the synthetic web doesn't serve:\n  ${[...new Set(blocked)].join("\n  ")}`);
  console.log(failures.length ? `smoke: ${failures.length} FAILED` : "smoke: all passed");
  return failures.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`smoke: FAIL ${e && e.stack || e}`);
  process.exit(1);
});
