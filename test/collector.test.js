// src/modules/discord/collector.js on a fake Discord page (test/fixtures/fake_page.cjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUN = fileURLToPath(new URL("./fixtures/fake_page.cjs", import.meta.url));
// One page per (scenario, args, env): the same key always prints the same JSON, so each
// run is memoised and concurrent callers await one in-flight spawn; each caller gets its
// own structuredClone of the parsed page, so no test's in-place edit can reach another
// test's input. WARM lists every key the file asks for and is warmed through a small pool
// at startup; the last test guards that list both ways — a call site without its WARM
// entry, and a WARM entry no test asks for.
const keyOf = (scenario, args = [], env = {}) => JSON.stringify([scenario, args, env]);
const pages = new Map();
// every call records its origin, warmed or not — the pool's load-time warm-ups own the
// memo, so a first-request-only record would never name the tests' keys
const askedByTests = new Set();
const askedByWarm = new Set();
const runPage = async (scenario, args = [], env = {}, origin = "test") => {
  const key = keyOf(scenario, args, env);
  (origin === "warm" ? askedByWarm : askedByTests).add(key);
  if (!pages.has(key)) {
    const run = new Promise((resolve, reject) => {
      execFile("node", [RUN, scenario, ...args], { env: { ...process.env, ...env }, encoding: "utf8" },
        (e, stdout) => {
          if (e) return reject(e);
          let parsed;
          try { parsed = JSON.parse(stdout); }
          catch (err) { return reject(new Error(`fake_page ${scenario} printed unparseable output (${err.message}); first 200 chars: ${JSON.stringify(stdout.slice(0, 200))}`)); }
          resolve(parsed);
        });
    });
    run.catch(() => {}); // a warm-up nobody has awaited yet must not read as an unhandled rejection
    pages.set(key, run);
  }
  const page = await pages.get(key);
  return structuredClone(page);
};
const exportOf = async (scenario, ...args) => {
  const d = (await runPage(scenario, args)).export;
  return [d, new Map(d.participants.map((p) => [`${p.id}|${p.username}`, p]))];
};
const names = (roles) => roles.map((r) => r.name);

// Every distinct page the file asks for, derived from the call sites (the memo collapses
// repeats). The pool is narrow on purpose: ~30 node processes at once is a herd on 4 cores.
const WARM = [
  ["guild"],
  ["guild", ["Discord | #general | Test Server"]],
  ["guild", ["• Discord | #general | Test Server"]],
  ["guild", ["(3) Discord | #general | Test Server"]],
  ["guild-guildstore-roles"],
  ["guild-no-stores"],
  ["guild-no-cache"],
  ["guild-registry"],
  ["guild-unnamed"],
  ["guild-two-runtimes"],
  ["guild-empty-cache"],
  ["guild-no-getmember"],
  ["guild-throwing-getmember"],
  ["guild-hidden"],
  ["guild-hidden-returns"],
  ["guild-hidden-inside"],
  ["guild-hidden-throws"],
  ["dm"],
  ["dm", [], { BRIDGE: "1" }],
  ["dm", [], { BRIDGE: "1", BRIDGE_ACK: "0" }],
  ["dm", [], { START_AT: "2021-01-04" }],
  ["dm", [], { START_AT: "2021-01-10" }],
  ["dm", [], { START_AT: "2021-01-08" }],
  ["dm-forward"],
  ["auto"],
  ["auto", [], { AUTO_QUOTE: "1" }],
  ["auto", [], { AUTO_QUOTE: "short" }],
  ["auto", [], { AUTO_QUOTE: "nested" }],
  ["auto", [], { AUTO_STOP_REST: "1" }],
  ["auto", [], { AUTO_RESTART: "10" }],
  ["auto", [], { AUTO_STOP_WAIT: "3" }],
  ["auto", [], { AUTO_STOP_WAIT: "20" }],
  ["auto", [], { AUTO_RESTART: "rest" }],
];
const POOL = 8;
const warmQueue = [...WARM];
for (let i = 0; i < POOL && warmQueue.length; i++) {
  (async () => {
    while (warmQueue.length) {
      const [s, a, e] = warmQueue.shift();
      await runPage(s, a, e, "warm").catch(() => {}); // a failed warm-up surfaces in the test that asks for it
    }
  })();
}

