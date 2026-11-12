// Runs src/modules/discord/collector.js against a fake Discord page and prints the file name and JSON its
// Save button hands over, as {"file": …, "export": …, "status": …, "posted": …}.
// Usage: node fake_page.cjs <scenario> [tab title] [mod nick]
// (guild | guild-guildstore-roles | guild-no-stores | guild-no-getmember |
// guild-throwing-getmember | guild-no-cache | guild-registry | guild-unnamed |
// guild-empty-cache | guild-two-runtimes | guild-hidden | guild-hidden-inside |
// guild-hidden-throws | guild-hidden-returns | dm | dm-forward | auto; auto clicks
// Auto-scroll instead of Save and prints {paces, restNotes, restLoads, loads, status}; with
// AUTO_STOP_REST=1 it presses Stop as the long rest begins, with AUTO_RESTART it presses
// Stop and Auto-scroll again, with AUTO_STOP_WAIT=N the same on step N's wait timer (what
// N names past the loading steps: see there). With BRIDGE=1 in the
// environment the page carries the extension bridge's mark, and Save posts the export
// (posted: the message) instead of downloading it. START_AT fills the start-at box before
// Save. The stores mimic the shape the collector
// expects of Discord's; that they match the live client is checked only by a run on the real page.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scenario = process.argv[2];
const title = process.argv[3];
const modNick = process.argv[4] || "Mod Nick";
const IS_DM = scenario.startsWith("dm");
const GUILD = "500", CHANNEL = "600";
const snowflake = (n) => String((BigInt(Date.UTC(2021, 0, n) - 1420070400000) << 22n));

const users = {
  alice: { id: "1", username: "alice_u", globalName: "Alice" },
  mod: { id: "2", username: "mod_u", globalName: "Global Mod", bot: false },
  left: { id: "3", username: "left_u", global_name: "Gone" },
  late: { id: "4", username: "late_u", globalName: "Late" },
  hook: (name) => ({ id: "9", username: name }),
};
const msgs = [
  { id: snowflake(1), author: users.alice, content: "one" },
  { id: snowflake(2), author: users.mod, content: "two" },
  // a bot log: no content, one embed as the client holds it (raw* names), one as the API sends it
  { id: snowflake(3), author: users.mod, content: "", embeds: [
    { type: "rich", rawTitle: "Member banned", rawDescription: "<@5> spam",
      fields: [{ rawName: "Moderator", rawValue: "mod_u", inline: true }], footer: { text: "ID: 5" },
      timestamp: "2021-03-22T02:39:25.750Z", author: { name: "YAGPDB" } },
    { title: "Plain", thumbnail: { url: "https://x/t.png" } },
  ] },
  { id: snowflake(4), author: users.left, content: "four" },
  { id: snowflake(5), author: users.hook("Proxy One"), webhookId: "9", content: "five" },
  { id: snowflake(6), author: users.hook("Proxy Two"), webhookId: "9", content: "six" },
  { id: snowflake(7), author: users.late, content: "seven" },
];
// dm-forward: a reply, a forward as the client holds it (messageSnapshots, a moment-like
// timestamp), one as the API sends it, and one whose snapshots aren't there
if (scenario === "dm-forward") {
  const file = (n) => ({ filename: `f${n}.png`, url: `https://cdn.discordapp.com/attachments/1/${n}/f${n}.png`,
    ...(n === 1 ? { size: 2000000 } : {}) });
  msgs.push(
    { id: snowflake(8), author: users.alice, content: "a reply", messageReference: { type: 0, message_id: snowflake(1) } },
    { id: snowflake(9), author: users.alice, content: "", messageReference: { type: 1, message_id: "77", channel_id: "88", guild_id: "99" },
      messageSnapshots: [{ message: { content: "forwarded words", timestamp: { toISOString: () => "2020-12-01T00:00:00.000Z" },
        attachments: [file(1), { filename: "g.png", url: "https://cdn.discordapp.com/attachments/1/1/g.png" }], embeds: [{ rawTitle: "Card" }] } }] },
    { id: snowflake(10), author: users.mod, content: "", message_reference: { type: 1, message_id: "78" },
      message_snapshots: [{ message: { content: "api form", timestamp: "2020-12-02T00:00:00+00:00", attachments: [], embeds: [] } }] },
    { id: snowflake(11), author: users.mod, content: "", messageReference: { type: 1, message_id: "79" } },
    // its snapshots arrive after it was first read
    { id: snowflake(12), author: users.mod, content: "", messageReference: { type: 1, message_id: "80" } },
    // snapshots, but a reference with no type
    { id: snowflake(13), author: users.mod, content: "", messageReference: { message_id: "81" },
      messageSnapshots: [{ message: { content: "no type", attachments: [], embeds: [] } }] },
  );
}
const lateSnapshots = scenario === "dm-forward" ? msgs.find((m) => m.id === snowflake(12)) : null;
// as a real page had them: the header's text carries a server tag badge or
// hover text after the name; the name's own element (Alice's) holds the name alone
const rendered = {
  [snowflake(2)]: { innerText: `${modNick} [TAG], \nServer Tag: TAG\nTAG`,
    author: { nick: modNick, colorString: "#ff0000", colorRoleName: "Admins" } },
  // the header's nick is the global name where there's no server nickname
  [snowflake(1)]: { innerText: "Alice\nGreeters", child: "Alice", author: { nick: "Alice", colorString: null } },
  // a nickname's own brackets stay, on either path; an empty own element falls back
  [snowflake(4)]: { innerText: "Moon [she/her]", child: "Moon [she/her]" },
  [snowflake(7)]: { innerText: "Star [he/him] [TAG], \nServer Tag: TAG\nTAG", child: "",
    author: { id: "2", nick: "Someone Else", colorRoleName: "Admins" } },   // another person's: passed over
};

