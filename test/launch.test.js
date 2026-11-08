// src/background.js on a stubbed chrome. The worker is a module worker, so a plain ESM
// import runs it; the stub records what it registers and what it does. These tests pin
// the launch path's reply contract: the popup shows the worker's error text, so a wrong
// reply is a wrong message on screen.
import { test } from "node:test";
import assert from "node:assert/strict";

import { existsSync } from "node:fs";

const calls = { badges: [], scripts: [], tabsCreated: [], tabsGets: 0 };
// a path the worker hands Chrome must name a real file in the extension
const shipped = (path) => existsSync(new URL(`../${path}`, import.meta.url));
let onMessageListener = null;
let TAB_URL = "https://discord.com/channels/@me/1234567890";

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    onMessage: {
      addListener: (fn) => { onMessageListener = fn; },
    },
    getURL: (p) => `chrome-extension://test-extension-id/${p}`,
  },
  action: {
    setBadgeText: async (o) => calls.badges.push(["text", o]),
    setTitle: async (o) => calls.badges.push(["title", o]),
  },
  tabs: {
    get: async (id) => { calls.tabsGets += 1; return { id, url: TAB_URL }; },
    create: async (o) => { calls.tabsCreated.push(o); return { id: 99 }; },
  },
  scripting: {
    executeScript: async (o) => calls.scripts.push(o),
  },
};

await import("../src/background.js");
const listener = onMessageListener;

// runs the worker's listener; a message it declines resolves undefined
const handled = (msg, sender) =>
  new Promise((resolve) => {
    const keepOpen = listener(msg, sender, resolve);
    if (!keepOpen) resolve(undefined);
  });

const reset = () => {
  calls.badges.length = 0;
  calls.scripts.length = 0;
  calls.tabsCreated.length = 0;
  calls.tabsGets = 0;
  TAB_URL = "https://discord.com/channels/@me/1234567890";
};

test("a launch on a conversation tab injects bridge then collector and answers ok", async () => {
  reset();
  const reply = await handled(
    { type: "leket:launch", command: "save", tabId: 5 },
    { id: "test-extension-id" }, // an extension page: no sender.tab
  );
  assert.deepEqual(reply, { ok: true });
  assert.equal(calls.scripts.length, 2, "bridge and collector both injected");
  assert.deepEqual(calls.scripts[0], { target: { tabId: 5 }, files: ["src/modules/discord/bridge.js"] },
    "the bridge, in the isolated world");
  assert.deepEqual(calls.scripts[1], { target: { tabId: 5 }, files: ["src/modules/discord/collector.js"], world: "MAIN" });
  for (const s of calls.scripts) assert.ok(shipped(s.files[0]), `${s.files[0]} is not in the extension`);
  // the toolbar flag lands whatever the popup did: cleared on success (flag() calls
  // setBadgeText then setTitle, so the pair comes in that order)
  assert.deepEqual(calls.badges.slice(-2), [
    ["text", { tabId: 5, text: "" }],
    ["title", { tabId: 5, title: "Leket: save this conversation" }],
  ]);
});

test("a launch on a tab that navigated away says so, in the reply and on the badge", async () => {
  reset();
  TAB_URL = "https://example.com/somewhere-else";
  const reply = await handled(
    { type: "leket:launch", command: "save", tabId: 6 },
    { id: "test-extension-id" },
  );
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /no longer a Discord conversation/);
  assert.deepEqual(calls.badges[0], ["text", { tabId: 6, text: "?" }]);
});

test("a content script cannot launch: sender.tab disqualifies the sender", async () => {
  reset();
  const reply = await handled(
    { type: "leket:launch", command: "save", tabId: 7 },
    { id: "test-extension-id", tab: { id: 7 } }, // the shape a content-script relay carries
  );
  assert.equal(reply, undefined, "the listener must not handle this message");
  assert.equal(calls.scripts.length, 0, "nothing was injected");
});

test("a command the worker does not have is refused, not run as save", async () => {
  reset();
  const reply = await handled(
    { type: "leket:launch", command: "rename", tabId: 8 },
    { id: "test-extension-id" },
  );
  assert.ok(reply && reply.ok === false, `expected a structured refusal, got ${JSON.stringify(reply)}`);
  assert.match(reply.error, /rename/);
  assert.equal(calls.scripts.length, 0, "the unknown command must not inject anything");
  assert.equal(calls.tabsGets, 0, "the unknown command must not even read the tab");
});

test("the collector's Save handoff still opens the export tab beside it", async () => {
  reset();
  const reply = await handled(
    { type: "leket:ready", key: "k" },
    { tab: { id: 3, index: 2, windowId: 1 } },
  );
  assert.deepEqual(reply, { ok: true });
  assert.equal(calls.tabsCreated.length, 1);
  const { url, index, windowId } = calls.tabsCreated[0];
  // right of the Discord tab, in its window
  assert.deepEqual([index, windowId], [3, 1]);
  const u = new URL(url);
  assert.equal(`${u.protocol}//${u.host}`, "chrome-extension://test-extension-id");
  assert.equal(u.pathname, "/src/modules/discord/export.html");
  assert.ok(shipped(u.pathname.slice(1)), "export.html is in the extension");
  // the export tab finds the save by the Discord tab's id and the handoff key
  assert.deepEqual(Object.fromEntries(u.searchParams), { tab: "3", key: "k" });
});
