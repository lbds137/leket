// src/modules/registry.js: what the popup offers for a tab's URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODULES, match } from "../src/modules/registry.js";
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

test("the worker's CONVERSATION regex and the registry's matches agree", () => {
  // background.js is a classic service worker (the manifest has no "type": "module"),
  // so it cannot import the registry: the two conversation regexes can only drift apart
  // silently, and a drifted pair makes the popup offer a launch the worker refuses.
  // This pin turns that into a red test.
  const worker = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../src/modules/registry.js", import.meta.url), "utf8");
  const pull = (src) => (src.match(/\/\^https:[^\n]*\/(?=;|\.test)/) || [])[0];
  assert.ok(pull(worker), "no /^https:…/ regex literal found in background.js");
  assert.ok(pull(registry), "no /^https:…/ regex literal found in registry.js");
  assert.equal(pull(worker), pull(registry), "the two conversation regexes drifted apart");
});