test("a server member has nick and roles, highest first", async () => {
  const [d, people] = await exportOf("guild");
  assert.equal(d.member_data, "GuildMemberStore + GuildRoleStore + GuildStore");
  assert.equal(d.guild_name, "Test Server");
  const mod = people.get("2|mod_u");
  assert.equal(mod.nick, "Mod Nick");
  assert.equal(mod.global_name, "Global Mod");
  assert.deepEqual(names(mod.roles), ["Admins", "Moderators", "Late Role", null]);
  assert.deepEqual(mod.roles.map((r) => r.color), ["#ff0000", "#00ff00", "#0000ff", null]);
  assert.equal(mod.member_found, true);
  assert.equal(mod.messages, 2);
  assert.equal(mod.shown_as, "Mod Nick");
  assert.deepEqual(d.messages.filter((m) => m.author_id === "2").map((m) => m.nick), ["Mod Nick", "Mod Nick"]);
  assert.equal(new Set(d.messages.map((m) => m.id)).size, 7);
});

test("a bot message keeps its embeds' text", async () => {
  const [d] = await exportOf("guild");
  const m = d.messages.find((x) => x.embeds.length);
  assert.equal(m.text, "");
  assert.deepEqual(m.embeds, [
    { type: "rich", title: "Member banned", description: "<@5> spam", author: "YAGPDB",
      fields: [{ name: "Moderator", value: "mod_u" }], footer: "ID: 5", timestamp: "2021-03-22T02:39:25.750Z" },
    { title: "Plain", image: "https://x/t.png" },
  ]);
  assert.ok(d.messages.filter((x) => x.text).every((x) => x.embeds.length === 0));
});

test("a member who left, and one the store dropped before the save", async () => {
  const [d, people] = await exportOf("guild");
  const alice = people.get("1|alice_u");
  assert.deepEqual([alice.nick, names(alice.roles), alice.member_found], ["Alice Nick", ["Moderators"], true]);
  const left = people.get("3|left_u");
  assert.deepEqual([left.nick, left.roles, left.member_found], [null, null, false]);
  assert.deepEqual(d.messages.filter((m) => m.author_id === "1").map((m) => m.nick), ["Alice Nick"]);
});

test("members and roles loaded after their messages are resolved at the save", async () => {
  const [d, people] = await exportOf("guild");
  const late = people.get("4|late_u");
  assert.deepEqual([late.nick, names(late.roles)], ["Late Nick", ["Moderators"]]);
  assert.deepEqual(d.messages.filter((m) => m.author_id === "4").map((m) => m.nick), ["Late Nick"]);
});

test("each name a webhook posts under is its own participant", async () => {
  const [d] = await exportOf("guild");
  const hooks = d.participants.filter((p) => p.webhook);
  assert.deepEqual(hooks.map((p) => p.username).sort(), ["Proxy One", "Proxy Two"]);
  assert.ok(hooks.every((p) => p.member_found === null && p.roles === null));
});

test("roles from the guild when there is no role store", async () => {
  const [d, people] = await exportOf("guild-guildstore-roles");
  assert.equal(d.member_data, "GuildMemberStore + GuildStore");
  assert.deepEqual(names(people.get("2|mod_u").roles), ["Admins", "Moderators", "Late Role", null]);
});

