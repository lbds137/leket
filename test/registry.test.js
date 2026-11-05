// src/modules/registry.js: what the popup offers for a tab's URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODULES, match, POST_PATHNAME } from "../src/modules/registry.js";
import { COMMANDS } from "../src/popup/commands.js";

test("a DM, a server channel and a thread each match the Discord module", () => {
  for (const url of [
    "https://discord.com/channels/@me/1234567890",
    "https://discord.com/channels/9876543210987654321/1234567890",
    // a thread adds a third id after its parent channel
    "https://discord.com/channels/9876543210987654321/1234567890/2468135790",
  ]) {
    const m = match(url);
    assert.ok(m, `no match for ${url}`);
    assert.equal(m.id, "discord");
  }
});

test("a reddit post page on www or old matches the reddit module", () => {
  for (const url of [
    "https://www.reddit.com/r/AskReddit/comments/abc123/whats_the_best_thing/",
    "https://old.reddit.com/r/AskReddit/comments/abc123/",
    "https://www.reddit.com/comments/abc123/",
    // profile posts, a profile comment permalink (its first id is the post's), and
    // reddit's own /u/ alias for /user/
    "https://www.reddit.com/user/someone/comments/abc123/my_post/",
    "https://old.reddit.com/user/someone/comments/abc123/_def456/",
    "https://www.reddit.com/u/someone/comments/abc123/my_post/",
    // a subreddit literally named "comments": the extraction must skip past it
    "https://www.reddit.com/r/comments/comments/abc123/t/",
  ]) {
    const m = match(url);
    assert.ok(m, `no match for ${url}`);
    assert.equal(m.id, "reddit");
  }
});

test("every reddit url the registry matches yields the same post id for the fetch", () => {
  // gate and extraction are built from one POST_PATHNAME; pin that they agree on the
  // id itself, not merely that both match — a future literal gate would drift silently
  for (const url of [
    "https://www.reddit.com/r/AskReddit/comments/abc123/whats_the_best_thing/",
    "https://old.reddit.com/r/AskReddit/comments/abc123/",
    "https://www.reddit.com/comments/abc123/",
    "https://www.reddit.com/user/someone/comments/abc123/my_post/",
    "https://old.reddit.com/user/someone/comments/abc123/_def456/",
    "https://www.reddit.com/u/someone/comments/abc123/my_post/",
    "https://www.reddit.com/r/comments/comments/abc123/t/",
  ]) {
    const m = match(url);
    assert.ok(m && m.id === "reddit", `no reddit match for ${url}`);
    const extracted = new URL(url).pathname.match(POST_PATHNAME);
    assert.equal(extracted && extracted[1], "abc123", `${url}: gate and extraction disagree on the post id`);
  }
});

test("reddit pages that are not posts, or hosts the manifest doesn't cover, do not match", () => {
  for (const url of [
    "https://www.reddit.com/r/AskReddit/", // the subreddit, not a post
    "https://www.reddit.com/r/AskReddit/comments/", // /comments/ with no post id
    "https://www.reddit.com/user/someone/comments/", // same, on a profile
    "https://www.reddit.com/gallery/abc123", // a gallery is not a post page
    "https://np.reddit.com/r/x/comments/abc123/", // a mirror host the manifest doesn't list
    "https://reddit.com/r/x/comments/abc123/", // the bare host; www and old are what's covered
    "https://www.reddit.com/r/x/s/abc123/", // a share short link: redirects to a canonical post page
  ]) {
    assert.equal(match(url), null, `unexpected match for ${url}`);
  }
});

test("a claude.ai/code page matches the claude-sessions module", () => {
  for (const url of [
    "https://claude.ai/code", // the page itself
    "https://claude.ai/code/", // trailing slash
    "https://claude.ai/code?foo=bar", // query
    "https://claude.ai/code#settings", // fragment
  ]) {
    const m = match(url);
    assert.ok(m, `no match for ${url}`);
    assert.equal(m.id, "claude-sessions");
  }
});

test("a claude.ai chat page matches the claude-chat module", () => {
  for (const url of [
    "https://claude.ai/chat", // the chat app itself
    "https://claude.ai/chat/1234e567-89ab-4cde-8f01-234556789abc", // a chat page
    "https://claude.ai/chat?x=1", // query
    "https://claude.ai/chat#f", // fragment
  ]) {
    const m = match(url);
    assert.ok(m, `no match for ${url}`);
    assert.equal(m.id, "claude-chat");
  }
});

test("claude.ai pages that are not /chat do not match the claude-chat module, and /chatX is not /chat", () => {
  // /code stays the claude-sessions module's — it must match, just never this one
  const code = match("https://claude.ai/code");
  assert.ok(code && code.id === "claude-sessions", "/code belongs to claude-sessions");
  for (const url of [
    "https://claude.ai/", // the bare host
    "https://claude.ai/chatX", // /chat must end at the pathname: /chatX is something else
    "https://example.com/chat", // another host entirely
  ]) {
    assert.equal(match(url), null, `unexpected match for ${url}`);
  }
});