let lateLoaded = false;
const members = {
  // gone from the store by the save: what was found while scrolling stays
  get "1"() { return lateLoaded ? undefined : { nick: "Alice Nick", roles: ["r-mod"] }; },
  "2": { nick: modNick, roles: ["r-mod", "r-late", "r-admin", "r-gone"] },
  get "4"() { return lateLoaded ? { nick: "Late Nick", roles: ["r-mod"] } : undefined; },
};
// r-late reaches the role store only after every message was seen, as in a long scroll
const roleTable = () => ({
  "r-admin": { id: "r-admin", name: "Admins", color: 16711680, position: 5 },
  "r-mod": { id: "r-mod", name: "Moderators", colorString: "#00ff00", position: 3 },
  ...(lateLoaded ? { "r-late": { id: "r-late", name: "Late Role", color: 255, position: 1 } } : {}),
});
// guild-unnamed: a minified build whose stores give no readable name at all
const UNNAMED = scenario === "guild-unnamed";
class Store { getName() { return UNNAMED ? undefined : this.constructor.displayName; } }
class GuildMemberStore extends Store {
  getMember(g, u) {
    if (scenario === "guild-throwing-getmember") throw new Error("changed internals");
    return g === GUILD ? members[u] : undefined;
  }
  getMemberIds() { return Object.keys(members); }
}
if (scenario === "guild-no-getmember") GuildMemberStore.prototype.getMember = undefined;
class GuildRoleStore extends Store {
  getRole(g, r) { return g === GUILD ? roleTable()[r] : undefined; }
  getRoles(g) { return g === GUILD ? roleTable() : undefined; }
}
class GuildStore extends Store {
  getGuild(g) {
    return g === GUILD ? { name: "Test Server", roles: scenario === "guild-guildstore-roles" ? roleTable() : undefined } : undefined;
  }
  getGuilds() { return { [GUILD]: this.getGuild(GUILD) }; }
}
for (const [C, n] of [[GuildMemberStore, "GuildMemberStore"], [GuildRoleStore, "GuildRoleStore"], [GuildStore, "GuildStore"]]) {
  if (UNNAMED) Object.defineProperty(C, "name", { value: "q" });
  else C.displayName = n;
}
// not Flux, though named like a store and with a static getAll: must not be taken for the registry
class DecoyStore { getName() { return "DecoyStore"; } static getAll() { return []; } }