test("without stores, member fields are null and the nick comes from the page", async () => {
  const [d, people] = await exportOf("guild-no-stores");
  assert.equal(d.member_data, "none found");
  assert.match(d.method, /none found/);
  const mod = people.get("2|mod_u");
  assert.deepEqual([mod.nick, mod.nick_source, mod.color_role, mod.roles, mod.member_found], ["Mod Nick", "page", "Admins", null, null]);
  // the header's nick is her global name: not a server nickname
  const alice = people.get("1|alice_u");
  assert.deepEqual([alice.nick, alice.nick_source], [null, "page"]);
  // the header nearest Star's name carries another person's author: passed over
  const late = people.get("4|late_u");
  assert.deepEqual([late.nick, late.nick_source, late.color_role], [null, null, null]);
  assert.equal(d.messages.length, 7);
});

test("stores are found without a module cache, through Flux's registry, or by their methods", async () => {
  for (const [scenario, route] of [["guild-no-cache", "module_factories"], ["guild-registry", "flux_registry"]]) {
    const [d, people] = await exportOf(scenario);
    assert.equal(d.member_data, "GuildMemberStore + GuildRoleStore + GuildStore", scenario);
    assert.equal(people.get("2|mod_u").nick, "Mod Nick");
    assert.ok(d.member_data_debug[route], scenario);
  }
  const [d] = await exportOf("guild-unnamed");
  assert.equal(d.member_data, "GuildMemberStore (by its methods) + GuildRoleStore (by its methods) + GuildStore (by its methods)");
});

test("every runtime is searched; a cache without stores requires only the modules naming them", async () => {
  const [two] = await exportOf("guild-two-runtimes");
  assert.deepEqual(two.member_data_debug.runtimes.map((r) => r.module_cache), [7, 1]);
  const [d] = await exportOf("guild-empty-cache");
  assert.deepEqual(d.member_data_debug.source_hits, { GuildMemberStore: 1, GuildStore: 1, GuildRoleStore: 1 });
  assert.equal(d.member_data_debug.modules_required, 3);
});

test("a member store that can't be asked says null, not false", async () => {
  for (const scenario of ["guild-no-getmember", "guild-throwing-getmember"]) {
    const [d] = await exportOf(scenario);
    for (const p of d.participants) {
      assert.deepEqual([p.member_found, p.roles], [null, null], scenario);
      assert.notEqual(p.nick_source, "store");
    }
  }
});

test("a DM has no member data", async () => {
  const [d] = await exportOf("dm");
  assert.equal(d.member_data, null);
  assert.equal(d.member_data_debug, null);
  assert.match(d.method, /A DM has no server nicknames or roles/);
  assert.ok(d.participants.every((p) => p.nick === null && p.roles === null && p.member_found === null));
});

test("blocked and ignored bars are opened and their messages kept", async () => {
  const page = await runPage("guild-hidden");
  const d = page.export;
  // "message" is the top bar's row: its text is a piece of its bar's label on purpose
  // (the pin comment in the fixture's guild-hidden block explains why)
  assert.deepEqual(d.messages.filter((m) => m.author_id === "7").map((m) => m.text), ["message", "blocked 1", "blocked 2", "ignored 1"]);
  assert.equal(d.messages.length, 11);
  assert.deepEqual([d.hidden_groups.opened, d.hidden_groups.not_opened], [3, 1]);
  assert.match(page.status, /1 WOULD NOT OPEN: their messages are missing \(scroll back to: blocked bar after 2021-01-06 00:00 UTC "six"\)/);
  assert.equal(d.hidden_groups.unrecognized_buttons, 1);
});

test("a bar scrolled out and back is clicked again; a bar that is a list item with its rows inside", async () => {
  assert.ok((await runPage("guild-hidden-returns")).export.messages.some((m) => m.text === "came back"));
  const d = (await runPage("guild-hidden-inside")).export;
  // the top bar's row is a piece of its label ("message" in "1 blocked message") — the
  // fixture's pin comment has the why: a first-occurrence cut would flip the opened bar
  // to not-opened + unrecognized, which both assertions below catch. The growing bar's
  // INSIDE rows pin the later-first half the same way ("message" sits inside "blocked
  // message"): without the reverse, its cut lands inside the later row and the bar
  // flips the same way
  assert.deepEqual([d.hidden_groups.opened, d.hidden_groups.not_opened], [3, 1]);
  assert.equal(d.hidden_groups.unrecognized_buttons, 1);
});