test("claude.ai pages that are not /code do not match, and /codeX is not /code", () => {
  for (const url of [
    "https://claude.ai/", // the bare host
    "https://claude.ai/codeX", // /code must end at the pathname: /codeX is something else
    "https://claude.ai/settings/code", // /code not at the start of the pathname
    "https://example.com/code", // another host entirely
  ]) {
    assert.equal(match(url), null, `unexpected match for ${url}`);
  }
});

test("anything else is no match at all", () => {
  for (const url of [
    "https://discord.com/",
    "https://discord.com/channels/@me",
    "https://discord.com/channels/not-a-snowflake/1234567890",
    "https://example.com/channels/@me/1234567890",
    "https://discord.com/channels/@me/not-a-number",
    "",
  ]) {
    assert.equal(match(url), null, `unexpected match for ${url}`);
  }
});

test("every module is renderable: an id, a title, a blurb, at least one command", () => {
  assert.ok(MODULES.length, "the registry is empty");
  for (const m of MODULES) {
    assert.equal(typeof m.id, "string", "id");
    assert.ok(m.id, `${m.id}: empty id`);
    assert.ok(m.title, `${m.id}: empty title`);
    assert.ok(m.blurb, `${m.id}: empty blurb`);
    assert.ok(Array.isArray(m.commands) && m.commands.length, `${m.id}: no commands`);
    for (const c of m.commands) {
      assert.ok(c.id && c.label, `${m.id}/${c && c.id}: command needs an id and a label`);
    }
  }
});

test("every registry command has an implementation in the popup", () => {
  for (const m of MODULES) {
    assert.ok(COMMANDS[m.id], `${m.id}: the popup has no implementations for it at all`);
    for (const c of m.commands) {
      assert.equal(typeof COMMANDS[m.id][c.id], "function", `${m.id}/${c.id}: no implementation`);
    }
  }
});

test("both claude-sessions commands open the module's own page and say so", async () => {
  // the page is self-sufficient (its own fetches carry the login), so the command is a
  // plain tab open — pinned here against an injected tabs stand-in, no real chrome.
  // Each command lands on its own section via the page's hash (the page scrolls to it
  // and flashes it), so the rename open carries #rename and the delete open #delete.
  const created = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test-extension-id/${p}` },
  };
  const tabs = { create: async (o) => { created.push(o); return { id: 9 }; } };
  try {
    const m = match("https://claude.ai/code");
    assert.ok(m && m.id === "claude-sessions");
    for (const c of m.commands) {
      const said = await COMMANDS["claude-sessions"][c.id](undefined, { tabs });
      assert.match(said, /Opened the sessions page/);
    }
    assert.deepEqual(created, [
      { url: "chrome-extension://test-extension-id/src/modules/claude-sessions/page.html#rename" },
      { url: "chrome-extension://test-extension-id/src/modules/claude-sessions/page.html#delete" },
    ]);
  } finally {
    delete globalThis.chrome; // the stub never leaks past this test
  }
});

test("the chat outputs command opens the module's own page with the claude.ai tab id, and says so", async () => {
  // like the sessions commands, the command is a plain tab open — but the page runs
  // against the claude.ai tab the popup matched, so the open carries its id as a
  // query (the page's probe reads that tab's resource timeline).
  const created = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test-extension-id/${p}` },
  };
  const tabs = { create: async (o) => { created.push(o); return { id: 9 }; } };
  try {
    const m = match("https://claude.ai/chat");
    assert.ok(m && m.id === "claude-chat");
    const said = await COMMANDS["claude-chat"].outputs({ id: 7 }, { tabs });
    assert.equal(said, "Opened the chat outputs page.");
    assert.deepEqual(created, [
      { url: "chrome-extension://test-extension-id/src/modules/claude-chat/page.html?tab=7" },
    ]);
  } finally {
    delete globalThis.chrome; // the stub never leaks past this test
  }
});

test("the chat outputs command without a tab opens the bare page and says so", async () => {
  // a tabless open (the tests — the popup always passes its matched tab)
  // still opens the page — it explains itself there — with no ?tab= query at all.
  const created = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test-extension-id/${p}` },
  };
  const tabs = { create: async (o) => { created.push(o); return { id: 9 }; } };
  try {
    const said = await COMMANDS["claude-chat"].outputs(undefined, { tabs });
    assert.equal(said, "Opened the chat outputs page.");
    assert.deepEqual(created, [
      { url: "chrome-extension://test-extension-id/src/modules/claude-chat/page.html" },
    ]);
  } finally {
    delete globalThis.chrome; // the stub never leaks past this test
  }
});
