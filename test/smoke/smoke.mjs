// The extension smoke: loads this unpacked extension into a headless Chromium, opens the
// real popup (chrome.action.openPopup on the reddit or Discord tab) and presses its
// buttons, then checks what lands on disk. The unit tests stub the chrome.* APIs, so a
// wiring break (an offscreen document reaching for an API it doesn't get, a click
// listener that vanished, a re-save Chrome renames) passes them; this runs the popup,
// worker, offscreen and export-tab code a person's click runs. Not covered: the toolbar
// button itself, user-gesture checks (the presses are script clicks), and the Discord
// collector's panel — the smoke posts the collector's hand-off message to the bridge
// itself, so the Discord flow is covered from the bridge onward.
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
const WEB = new Map([
  [REDDIT_POST, { type: "text/html", body: html("a reddit post") }],
  [REDDIT_JSON, { type: "application/json", body: redditBody }],
  [DISCORD_DM, { type: "text/html", body: html("a discord dm") }],
  [ATTACHMENT, { type: "text/plain", body: ATTACHMENT_BODY }],
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
    let armed = true;
    chrome.downloads.onCreated.addListener((d) => { if (armed) { armed = false; chrome.downloads.cancel(d.id); } });
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
  await waitFor(() => evalIn(dm.sessionId, `document.documentElement.dataset.discordToolsBridge === "1"`), "the bridge on the Discord tab");
  // what the collector posts when its Save is pressed (its panel needs Discord's own app)
  await evalIn(dm.sessionId, `window.postMessage({ type: "discord-tools:export", id: 1, file: "discord-smoke-111.json",
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

  if (blocked.length) console.log(`smoke: blocked ${blocked.length} request(s) the synthetic web doesn't serve:\n  ${[...new Set(blocked)].join("\n  ")}`);
  console.log(failures.length ? `smoke: ${failures.length} FAILED` : "smoke: all passed");
  return failures.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`smoke: FAIL ${e && e.stack || e}`);
  process.exit(1);
});