test("an error opening bars is reported and the harvest goes on", async () => {
  const page = await runPage("guild-hidden-throws");
  assert.equal(page.export.hidden_groups.error, "detached");
  assert.match(page.status, /ERROR opening blocked\/ignored messages: detached/);
  assert.equal(page.export.messages.length, 11);
});

test("the file name is the same with or without unread marks", async () => {
  const files = new Set();
  for (const t of ["Discord | #general | Test Server", "• Discord | #general | Test Server", "(3) Discord | #general | Test Server"]) {
    files.add((await runPage("guild", [t])).file);
  }
  assert.deepEqual([...files], ["discord-_general_Test_Server-600.json"]);
});

test("a forward keeps what was forwarded; a reply is not a forward", async () => {
  const d = (await runPage("dm-forward")).export;
  const [reply, fwd, api, bare, late, untyped] = d.messages.slice(7);
  assert.equal(reply.reply_to, d.messages[0].id);
  assert.equal(reply.forward_of, undefined);
  assert.equal(fwd.reply_to, null);
  assert.deepEqual(fwd.forward_of, { message_id: "77", channel_id: "88", guild_id: "99" });
  assert.deepEqual(fwd.forwarded, [{ text: "forwarded words", datetime: "2020-12-01T00:00:00.000Z",
    attachments: [{ filename: "f1.png", url: "https://cdn.discordapp.com/attachments/1/1/f1.png", size: 2000000 },
      { filename: "g.png", url: "https://cdn.discordapp.com/attachments/1/1/g.png" }], embeds: [{ title: "Card" }] }]);
  assert.deepEqual(api.forwarded.map((f) => [f.text, f.datetime]), [["api form", "2020-12-02T00:00:00.000Z"]]);
  assert.deepEqual(bare.forwarded, []);
  // snapshots that arrive after the first read are picked up; the author isn't counted twice
  assert.deepEqual(late.forwarded.map((f) => f.text), ["late words"]);
  assert.equal(d.participants.find((p) => p.id === "2").messages, 6);
  // snapshots make a forward even where the reference gives no type
  assert.deepEqual([untyped.reply_to, untyped.forward_of.message_id, untyped.forwarded[0].text], [null, "81", "no type"]);
  assert.equal(d.forwards_without_snapshot, 1);
});