// odd modules first: none of them may end the search for the stores after them
const modules = {
  1: { get exports() { throw new Error("exports getter that throws"); } },
  2: { exports: new Proxy({}, { ownKeys() { throw new Error("ownKeys trap that throws"); } }) },
  3: { exports: null },
  4: { exports: { get boom() { throw new Error("getter that throws"); } } },
  5: { exports: new GuildMemberStore() },   // a module whose exports is the store itself
  6: { exports: { ZP: new GuildStore(), other: 5 } },
};
if (scenario !== "guild-guildstore-roles") modules[7] = { exports: { default: new GuildRoleStore() } };

const el = (props = {}) => ({
  style: {}, children: [], textContent: "", value: "",
  appendChild(c) { this.children.push(c); return c; },
  remove() {}, click() { if (this.onClickHook) this.onClickHook(this); },
  ...props,
});
const created = [];
// the panel's status line, found by its words ("N messages, oldest …"), not its position
const statusLine = () => created.find((e) => e.tag === "div" && /^\d+ messages, oldest/.test(e.textContent));
const autoButton = () => created.find((e) => e.tag === "button" && (e.textContent === "Auto-scroll" || e.textContent === "Stop"));
let saved = null;
const lis = msgs.map((m) => el({
  id: `chat-messages-${CHANNEL}-${m.id}`,
  parentElement: null,
  "__reactFiber$x": { memoizedProps: { message: m }, return: null },
}));
// auto: the rows sit in a scroller; each wheel turn at its top loads one older message,
// AUTO_LOADS in all, and the turn after that shows Discord's start-of-channel header.
// Time is virtual (each timer moves the clock by its delay and fires at once), and the
// delay before each Auto-scroll step is recorded in `paces`.
const AUTO = scenario === "auto";
const AUTO_LOADS = 25;
let loads = 0, vnow = Date.UTC(2021, 1, 1);
const paces = [], restNotes = [], restLoads = [];
// AUTO_QUOTE=1: the third older message quotes the header's wording ("Welcome to #rules"),
// rows carry their text inside the scroller as Discord's do, and the loader stalls after
// the last load without ever showing the header — the climb must say STALLED.
// AUTO_QUOTE=short: the third older message is just "Welcome", a piece of the header that
// does show at the end — cutting the row's text must not cut the header's.
// AUTO_QUOTE=nested: the fourth older message is "Welcome to", which opens with the third
// one's "Welcome" — cutting rows first-to-last would take the "Welcome" inside the later
// row, and the "Welcome to" cut would then fall back to the header's own wording.
// (The fake appends loads in load order, so "Welcome to" sits after "Welcome" in the
// scroller's text; real Discord prepends older rows, which would reverse them — the pin
// rides on this fake's order.)
const AUTO_QUOTE = process.env.AUTO_QUOTE;
const QUOTE = AUTO_QUOTE === "1" || AUTO_QUOTE === "short" || AUTO_QUOTE === "nested";
const STALL = AUTO_QUOTE === "1";
let header = "";
const scrollEl = el({ scrollHeight: 2000, clientHeight: 500, scrollTop: 0,
  querySelectorAll(sel) { return QUOTE && sel === `li[id^="chat-messages-${CHANNEL}-"]` ? lis.filter((li) => li.parentElement === this) : []; },
  dispatchEvent() {
    if (loads === AUTO_LOADS) return void (header = STALL ? "" : "Welcome to #general!");
    const m = { id: String(BigInt(snowflake(1)) - BigInt(++loads)), author: users.alice,
      content: QUOTE && loads === 3 ? (STALL ? "hey all, Welcome to #rules" : "Welcome")
        : AUTO_QUOTE === "nested" && loads === 4 ? "Welcome to"
        : `older ${loads}` };
    lis.push(el({ id: `chat-messages-${CHANNEL}-${m.id}`, parentElement: this, textContent: m.content,
      "__reactFiber$x": { memoizedProps: { message: m }, return: null } }));
  } });
