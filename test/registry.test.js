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