test("with the bridge's mark but no answer, Save downloads the JSON and says why", async () => {
  const page = await runPage("dm", [], { BRIDGE: "1", BRIDGE_ACK: "0" });
  assert.equal(page.downloaded, true);
  assert.equal(page.posted.type, "leket:export");
  assert.equal(page.export.messages.length, 7);
  assert.match(page.status, /^The extension didn't answer .* messages saved to Downloads\/discord-someone-600\.json/);
});

test("with the bridge's mark, Save posts the export instead of downloading it", async () => {
  const page = await runPage("dm", [], { BRIDGE: "1" });
  assert.equal(page.downloaded, false);
  assert.equal(page.posted.type, "leket:export");
  assert.equal(page.posted.origin, "https://discord.com");
  assert.equal(page.posted.attachments, true);
  assert.equal(page.file, "discord-someone-600.json");
  assert.equal(page.export.messages.length, 7);
  assert.match(page.status, /^Handed to the export tab/);
  const alone = await runPage("dm");
  assert.equal(alone.downloaded, true);
  assert.match(alone.status, /^Saved to Downloads\/discord-someone-600\.json/);
});

test("attachment sizes are kept, the newest edge is in the export, and the panel estimates the total", async () => {
  const page = await runPage("dm-forward");
  const d = page.export;
  const fwd = d.messages.find((m) => m.forward_of && m.forwarded.length);
  assert.equal(fwd.forwarded[0].attachments[0].size, 2000000);
  assert.ok(!("size" in fwd.forwarded[0].attachments[1]), "an attachment without a size stays without one");
  assert.match(page.panel, /≈ at least 2 MB in 2 attachment files/);
  assert.equal(d.start_at, null);
  assert.equal(d.messages_after_start, 0);
  assert.equal(d.reached_until, d.messages[d.messages.length - 1].datetime);
});

test("start at records a chunk's newest edge and calls the overlap harmless", async () => {
  const page = await runPage("dm", [], { START_AT: "2021-01-04" });
  const d = page.export;
  assert.deepEqual([d.start_at, d.messages_after_start], ["2021-01-04", 4]);
  assert.match(page.status, /newest 2021-01-07 00:00 UTC/);
  assert.match(page.status, /; 4 message\(s\) are dated on or after start-at 2021-01-04 \(UTC days, as "stop at" is\): that overlaps the chunk before, nothing is lost/);
});

test("start at warns when the newest message is more than a day before start-at, not when it is one day before", async () => {
  const gap = await runPage("dm", [], { START_AT: "2021-01-10" });
  assert.deepEqual([gap.export.start_at, gap.export.messages_after_start], ["2021-01-10", 0]);
  assert.match(gap.status, /; the newest message is dated 2021-01-07, more than a day before start-at 2021-01-10: if the conversation had messages between those days they are NOT in this save \(jump to the newest search result and save again\)/);
  const oneDay = await runPage("dm", [], { START_AT: "2021-01-08" });
  assert.deepEqual([oneDay.export.start_at, oneDay.export.messages_after_start], ["2021-01-08", 0]);
  assert.ok(!oneDay.status.includes("NOT in this save"));
});

test("a message quoting the start header's wording doesn't end the climb as the start", async () => {
  const { loads, status } = await runPage("auto", [], { AUTO_QUOTE: "1" });
  assert.equal(loads, 25);
  assert.doesNotMatch(status, /reached the start/);
  assert.match(status, /STALLED, not at the start/);
  // a row that is a piece of the header ("Welcome") is cut from the row, not the header
  const short = await runPage("auto", [], { AUTO_QUOTE: "short" });
  assert.match(short.status, /reached the start of the channel/);
  // a later row opening with an earlier row's piece ("Welcome to" after "Welcome"): rows
  // cut later-first, so the "Welcome" cut takes the later row's copy and the "Welcome to"
  // cut still finds its row — first-to-last would leave the cut the header's copy instead
  const nested = await runPage("auto", [], { AUTO_QUOTE: "nested" });
  assert.match(nested.status, /reached the start of the channel/);
  assert.equal(nested.loads, 25);
});

test("auto-scroll climbs at a paced 2-4 s a step, with a 30-60 s rest every 20 steps", async () => {
  const { paces, restNotes, loads, status } = await runPage("auto");
  assert.equal(loads, 25);
  assert.match(status, /reached the start of the channel/);
  // the long rest says so on the panel, and the note is gone once the climb is over
  assert.equal(restNotes.length, 1);
  assert.match(restNotes[0], /resting for up to a minute/);
  assert.doesNotMatch(status, /resting/);
  // the first step starts at once; then one pause after each step that didn't end the climb
  assert.equal(paces[0], 0);
  const after = paces.slice(1);
  assert.equal(after.length, 26, "25 loading steps and one empty one before the start is confirmed");
  after.forEach((ms, k) => {
    const [lo, hi] = (k + 1) % 20 === 0 ? [30000, 60000] : [2000, 4000];
    assert.ok(ms >= lo && ms < hi, `pause after step ${k + 1}: ${ms} ms`);
  });
});

test("Stop during the long rest takes the rest note off the panel at once", async () => {
  const { paces, restNotes, status } = await runPage("auto", [], { AUTO_STOP_REST: "1" });
  assert.match(restNotes[0], /resting for up to a minute/);
  // stopped as the rest began: no step after it
  assert.ok(paces.at(-1) >= 30000);
  assert.doesNotMatch(status, /resting/);
});

test("Stop and Auto-scroll again mid-climb keep counting toward the long rest", async () => {
  const plain = await runPage("auto");
  const restarted = await runPage("auto", [], { AUTO_RESTART: "10" });
  // the rest still comes once 20 steps have loaded, not 20 steps after the restart
  assert.deepEqual(plain.restLoads, [20]);
  assert.deepEqual(restarted.restLoads, [20]);
  assert.equal(restarted.loads, 25);
  // the restart waits out the pause the Stop cut short: no pause under 2 s after the first
  assert.ok(restarted.paces.slice(1).every((ms) => ms >= 2000), restarted.paces.join(","));
  // and it is exactly the cut pause (all of it: the clock hadn't moved when Stop landed)
  assert.ok(Math.abs(restarted.paces[11] - restarted.paces[10]) < 1, restarted.paces.join(","));
});

test("Stop in the wait after a nudge, and Auto-scroll again, wait out the pacing gap", async () => {
  const restarted = await runPage("auto", [], { AUTO_STOP_WAIT: "3" });
  assert.equal(restarted.loads, 25);
  assert.match(restarted.status, /reached the start of the channel/);
  // Stop lands in the wait after step 3's nudge, with the clock still at the nudge: the
  // restart's own step waits the unexpired 2-4 s gap out, it doesn't nudge at once
  assert.ok(restarted.paces[3] >= 2000 && restarted.paces[3] < 4000, restarted.paces.join(","));
  // step 3's nudge was made before the Stop, so it counts toward the long rest: the rest
  // still comes after the 20th nudge (here, the 20th load), not one step late
  assert.deepEqual(restarted.restLoads, [20]);
  // A climb that ends in a quick wait (reached-since) leaves the nudge gap standing, so
  // a restart inside it still paces — the same in kind as a pause remainder before this
  // fix; the long-rest path overwrites the gap exactly as before.
});

test("Stop in the wait after the 20th nudge, and Auto-scroll again, still take the long rest", async () => {
  const { paces, restNotes, restLoads, loads, status } = await runPage("auto", [], { AUTO_STOP_WAIT: "20" });
  // the rest is owed from the 20th nudge on: the restart waits it out (all of it: the
  // clock is still at the nudge), with the note up, instead of moving on after 2-4 s
  assert.deepEqual(restLoads, [20], paces.join(","));
  assert.equal(paces.filter((ms) => ms >= 30000).length, 1, paces.join(","));
  assert.match(restNotes[0], /resting for up to a minute/);
  assert.equal(loads, 25);
  assert.match(status, /reached the start of the channel/);
});

test("Stop and Auto-scroll again during the long rest wait out the rest", async () => {
  const { paces, restNotes, loads, status } = await runPage("auto", [], { AUTO_RESTART: "rest" });
  const long = paces.filter((ms) => ms >= 30000);
  // the rest, then what was left of it (all of it: the clock hadn't moved) after the restart
  assert.equal(long.length, 2, paces.join(","));
  assert.ok(Math.abs(long[1] - long[0]) < 1, paces.join(","));
  assert.equal(restNotes.length, 2);
  assert.match(restNotes[1], /resting for up to a minute/);
  assert.equal(loads, 25);
  assert.match(status, /reached the start of the channel/);
});

test("every page the tests ask for is in WARM", () => {
  const warmKeys = new Set(WARM.map(([s, a = [], e = {}]) => keyOf(s, a, e)));
  assert.deepEqual([...askedByTests].filter((k) => !warmKeys.has(k)), [],
    "a runPage call site is missing from WARM; add its [scenario, args, env] entry");
  assert.deepEqual([...warmKeys].filter((k) => !askedByTests.has(k)), [],
    "a WARM entry no test asks for; remove it or fix its key");
});