// a getter, not a prop: el() spreads its props, which would read it once and freeze it
Object.defineProperty(scrollEl, "textContent", {
  get() { return [header, ...(QUOTE ? lis.filter((li) => li.parentElement === this).map((li) => li.textContent) : [])].join(" "); },
});
if (AUTO) lis.forEach((li) => { li.parentElement = scrollEl; });
// AUTO_RESTART=N presses Stop and then Auto-scroll once, in the pause after step N;
// AUTO_RESTART=rest does it as the long rest begins; AUTO_STOP_WAIT=N does it in the
// wait after step N's nudge (the clock hasn't moved past the nudge when it fires)
let restarted = false, waitStops = 0;
const virtualSetTimeout = (f, ms = 0) => {
  if (f.name === "step") {
    paces.push(ms);
    // the status line, and how many messages had loaded, as a long rest begins
    if (ms >= 30000) {
      restNotes.push(statusLine().textContent);
      restLoads.push(loads);
      // AUTO_STOP_REST=1: Stop is pressed as the long rest begins
      if (process.env.AUTO_STOP_REST === "1") setTimeout(() => autoButton().onclick(), 0);
    }
    const at = process.env.AUTO_RESTART;
    if (at && !restarted && (at === "rest" ? ms >= 30000 : Number(at) === paces.length - 1)) {
      restarted = true;
      setTimeout(() => { const b = autoButton(); b.onclick(); b.onclick(); }, 0);
    }
  }
  // counts every wait timer a step schedules: during the loading steps (1-25 here) that
  // is exactly one per step — the fake lands a message on the first tick — so N means
  // step N. Later steps re-poll every 250 ms, so N past 25 names a poll, not a step.
  const waitAt = process.env.AUTO_STOP_WAIT;
  if (f.name === "wait" && waitAt && ++waitStops === Number(waitAt)) {
    setTimeout(() => { const b = autoButton(); b.onclick(); b.onclick(); }, 0);
  }
  return setTimeout(() => { vnow += ms; f(); }, 0);
};
class VirtualDate extends Date { static now() { return vnow; } }
// guild-hidden: the message list as a tree, with bars folding a blocked or ignored user's
// messages (the shape is a guess at Discord's: a bar naming the kind and count, with a
// Show/Hide button in it). Opening a bar puts its rows in the list after it.
const ROW = `li[id^="chat-messages-${CHANNEL}-"]`;
class Node {
  constructor(props = {}) { Object.assign(this, { children: [], parentElement: null, text: "", style: {} }, props); }
  get textContent() { return [this.text, ...this.children.map((c) => c.textContent)].join(" "); }
  get previousElementSibling() {
    const sibs = this.parentElement ? this.parentElement.children : [];
    return sibs[sibs.indexOf(this) - 1] || null;
  }
  add(c, at) {
    c.parentElement = this;
    this.children.splice(at === undefined ? this.children.length : at, 0, c);
    return c;
  }
  all(pred) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (pred(c)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    if (sel === ROW) return this.all((c) => c.tag === "li");
    if (sel.includes('[role="button"]')) return this.all((c) => c.role === "button");
    return [];
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() { if (this.onClick) this.onClick(); }
}
const list = new Node({ tag: "ol" });
const hiddenId = (n, k) => String(BigInt(snowflake(n)) + BigInt(k));
const rowNode = (m, text) => new Node({ tag: "li", id: `chat-messages-${CHANNEL}-${m.id}`, text: text || "",
  "__reactFiber$x": { memoizedProps: { message: m }, return: null } });
// a bar folding `rows` (none rendered until it opens); one that `sticks` never opens.
// guild-hidden-inside: each bar is itself a list item with a message-like id but no
// message, and its rows open inside it
const INSIDE = scenario === "guild-hidden-inside";
let barNo = 0;
const bar = (label, rows, sticks) => {
  const b = new Node(INSIDE ? { text: label, tag: "li", id: `chat-messages-${CHANNEL}-${hiddenId(9, ++barNo)}` } : { text: label });
  const button = b.add(new Node({ role: "button", text: rows.length > 1 ? "Show messages" : "Show message" }));
  button.onClick = () => {
    if (sticks || button.text.startsWith("Hide")) return;
    button.text = "Hide messages";
    // INSIDE rows render their content (real DOM rows do), so ownText cuts them back out
    // of the bar's text — the top bar below carries the full pin comment
    if (INSIDE) return rows.forEach((m) => b.add(rowNode(m, m.content)));
    const at = list.children.indexOf(b) + 1;
    rows.forEach((m, i) => list.add(rowNode(m), at + i));
  };
  return b;
};
let growing = null, returning = null, redraw = null;
if (scenario.startsWith("guild-hidden")) {
  const blocked = { id: "7", username: "blocked_u", globalName: "Blocked" };
  // one at the top of the loaded range, with no message above it yet. Its row is a piece
  // of the bar's label ("message" in "1 blocked message"): ownText cuts each row at its
  // LAST occurrence, so the row's own copy is cut and the label survives — a
  // first-occurrence cut would take the label's copy and the opened bar would stop
  // matching (this pins the occurrence half on the bar path; the later-first order is
  // pinned on the start path, by the auto scenario's nested-quote test)
  list.add(bar("1 blocked message", [{ id: hiddenId(1, -5), author: blocked, content: "message" }]));
  msgs.slice(0, 3).forEach((m) => list.add(rowNode(m)));
  // first seen while its group was still loading: "1 blocked message", then 2 by the save
  growing = list.add(bar("1 blocked message", [1, 2].map((k) => ({ id: hiddenId(3, k), author: blocked, content: `blocked ${k}` }))));
  msgs.slice(3, 5).forEach((m) => list.add(rowNode(m)));
  list.add(bar("1 Ignored Message", [{ id: hiddenId(5, 1), author: blocked, content: "ignored 1" }]));
  list.add(rowNode(msgs[5]));
  list.add(bar("3 blocked messages", [1, 2, 3].map((k) => ({ id: hiddenId(6, k), author: blocked, content: "never" })), true));
  // a message that only talks about blocked messages, with a button of its own
  const decoy = list.add(rowNode(msgs[6]));
  decoy.add(new Node({ text: "I have 2 blocked messages" })).add(new Node({ role: "button", text: "Show more" }));
  // a Show button outside any message that names no blocked or ignored messages
  list.add(new Node({ text: "Something else" })).add(new Node({ role: "button", text: "Show all" }));
  // guild-hidden-throws: a button whose text can't be read stops the bar search, not the harvest
  if (scenario === "guild-hidden-throws") {
    const bad = list.add(new Node({ role: "button" }));
    Object.defineProperty(bad, "textContent", { get() { throw new Error("detached"); } });
  }
  // guild-hidden-returns: a bar whose first click doesn't take, scrolled out of the page and
  // back before the save, drawn anew (a new element, as a virtualized list remounts it)
  if (scenario === "guild-hidden-returns") {
    redraw = (sticks) => bar("1 blocked message", [{ id: hiddenId(7, 1), author: blocked, content: "came back" }], sticks);
    returning = list.add(redraw(true));
  }
}
const document = {
  title: title || (IS_DM ? "Discord | @someone" : "Discord | #general | Test Server"),
  body: el(),
  querySelectorAll: (sel) => (sel !== ROW ? [] : scenario.startsWith("guild-hidden") ? list.querySelectorAll(ROW) : lis),
  querySelector: (sel) => (AUTO && sel === ROW ? lis[0]
    : scenario.startsWith("guild-hidden") && sel === '[data-list-id="chat-messages"]' ? list : null),
  getElementById: (id) => {
    const m = id.match(/^message-username-(\d+)$/);
    const r = m && rendered[m[1]];
    if (!r) return null;
    const child = r.child !== undefined && el({ innerText: r.child });
    // the header's props, a level up the fiber, as Discord's message header has them
    const fiber = { memoizedProps: {}, return: r.author ? { memoizedProps: { author: r.author }, return: null } : null };
    return el({ innerText: r.innerText, querySelector: (sel) => (child && sel.includes("username") ? child : null),
      "__reactFiber$y": fiber });
  },
  createElement: (tag) => {
    const e = el({ tag });
    if (tag === "a") e.onClickHook = (a) => { saved = a.href.parts.join(""); };
    created.push(e);
    return e;
  },
  createTextNode: (text) => ({ textContent: text }),
  documentElement: { dataset: process.env.BRIDGE === "1" ? { leketBridge: "1" } : {} },
};
let posted = null;
const listeners = [];
const observed = [];
// The sandbox's timers, scaled: the collector's real waits (its 300 ms debounce, the 1 s
// Save wait, the 5 s ack timeout) all run inside the sandbox, so they take ~SCALE real
// time and the suite spends its wall on node startups, not sleeps. The bridge ack fires
// from postMessage below on node's bare 10 ms setTimeout and wins by expiry order (a
// 10 ms timer is due before a 250 ms scaled one), so an edit that raises the ack's delay
// above the scaled 5 s timeout, or scales the bare timer, breaks the BRIDGE:1 test.
// Date is NOT scaled: Date.now()-based thresholds (e.g. the 1.5 s re-click throttle at
// collector.js:449) run on the real clock against scaled timers, so a fixture relying on
// their ratio would pin a mix the real page never produces. AUTO keeps its virtual
// clock, which paces the auto scenarios.
const SCALE = 1 / 20;
const sandbox = {
  location: { pathname: `/channels/${IS_DM ? "@me" : GUILD}/${CHANNEL}`, origin: "https://discord.com" },
  // the bridge's side: it answers a handoff unless BRIDGE_ACK=0 (an extension reloaded since)
  postMessage: (data, origin) => {
    if (data.type !== "leket:export") return;
    posted = { data, origin };
    if (process.env.BRIDGE_ACK !== "0") {
      setTimeout(() => listeners.forEach((f) => f({ source: vm.runInContext("window", sandbox), data: { type: "leket:ack", id: data.id, ok: true } })), 10);
    }
  },
  addEventListener: (type, f) => { if (type === "message") listeners.push(f); },
  removeEventListener: (type, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  document,
  alert: (s) => { throw new Error("alert: " + s); },
  console,
  getComputedStyle: (e) => ({ overflowY: AUTO && e === scrollEl ? "auto" : "visible" }),
  requestAnimationFrame: (f) => f(),
  setTimeout: AUTO ? virtualSetTimeout
    : (f, ms, ...rest) => setTimeout(f, Math.max(1, Math.round(ms * SCALE)), ...rest),
  clearTimeout,
  // the page's changes are announced by hand (mutated()), as Discord's DOM would
  MutationObserver: class { constructor(cb) { observed.push(cb); } observe() {} disconnect() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: (b) => b },
  WheelEvent: class {},
  BigInt, Date: AUTO ? VirtualDate : Date, JSON, Symbol, Map, Object, Array, Number, String,
};
sandbox.window = sandbox;
// guild-no-cache: the build keeps no module cache (req.c), only the factories (req.m);
// guild-registry: one store is exported, the rest only through Flux's Store.getAll()
const requireFn = (id) => modules[id].exports;
// factories as the bundle has them: a store's module names it in its source; another
// store's name that merely contains it ("SelectedGuildStore") doesn't count
const storeNames = { 5: "GuildMemberStore", 6: "GuildStore", 7: "GuildRoleStore" };
requireFn.m = Object.fromEntries(Object.keys(modules).map((id) => [id, storeNames[id]
  ? new Function(`return ${JSON.stringify(storeNames[id])};`)
  : () => "SelectedGuildStore"]));
if (scenario !== "guild-no-cache") {
  // guild-empty-cache: a cache with no store in it, where the factories must not be run
  requireFn.c = scenario === "guild-registry" ? { 4: { exports: new DecoyStore() }, 5: modules[5] }
    : scenario === "guild-empty-cache" ? { 3: modules[3], 4: { exports: { x: 1 } } } : modules;
}
if (scenario === "guild-registry") {
  Store.getAll = () => [modules[5].exports, modules[6].exports.ZP, modules[7].exports.default];
}
if (scenario.startsWith("guild") && scenario !== "guild-no-stores") {
  // guild-two-runtimes: the runtime with the stores calls the callback first, then a
  // small one (as webpack chains runtimes on one chunk global)
  const small = (id) => ({ x: id });
  small.c = { 900: { exports: { x: 1 } } };
  small.m = { 900: () => {}, 901: () => {} };
  sandbox.webpackChunkdiscord_app = {
    push: ([, , cb]) => {
      cb(requireFn);
      if (scenario === "guild-two-runtimes") cb(small);
    },
    pop: () => {},
  };
}

const src = fs.readFileSync(path.join(__dirname, "../../src/modules/discord/collector.js"), "utf8");
vm.runInNewContext(src, sandbox);
lateLoaded = true;
if (growing) growing.text = "2 blocked messages";
const save = created.find((e) => e.tag === "button" && e.textContent === "Save");
// a change to the page, then the collector's 300 ms debounce (scaled like every sandbox
// timer, to 15 ms at 1/20): this wait is on node's real clock, so it scales the same way
// and adds an absolute 20 ms slack — a bare 350*SCALE would leave only 2.5 ms of margin
const mutated = () => { observed.forEach((cb) => cb([])); return new Promise((r) => setTimeout(r, 300 * SCALE + 20)); };
(async () => {
  if (AUTO) {
    const auto = autoButton();
    auto.onclick();
    while (auto.textContent !== "Auto-scroll") await new Promise((r) => setTimeout(r, 1));
    return void process.stdout.write(JSON.stringify({ paces, restNotes, restLoads, loads, status: statusLine().textContent }));
  }
  if (returning) {
    const at = list.children.indexOf(returning);
    list.children.splice(at, 1);
    await mutated();
    list.add(redraw(false), at);
    await mutated();
  }
  if (lateSnapshots) {
    lateSnapshots.messageSnapshots = [{ message: { content: "late words", attachments: [], embeds: [] } }];
    await mutated();
  }
  if (process.env.START_AT) {
    const box = created.find((e) => e.tag === "input" && e.placeholder.startsWith("start at"));
    if (box) box.value = process.env.START_AT;
  }
  // the status line, read before Save overwrites it
  const status = statusLine();
  const panel = status.textContent;
  await save.onclick();
  const link = created.find((e) => e.tag === "a");
  const out = link
    ? { file: link.download, export: JSON.parse(saved) }
    : { file: posted.data.file, export: JSON.parse(posted.data.json) };
  if (posted) out.posted = { ...posted.data, json: undefined, origin: posted.origin };
  process.stdout.write(JSON.stringify({ ...out, status: status.textContent, panel, downloaded: !!link }));
})();
