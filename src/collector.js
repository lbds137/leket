// Discord tools collector. The extension injects it into the page's own world when its
// toolbar button is clicked on a DM (discord.com/channels/@me/<channel id>), a server
// channel or a thread (discord.com/channels/<server id>/<channel id>). Pasted into
// DevTools (F12 > Console) instead, it works alone and Save downloads the JSON only.
//
// Reads only what the Discord page has already loaded while you scroll up; it makes no
// API calls of its own. A small panel shows the count, the oldest date and roughly how big
// the attachments are. "Auto-scroll" scrolls up gently until the start of the conversation,
// or until the "stop at" date when one is typed in; "start at" names a chunk's newest edge
// (a very long conversation is saved in chunks: jump to a Discord search result for the
// upper edge, collect down to "stop at", and let the saves be merged by message id —
// "start at" clips nothing, notes harmless overlap with the chunk before, and warns when
// the jump landed more than a day back and left a gap). "Save" hands
// discord-<name>-<channel>.json to the extension's export tab, which fetches the
// attachments and saves the zip, in parts when it is large.
// Text comes from the message object Discord keeps in React (memoizedProps.message), not
// the rendered DOM, which drops links, custom emoji and markdown.
// A forwarded message keeps what was forwarded (text, attachments, embeds) in forwarded,
// read from the message's snapshots; forwards_without_snapshot in the export counts
// forwards whose snapshots weren't found (Discord's field names for them are a guess).
// In a server channel the export also lists the participants: each author's server
// nickname and roles, from Discord's member stores (null where those can't be found).
// Bars hiding a blocked or ignored user's messages are clicked open as they load; the
// panel counts them and says where any that wouldn't open sits (scroll back to it, so it is
// clicked again, then Save again), and the export's hidden_groups names any that never opened.
(() => {
  const [, GUILD, CHANNEL] = location.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/) || [];
  if (!CHANNEL) return alert("Open a DM or a server channel first (the address should be discord.com/channels/…/<number>).");
  // a second click on the toolbar button while the panel is open leaves the one there
  if (document.getElementById("discord-tools-panel")) return;
  const IS_DM = GUILD === "@me";
  // The tab title is "(3) Discord | @name" while there are unread messages; it names the
  // downloaded file. An unread mark before it ("• Discord | …") would otherwise keep
  // "Discord" in the name.
  const NAME = (document.title.replace(/^\(\d+\)\s*/, "").replace(/^[^\p{L}\p{N}]*Discord\s*\|\s*/u, "")
    .replace(/^@/, "").trim() || "dm")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_");
  const OUT = `discord-${NAME}-${CHANNEL}.json`;
  const DISCORD_EPOCH = 1420070400000n;
  const seen = new Map();
  let fromDom = 0;

  const isoFromSnowflake = (id) =>
    new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();

  // same format as export.js's copy of this helper: the collector is injected into the
  // page alone, so the two cannot share an import
  const humanSize = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB`
    : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.ceil(b / 1024)} KB`;

  // A message's author is the account (global name), not the server member: the server
  // nickname and roles live in Discord's own Flux stores, found by name in the page's
  // webpack modules. Store and method names are Discord's internals, read off its
  // client and not stable: whatever isn't found leaves those fields null, the export's
  // member_data says what was, and member_data_debug what the search saw. No one route
  // is known to work on every build, so the search tries three.
  const STORE_DEBUG = { chunk_global: false, runtime_count: 0, runtimes: [], module_cache: 0, module_factories: 0,
    modules_required: 0, flux_registry: false, objects_seen: 0, names_sample: [], get_member_like: 0,
    stores_seen: 0, guild_related: [], source_hits: {}, matched_by: {}, error: null };
  const STORES = (() => {
    const found = { members: null, roles: null, guilds: null };
    if (IS_DM) return found;
    const want = new Map([["GuildMemberStore", "members"], ["GuildRoleStore", "roles"], ["GuildStore", "guilds"]]);
    // by the methods the collector calls, for a build whose store names can't be read;
    // a store found by name wins over one found this way
    const fn = (s, ...names) => names.every((k) => { try { return typeof s[k] === "function"; } catch { return false; } });
    const shapes = [
      ["members", (s) => fn(s, "getMember") && (fn(s, "getMembers") || fn(s, "getMemberIds") || fn(s, "getNick"))],
      ["roles", (s) => fn(s, "getRole") && (fn(s, "getRoles") || fn(s, "getUnsafeMutableRoles") || fn(s, "getSortedRoles"))],
      ["guilds", (s) => fn(s, "getGuild") && (fn(s, "getGuilds") || fn(s, "getGuildCount") || fn(s, "getGuildIds"))],
    ];
    const byShape = { members: null, roles: null, guilds: null };
    const named = new Set();
    let registry = null;
    const done = () => found.members && found.roles && found.guilds;
    const nameOf = (s) => {
      for (const get of [() => s.getName(), () => s.constructor.displayName, () => Object.getPrototypeOf(s).constructor.name]) {
        try {
          const n = get();
          if (typeof n === "string" && n) return n;
        } catch { /* try the next */ }
      }
      return null;
    };
    // Flux's base Store class lists every store: a static getAll() on a store's class
    // chain counts only if what it lists holds that store
    const findRegistry = (s) => {
      try {
        for (let C = s.constructor; C && C !== Function.prototype; C = Object.getPrototypeOf(C)) {
          if (typeof C.getAll !== "function") continue;
          const all = C.getAll();
          if (Array.isArray(all) && all.includes(s)) return C;
        }
      } catch { /* no class chain */ }
      return null;
    };
    const consider = (s) => {
      if (!s || typeof s !== "object") return;
      STORE_DEBUG.objects_seen++;
      const n = nameOf(s);
      // identifier-shaped names only (class and store names), never free text
      if (n && /^[A-Za-z$_][\w$]{1,40}$/.test(n) && n !== "Object" && STORE_DEBUG.names_sample.length < 20
        && !STORE_DEBUG.names_sample.includes(n)) STORE_DEBUG.names_sample.push(n);
      if (fn(s, "getMember")) STORE_DEBUG.get_member_like++;
      const storeLike = /^[A-Za-z]{3,40}Store$/.test(n || "");
      if (storeLike && !named.has(n)) {
        named.add(n);
        STORE_DEBUG.stores_seen++;
        if (/guild|member|role/i.test(n) && STORE_DEBUG.guild_related.length < 40) STORE_DEBUG.guild_related.push(n);
      }
      const slot = want.get(n);
      if (slot && !found[slot]) {
        found[slot] = s;
        STORE_DEBUG.matched_by[slot] = "name";
      }
      let shaped = false;
      for (const [k, test] of shapes) {
        if (!byShape[k] && test(s)) { byShape[k] = s; shaped = true; }
      }
      if (!registry && (storeLike || shaped)) registry = findRegistry(s);
    };
    // one odd module (a throwing getter, a Proxy) mustn't end the search
    const scan = (ex) => {
      try {
        if (!ex || (typeof ex !== "object" && typeof ex !== "function")) return;
        consider(ex);
        for (const k of Object.keys(ex)) {
          try { consider(ex[k]); } catch { /* a getter that throws */ }
        }
      } catch { /* skip this module */ }
    };
    try {
      // A page can run several webpack runtimes on the one chunk global, each passing a
      // pushed chunk on to the one before and calling the callback with its own require:
      // every one is kept and searched.
      const reqs = [];
      const chunks = window.webpackChunkdiscord_app;
      STORE_DEBUG.chunk_global = !!chunks;
      chunks.push([[Symbol("discord-tools")], {}, (r) => { if (r && !reqs.includes(r)) reqs.push(r); }]);
      chunks.pop();
      STORE_DEBUG.runtime_count = reqs.length;
      STORE_DEBUG.runtimes = reqs.map((r) => {
        let c = 0, m = 0;
        try { c = Object.keys(r.c || {}).length; m = Object.keys(r.m || {}).length; } catch { /* unreadable */ }
        STORE_DEBUG.module_cache += c;
        STORE_DEBUG.module_factories += m;
        return { module_cache: c, module_factories: m };
      });
      const registryPass = () => {
        if (done() || !registry) return;
        STORE_DEBUG.flux_registry = true;
        try { for (const s of registry.getAll() || []) consider(s); } catch { /* skip */ }
      };
      // 1. each runtime's cache of modules already run
      for (const req of reqs) {
        let cache = [];
        try { cache = Object.values(req.c || {}); } catch { /* none */ }
        for (const mod of cache) {
          if (done()) break;
          try { scan(mod && mod.exports); } catch { /* skip */ }
        }
      }
      // 2. Flux's own list of stores
      registryPass();
      const until = Date.now() + 15000;
      const factories = (req) => { try { return Object.entries(req.m || {}); } catch { return []; } };
      const requireId = (req, id) => {
        STORE_DEBUG.modules_required++;
        try { scan(req(id)); } catch { /* skip */ }
      };
      // 3. the modules that name the stores in their own source (where the store sets its
      // name), found by reading the factories' text without running them, then required
      // by id. require() consults webpack's real module cache, so a module that has run
      // (the guild stores run as Discord starts) returns the live store, even where the
      // cache exposed as req.c holds only a few modules.
      for (const req of reqs) {
        if (done() || typeof req !== "function") break;
        for (const [id, f] of factories(req)) {
          if (done() || Date.now() > until) break;
          let src = "";
          try { src = Function.prototype.toString.call(f); } catch { continue; }
          // quoted, so "SelectedGuildStore" doesn't count for "GuildStore"
          for (const name of want.keys()) {
            if (!src.includes(`"${name}"`) && !src.includes(`'${name}'`)) continue;
            STORE_DEBUG.source_hits[name] = (STORE_DEBUG.source_hits[name] || 0) + 1;
            if (STORE_DEBUG.source_hits[name] <= 20) requireId(req, id);
          }
        }
      }
      registryPass();
      // 4. no runtime keeps a cache at all: require each module by id. One already run
      // returns its exports; one not yet run runs now, as Discord would on first use.
      // Never where any cache exists: a store in a module never run would be new and
      // empty, and say "found" with no members. Bounded by the same 15 s.
      const cached = (req) => { try { return Object.keys(req.c || {}).length; } catch { return 0; } };
      if (!done() && reqs.every((req) => !cached(req))) {
        for (const req of reqs) {
          if (typeof req !== "function") continue;
          for (const [id] of factories(req)) {
            if (done() || Date.now() > until) break;
            requireId(req, id);
          }
        }
        registryPass();
      }
    } catch (e) {
      STORE_DEBUG.error = String((e && e.message) || e).slice(0, 120);
      console.warn("Discord tools: member stores not reachable", e);
    }
    for (const k of Object.keys(found)) {
      if (!found[k] && byShape[k]) {
        found[k] = byShape[k];
        STORE_DEBUG.matched_by[k] = "methods";
      }
    }
    return found;
  })();
  const call = (store, fn, ...args) => {
    try { return store && typeof store[fn] === "function" ? store[fn](...args) : undefined; } catch { return undefined; }
  };
  const GUILD_NAME = IS_DM ? null : ((call(STORES.guilds, "getGuild", GUILD) || {}).name || null);

  const roleOf = (rid) => {
    const pick = (x) => (Array.isArray(x) ? x.find((r) => r && r.id === rid) : x && x[rid]);
    const r = call(STORES.roles, "getRole", GUILD, rid)
      || pick(call(STORES.roles, "getUnsafeMutableRoles", GUILD))
      || pick(call(STORES.roles, "getRoles", GUILD))
      || call(STORES.guilds, "getRole", GUILD, rid)
      || pick((call(STORES.guilds, "getGuild", GUILD) || {}).roles)
      || pick(call(STORES.guilds, "getRoles", GUILD));
    if (!r) return { id: rid, name: null, color: null, position: null };
    const color = r.colorString || (r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null);
    return { id: rid, name: r.name || null, color, position: typeof r.position === "number" ? r.position : null };
  };

  // One entry per distinct author. A webhook (a proxy bot's posts) reuses one id for
  // every name it posts under, so each of its names is its own participant.
  const people = new Map();
  // Asked again for each of their messages and once more at the save, so nick and roles
  // are the latest Discord held; a member it no longer holds keeps what was last found.
  const resolveMember = (p) => {
    const store = STORES.members;
    if (IS_DM || p.webhook || !store || typeof store.getMember !== "function") return;
    let mem;
    try { mem = store.getMember(GUILD, p.id); } catch { return; }
    if (!mem) {
      if (p.member_found !== true) p.member_found = false;
      return;
    }
    p.member_found = true;
    p.nick_source = "store";
    p.nick = mem.nick || null;
    p.roles = (mem.roles || []).map(roleOf).sort((x, y) => (y.position ?? -1) - (x.position ?? -1));
  };
  const noteAuthor = (m, a, id) => {
    const webhook = !!(m.webhookId || m.webhook_id);
    const key = webhook ? `webhook:${a.id}:${a.username}` : a.id;
    let p = people.get(key);
    if (!p) {
      p = {
        id: a.id || null,
        username: a.username || null,
        global_name: a.globalName || a.global_name || null,
        nick: null,
        roles: null,
        // true: Discord holds this person's server membership; false: it answered without
        // it (they left, or it was never loaded); null: it couldn't be asked (a DM, a
        // webhook, no member store or no getMember in it, or the lookup threw)
        member_found: null,
        // "store": nick and roles from Discord's member store; "page": the nick from the
        // message header's props (no roles then); null: neither
        nick_source: null,
        // the name Discord rendered over their messages, read off the page
        shown_as: null,
        // the role whose colour that name wears, from the message header's props
        color_role: null,
        bot: !!a.bot,
        webhook,
        messages: 0,
        first_message: null,
        last_message: null,
      };
      people.set(key, p);
    }
    const when = isoFromSnowflake(id);
    p.messages++;
    if (!p.first_message || when < p.first_message) p.first_message = when;
    if (!p.last_message || when > p.last_message) p.last_message = when;
    if (!p.shown_as) {
      // the name's own element, not the header around it, which also holds a server tag
      // badge ("Name [TAG], Server Tag: TAG") and hover text ("nick\nGreeters"); failing
      // that, the header's first line without the badge, which ends in "]," (a nickname's
      // own brackets, "Moon [she/her]", have no comma after them)
      const el = document.getElementById(`message-username-${id}`);
      const own = el && el.querySelector('[class^="username"], [class*=" username"]');
      const first = (node) => ((node && node.innerText) || "").split("\n")[0].trim();
      p.shown_as = first(own) || first(el).replace(/\s*\[[^\]]*\],\s*$/, "").trim() || null;
    }
    // read again at every message seen, the latest found winning: a header rendered
    // before Discord loaded the member shows the plain name and no role colour
    if (!IS_DM && !webhook) {
      const el = document.getElementById(`message-username-${id}`);
      const pa = el && fiberAuthor(el, p.id);
      if (pa) {
        const was = pageAuthor.get(p);
        pageAuthor.set(p, { nick: pa.nick || (was && was.nick) || null, colorRoleName: pa.colorRoleName || (was && was.colorRoleName) || null });
        p.color_role = pageAuthor.get(p).colorRoleName;
      }
    }
    resolveMember(p);
    return p;
  };

  // Where the member stores can't be found, the page still knows the nickname: the
  // message header's React props carry the author as Discord rendered it ({nick,
  // colorString, colorRoleName}), the role named being the one whose colour the name wears.
  const pageAuthor = new Map();
  // An author object naming someone else (its id or userId not theirs) is passed over.
  const fiberAuthor = (el, uid) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    for (let f = key && el[key], i = 0; f && i < 30; f = f.return, i++) {
      const a = f.memoizedProps && f.memoizedProps.author;
      if (!a || typeof a !== "object" || !("nick" in a) || !("colorString" in a || "colorRoleName" in a)) continue;
      const who = a.id || a.userId;
      if (who && who !== uid) continue;
      return { nick: typeof a.nick === "string" && a.nick ? a.nick : null, colorRoleName: a.colorRoleName || null };
    }
    return null;
  };

  const fiberMessage = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    for (let f = key && el[key], i = 0; f && i < 30; f = f.return, i++) {
      const m = f.memoizedProps && f.memoizedProps.message;
      if (m && m.id) return m;
    }
    return null;
  };

  // A blocked or ignored user's run of messages is folded into one bar ("3 blocked
  // messages", "Show messages") whose rows Discord renders only once it's opened, so
  // harvest() would never see them. Each bar found is clicked open (again ~1.5 s later
  // while it still reads "Show", up to five times, and again from the start when it comes
  // back after being scrolled out of the page) and listed in the export, the ones never
  // seen open as not_opened; the panel says where each of those sits. A bar is known by its kind and the message above it,
  // with the latest count it gave; one with no message above it yet is left until older
  // messages load (it would come back under another key), unless the start is reached or
  // Save is pressed. (Checked live on ignored and on blocked bars: every message kept.)
  const ROW = `li[id^="chat-messages-${CHANNEL}-"]`;
  const BAR = /(?:(\d+)\s+)?(blocked|ignored)\s+messages?\b/i;
  const hidden = new Map();
  const barState = (b) => {
    const t = b.textContent || "";
    return /\bhide\b/i.test(t) ? "open" : /\bshow\b/i.test(t) ? "closed" : null;
  };
  // a message row is one carrying its message (a bar Discord might render as a list
  // item with a message-like id carries none); a message's own text never makes a bar
  const rowId = (e) => (e.id && e.id.startsWith(`chat-messages-${CHANNEL}-`) ? e.id.slice(`chat-messages-${CHANNEL}-`.length) : null);
  const isRow = (e) => {
    const id = rowId(e);
    const m = id && (fiberMessage(e) || fiberMessage(e.firstElementChild || e));
    return !!m && m.id === id;
  };
  // an element's text less its message rows' (an opened group's rows may sit in the bar)
  const ownText = (e) => {
    let t = e.textContent || "";
    for (const r of e.querySelectorAll ? e.querySelectorAll(ROW) : []) t = t.replace(r.textContent || "", " ");
    return t;
  };
  const BUTTONS = '[role="button"], button, [class*="blockedAction"], [class*="ignoredAction"]';
  const holds = (x, b) => {
    for (let p = b; p; p = p.parentElement) if (p === x) return true;
    return false;
  };
  // the bar around a Show/Hide button: the nearest ancestor naming blocked or ignored
  // messages, short of the list itself or one holding another bar's button
  const inRow = (b) => {
    for (let e = b; e; e = e.parentElement) if (isRow(e)) return true;
    return false;
  };
  const barOf = (b, root) => {
    if (inRow(b)) return null;
    for (let e = b, i = 0; e && e !== root && i < 6; e = e.parentElement, i++) {
      if (e !== b && [...e.querySelectorAll(BUTTONS)].some((x) => !holds(x, b) && !holds(b, x) && barState(x) && !inRow(x))) break;
      const m = BAR.exec(ownText(e));
      if (m) return { el: e, kind: m[2].toLowerCase(), count: m[1] ? Number(m[1]) : null };
    }
    return undefined;
  };
  const rowAbove = (bar) => {
    for (let e = bar; e && e !== document.body; e = e.parentElement) {
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) {
        if (isRow(s)) return rowId(s);
        const inner = [...(s.querySelectorAll ? s.querySelectorAll(ROW) : [])].filter(isRow);
        if (inner.length) return rowId(inner[inner.length - 1]);
      }
    }
    return null;
  };
  // Show/Hide buttons outside messages not tied to a bar (most seen in one pass): a bar
  // worded or laid out otherwise than expected would show up here
  let unrecognized = 0;
  let expandError = null;
  // returns how many bars it clicked
  const expandHidden = ({ final = false, click = true } = {}) => {
    const first = document.querySelector(ROW);
    const root = document.querySelector('[data-list-id="chat-messages"]') || (first && first.parentElement);
    if (!root) return 0;
    const s = scroller();
    const top = final || reachedStart || (!!s && atStart(s));
    let clicked = 0, odd = 0;
    for (const b of root.querySelectorAll(BUTTONS)) {
      const state = barState(b);
      const bar = state && barOf(b, root);
      if (bar === undefined) odd++;
      if (!bar) continue;
      const after = rowAbove(bar.el);
      if (!after && !top) continue;
      // the count is no part of the key: a bar's count can change while its group loads
      const key = `${bar.kind}|${after}`;
      // a top bar recorded at a Save, met again once older messages loaded above it
      const atTop = `${bar.kind}|null`;
      if (after && !hidden.has(key) && hidden.has(atTop)) {
        hidden.set(key, Object.assign(hidden.get(atTop), { after_message_id: after }));
        hidden.delete(atTop);
      }
      const g = hidden.get(key) || { kind: bar.kind, count: bar.count, after_message_id: after, opened: false, clicks: 0, last: 0, tries: 0, button: b };
      g.count = bar.count;
      hidden.set(key, g);
      // a bar scrolled out of the page and back is drawn anew, a new button: its clicks
      // start over (the one it had may have been spent while it was going)
      if (g.button !== b) {
        g.button = b;
        g.clicks = 0;
        g.last = 0;
      }
      if (state === "open") g.opened = true;
      else if (click && g.clicks < 5 && Date.now() - g.last > 1500) {
        g.clicks++;
        g.tries++;
        g.last = Date.now();
        b.click();
        clicked++;
      }
    }
    unrecognized = Math.max(unrecognized, odd);
    return clicked;
  };
  // a failure here must not stop the harvest: it is shown on the panel and in the export
  const expandSafely = (opts) => {
    try {
      return expandHidden(opts);
    } catch (e) {
      expandError = String((e && e.message) || e);
      return 0;
    }
  };

  // a bot's message (a ban log, a ticket) often has no content, only embeds; the client's
  // record names their text rawTitle/rawDescription/rawName/rawValue, the API title/description/name/value
  const embedOf = (e) => {
    const out = {
      type: e.type || null,
      title: e.rawTitle || e.title || null,
      description: e.rawDescription || e.description || null,
      url: e.url || null,
      author: (e.author && e.author.name) || null,
      fields: (e.fields || []).map((f) => ({ name: f.rawName || f.name || "", value: f.rawValue || f.value || "" })),
      footer: (e.footer && e.footer.text) || null,
      timestamp: e.timestamp ? String(e.timestamp) : null,
      image: (e.image && e.image.url) || (e.thumbnail && e.thumbnail.url) || null,
    };
    if (!out.fields.length) delete out.fields;
    for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
    return out;
  };
  // size is kept when Discord gives it (bytes): the panel's pre-save estimate and the
  // export tab's disk check are built from it
  const attachmentsOf = (m) => (m.attachments || []).map((x) => ({ filename: x.filename, url: x.url,
    ...(x.size != null ? { size: Number(x.size) } : {}) }));

  // A forward is a message whose reference has type 1, or that carries snapshots: what was
  // forwarded sits in its snapshots (the client's record calls them messageSnapshots, the
  // API message_snapshots, each {message: {…}}; read off neither live yet). A reply's
  // reference has type 0 or none. A forward first seen without its snapshots is read again
  // each pass until they arrive.
  const FORWARD = 1;
  const snapshotsOf = (m) => {
    const snaps = m.messageSnapshots || m.message_snapshots || [];
    return Array.isArray(snaps) ? snaps : [];
  };
  const isoOf = (t) => {
    if (!t) return null;
    try {
      return typeof t.toISOString === "function" ? t.toISOString() : new Date(String(t)).toISOString();
    } catch { return String(t); }
  };
  const forwardedOf = (m) => snapshotsOf(m).map((s) => {
    const x = (s && s.message) || s || {};
    return { text: x.content || "", datetime: isoOf(x.timestamp), attachments: attachmentsOf(x), embeds: (x.embeds || []).map(embedOf) };
  });
  const waitingForSnapshots = (rec) => !!rec.forward_of && !rec.forwarded.length;

  const harvest = () => {
    for (const li of document.querySelectorAll(ROW)) {
      const id = li.id.slice(`chat-messages-${CHANNEL}-`.length);
      const had = seen.get(id);
      if (had && !waitingForSnapshots(had)) continue;
      const m = fiberMessage(li) || fiberMessage(li.firstElementChild || li);
      if (had) {
        if (m && m.id === id) had.forwarded = forwardedOf(m);
        continue;
      }
      if (m && m.id === id) {
        const a = m.author || {};
        const p = a.id ? noteAuthor(m, a, id) : null;
        const ref = m.messageReference || m.message_reference || null;
        const forward = (!!ref && ref.type === FORWARD) || snapshotsOf(m).length > 0;
        const forwarded = forward ? forwardedOf(m) : [];
        seen.set(id, {
          id,
          datetime: isoFromSnowflake(id),
          author: a.globalName || a.global_name || a.username || null,
          author_username: a.username || null,
          author_id: a.id || null,
          // the server nickname at the save (Discord keeps no history of it)
          nick: (p && p.nick) || null,
          text: m.content || "",
          reply_to: (!forward && ref && ref.message_id) || null,
          attachments: attachmentsOf(m),
          embeds: (m.embeds || []).map(embedOf),
          edited: !!(m.editedTimestamp || m.edited_timestamp),
          type: m.type,
          // a forward's source message, and what was forwarded (empty where the snapshots
          // weren't found: counted in forwards_without_snapshot)
          ...(forward ? { forward_of: { message_id: (ref && ref.message_id) || null, channel_id: (ref && ref.channel_id) || null,
            guild_id: (ref && ref.guild_id) || null }, forwarded } : {}),
        });
      } else {
        const content = document.getElementById(`message-content-${id}`);
        fromDom++;
        seen.set(id, {
          id,
          datetime: isoFromSnowflake(id),
          author: null,
          author_username: null,
          author_id: null,
          nick: null,
          text: content ? content.innerText : "",
          reply_to: null,
          attachments: [],
          embeds: [],
          edited: false,
          type: null,
          from_dom: true,
        });
      }
    }
    render();
  };

  const panel = document.createElement("div");
  panel.id = "discord-tools-panel";
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;background:#111;color:#eee;max-width:420px;" +
    "font:13px sans-serif;padding:8px 10px;border-radius:6px;border:1px solid #555";
  const heading = document.createElement("div");
  heading.textContent = `Discord tools: ${NAME}`;
  heading.style.cssText = "font-weight:bold;margin-bottom:4px";
  panel.appendChild(heading);
  const status = document.createElement("div");
  const btn = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "margin:6px 6px 0 0;padding:3px 8px;cursor:pointer";
    b.onclick = fn;
    panel.appendChild(b);
    return b;
  };
  panel.appendChild(status);

  function render() {
    const ids = [...seen.keys()].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    const oldest = ids.length ? seen.get(ids[0]).datetime.slice(0, 10) : "-";
    let files = 0, sized = 0, fileBytes = 0;
    for (const m of seen.values()) {
      for (const a of m.attachments || []) { files++; if (a.size) { sized++; fileBytes += a.size; } }
      for (const f of m.forwarded || []) for (const a of f.attachments || []) { files++; if (a.size) { sized++; fileBytes += a.size; } }
    }
    const groups = [...hidden.values()];
    const shut = groups.filter((g) => !g.opened && g.tries >= 3).length;
    status.textContent = `${seen.size} messages, oldest ${oldest}` +
      (fromDom ? ` (${fromDom} from page text only)` : "") +
      (files && fileBytes >= 1048576 ? `, ≈ ${sized < files ? "at least " : ""}${humanSize(fileBytes)} in ${files} attachment file${files === 1 ? "" : "s"}` : "") +
      (groups.length ? `, ${groups.filter((g) => g.opened).length} blocked/ignored groups opened` : "") +
      (shut ? `, ${shut} WOULD NOT OPEN${whereShut(groups.filter((g) => !g.opened && g.tries >= 3))}` : "") +
      (expandError ? `, ERROR opening blocked/ignored messages: ${expandError}` : "");
  }

  // where each bar that wouldn't open sits, by the message above it, so it can be scrolled
  // back to (it is clicked again when it reappears) before saving again
  function whereShut(shut) {
    const at = shut.map((g) => {
      if (!g.after_message_id) return `${g.kind} bar at the top`;
      const m = seen.get(g.after_message_id);
      if (!m) return `${g.kind} bar after message ${g.after_message_id}`;
      const words = m.text.replace(/\s+/g, " ").trim().slice(0, 40);
      return `${g.kind} bar after ${m.datetime.slice(0, 16).replace("T", " ")} UTC` + (words ? ` "${words}"` : "");
    });
    return at.length ? ` (scroll back to: ${at.join("; ")})` : "";
  }

  const scroller = () => {
    const li = document.querySelector(`li[id^="chat-messages-${CHANNEL}-"]`);
    for (let e = li && li.parentElement; e; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight) return e;
    }
    return null;
  };

  // The start is Discord's own header, not a run of scrolls that loaded nothing: a stalled
  // lazy loader looks just like the end. (Header wording read off Discord's UI, not verified
  // against every client version, nor the channel and thread forms at all: a run that never
  // sees it says so.)
  const START = IS_DM ? /beginning of your direct message history/i
    : /This is the start of the #|Welcome to #|Started by /i;
  let reachedStart = false;
  const atStart = (s) => START.test(s.textContent);

  // "start at": the newest edge of a chunk, for a save resumed mid-conversation (jump to a
  // Discord search result first, then collect down to the "stop at" day). Nothing is
  // clipped: messages on or after the day only overlap the chunk before, and Save warns
  // when the newest message is more than a day older (a jump that landed too far back and
  // may have left a gap).
  const startAt = document.createElement("input");
  startAt.placeholder = "start at YYYY-MM-DD (optional)";
  startAt.style.cssText = "display:block;width:210px";
  panel.appendChild(startAt);
  // "stop at": in a busy server channel, scroll back only as far as this day
  const since = document.createElement("input");
  since.placeholder = "stop at YYYY-MM-DD (optional)";
  since.style.cssText = "display:block;margin-top:6px;width:210px";
  panel.appendChild(since);
  // whether the export tab downloads the attachments into the zip too
  const withFiles = document.createElement("label");
  withFiles.style.cssText = "display:block;margin-top:6px";
  const withFilesBox = document.createElement("input");
  withFilesBox.type = "checkbox";
  withFilesBox.checked = true;
  withFiles.appendChild(withFilesBox);
  withFiles.appendChild(document.createTextNode(" save attachments too"));
  panel.appendChild(withFiles);
  let reachedSince = null;
  const sinceDay = () => (/^\d{4}-\d{2}-\d{2}$/.test(since.value.trim()) ? since.value.trim() : null);
  const startAtDay = () => (/^\d{4}-\d{2}-\d{2}$/.test(startAt.value.trim()) ? startAt.value.trim() : null);
  const oldestDay = () => {
    const ids = [...seen.keys()].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    return ids.length ? seen.get(ids[0]).datetime.slice(0, 10) : null;
  };

  let timer = null;
  let idle = 0;
  // One step: nudge Discord into loading older messages, wait until they land (or ~5 s),
  // then decide. The scroller is looked up again every step: Discord re-renders the chat
  // list as it loads, and a scroller kept from the first step can be a detached element
  // that no longer moves anything (the stall a manual scroll cured). The nudge is what a
  // person does: scroll to the top, then turn the wheel upward there.
  const nudge = (s) => {
    // setting scrollTop = 0 on a scroller already at 0 fires no scroll event: down a little first
    s.scrollTop = Math.min(300, s.scrollHeight - s.clientHeight);
    requestAnimationFrame(() => {
      s.scrollTop = 0;
      s.dispatchEvent(new WheelEvent("wheel", { deltaY: -800, deltaMode: 0, bubbles: true, cancelable: true }));
    });
  };
  const step = () => {
    if (!timer) return;
    const s = scroller();
    const before = seen.size;
    if (s) nudge(s);
    const started = Date.now();
    const wait = () => {
      if (!timer) return;
      expandSafely();
      harvest();
      if (seen.size === before && Date.now() - started < 5000) return (timer = setTimeout(wait, 250));
      idle = seen.size === before ? idle + 1 : 0;
      const now = scroller(), day = sinceDay(), oldest = oldestDay();
      if (now && atStart(now) && idle >= 2) {
        reachedStart = true;
        stopAuto();
        status.textContent += ` — reached the start of the ${IS_DM ? "DM" : "channel"}`;
      } else if (day && oldest && oldest < day) {
        reachedSince = day;
        stopAuto();
        status.textContent += ` — reached ${day}`;
      } else if (idle >= 8) {
        // eight empty tries of ~5 s each
        stopAuto();
        status.textContent += " — STALLED, not at the start: scroll up by hand, then Auto-scroll again";
      } else {
        timer = setTimeout(step, 400);
      }
    };
    timer = setTimeout(wait, 250);
  };
  const autoBtn = btn("Auto-scroll", () => {
    if (timer) return stopAuto();
    if (!scroller()) return alert("Open the conversation first, then press Auto-scroll again.");
    idle = 0;
    autoBtn.textContent = "Stop";
    timer = setTimeout(step, 0);
  });
  function stopAuto() {
    clearTimeout(timer);
    timer = null;
    autoBtn.textContent = "Auto-scroll";
  }

  // true once the bridge says the export tab is opening; false after 5 s without a word
  const handOver = (json) => new Promise((resolve) => {
    if (document.documentElement.dataset.discordToolsBridge !== "1") return resolve(false);
    const id = `${Date.now()}-${Math.random()}`;
    const done = (ok) => {
      clearTimeout(timeout);
      window.removeEventListener("message", onAck);
      resolve(ok);
    };
    const onAck = (e) => {
      const d = e.data;
      if (e.source === window && d && d.type === "discord-tools:ack" && d.id === id) done(!!d.ok);
    };
    const timeout = setTimeout(() => done(false), 5000);
    window.addEventListener("message", onAck);
    window.postMessage({ type: "discord-tools:export", id, file: OUT, json, attachments: withFilesBox.checked }, location.origin);
  });

  let saving = false;
  btn("Save", async () => {
    // a second press while bars are opening would save twice
    if (saving) return;
    // bars clicked now, or not yet seen open (one clicked moments ago is not clicked
    // again), get a second to render their rows, then are read again unclicked
    saving = true;
    if (expandSafely({ final: true }) || [...hidden.values()].some((g) => !g.opened)) {
      status.textContent = "Opening blocked/ignored messages…";
      await new Promise((r) => setTimeout(r, 1000));
    }
    saving = false;
    expandSafely({ final: true, click: false });
    harvest();
    const hiddenGroups = [...hidden.values()].map(({ kind, count, after_message_id, opened }) => ({ kind, count, after_message_id, opened }));
    const notOpened = hiddenGroups.filter((g) => !g.opened).length;
    const s = scroller();
    reachedStart = reachedStart || (!!s && atStart(s));
    // members and roles not loaded while a message was on screen may be by now
    for (const p of people.values()) {
      resolveMember(p);
      // the header's nick falls back to the global name or username where there is no
      // server nickname, so a nick equal to either isn't taken for one
      const pa = pageAuthor.get(p);
      if (p.nick_source !== "store" && pa && !p.webhook && !IS_DM) {
        p.nick = pa.nick && pa.nick !== p.global_name && pa.nick !== p.username ? pa.nick : null;
        p.nick_source = "page";
      }
    }
    const messages = [...seen.values()].sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
    const startDay = startAtDay();
    const afterStart = startDay ? messages.filter((m) => String(m.datetime || "").slice(0, 10) >= startDay).length : 0;
    const newest = messages.length ? messages[messages.length - 1].datetime : null;
    const newestDay = newest ? newest.slice(0, 10) : null;
    const startGap = !!(startDay && newestDay && Date.parse(startDay) - Date.parse(newestDay) > 86400000);
    for (const m of messages) {
      const p = m.author_id && people.get(m.author_id);
      if (p) m.nick = p.nick;
    }
    const participants = [...people.values()].sort((x, y) => y.messages - x.messages);
    const memberData = IS_DM ? null
      : [["members", "GuildMemberStore"], ["roles", "GuildRoleStore"], ["guilds", "GuildStore"]]
        .filter(([k]) => STORES[k])
        .map(([k, n]) => (STORE_DEBUG.matched_by[k] === "methods" ? `${n} (by its methods)` : n))
        .join(" + ") || "none found";
    const json = JSON.stringify(
      {
        source: "discord",
        channel: NAME,
        channel_id: CHANNEL,
        // null for a DM; a server channel's or thread's server id otherwise
        guild_id: IS_DM ? null : GUILD,
        guild_name: GUILD_NAME,
        extracted_at: new Date().toISOString(),
        // false: Discord's start-of-conversation header was never seen, so older messages
        // may be missing, unless reached_since says the run meant to stop at that day
        reached_start: reachedStart,
        reached_since: reachedSince,
        // the newest edge of what was collected: a chunk resumed mid-conversation names it,
        // so gaps between chunks can be checked. start_at is the upper bound that was asked
        // (null when none was); messages_after_start counts the collected messages on or
        // after that day, which overlap the chunk before (they are kept anyway)
        reached_until: newest,
        start_at: startDay,
        messages_after_start: afterStart,
        method:
          `Saved by the Discord tools collector on the open ${IS_DM ? "DM" : "server channel"}. ` +
          "Text, author, attachments, embeds (their text fields), reply, forward and edit state come from the React message object; " +
          "datetime comes from the snowflake id. Rows marked from_dom used rendered text only. " +
          (IS_DM ? "A DM has no server nicknames or roles. "
            : `Server nicknames and roles come from Discord's own stores (found: ${memberData}), ` +
              "as Discord held them at the save (or when last found, for a member it no longer held), not when each message was sent; where no store held them, nick comes from the message header's props (nick_source \"page\", no roles). shown_as is the name rendered over the author's messages, color_role the role whose colour it wears. ") +
          "Bars folding a blocked or ignored user's messages were clicked open before harvesting; hidden_groups lists each, opened false where it was never seen reading Hide (its messages may be missing).",
        // the blocked/ignored-message bars found: kind, the count the bar gave, the message
        // above it, and whether it was seen open; unrecognized_buttons counts Show/Hide
        // buttons outside messages not tied to a bar (one worded or laid out otherwise)
        hidden_groups: { opened: hiddenGroups.length - notOpened, not_opened: notOpened, groups: hiddenGroups,
          unrecognized_buttons: unrecognized, error: expandError },
        // which of Discord's stores the nicknames and roles came from; null for a DM
        member_data: memberData,
        // what the store search saw (counts and store names only); null for a DM
        member_data_debug: IS_DM ? null : STORE_DEBUG,
        // forwards (reference type 1) whose forwarded content wasn't found on the message
        forwards_without_snapshot: messages.filter(waitingForSnapshots).length,
        participants,
        messages,
      },
      null,
      1,
    );
    // The extension's bridge (src/bridge.js, in the content-script world) marks the page and
    // answers a handoff once the export tab is on its way. Pasted into DevTools without it, or
    // with no answer (the extension reloaded since the button was clicked), Save downloads
    // the JSON alone, so no collected messages are lost.
    const handedOver = await handOver(json);
    let where;
    if (handedOver) {
      where = "Handed to the export tab (it opens next to this one)";
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = OUT;
      document.body.appendChild(a);
      a.click();
      a.remove();
      where = (document.documentElement.dataset.discordToolsBridge === "1"
        ? "The extension didn't answer (reload this tab and click its button again for attachments); messages saved" : "Saved") +
        ` to Downloads/${OUT}`;
    }
    status.textContent = `${where}: ${messages.length} messages` +
      (newest ? ` (newest ${newest.slice(0, 16).replace("T", " ")} UTC)` : "") +
      (reachedStart ? "" : reachedSince ? ` (from ${reachedSince} on, as asked)`
        : " — the start was not reached: older messages may be missing") +
      (afterStart ? `; ${afterStart} message(s) are dated on or after start-at ${startDay} (UTC days, as "stop at" is): that overlaps the chunk before, nothing is lost` : "") +
      (startGap ? `; the newest message is dated ${newestDay}, more than a day before start-at ${startDay}: if the conversation had messages between those days they are NOT in this save (jump to the newest search result and save again)` : "") +
      (hiddenGroups.length ? `; ${hiddenGroups.length - notOpened} blocked/ignored groups opened` : "") +
      (notOpened ? `, ${notOpened} WOULD NOT OPEN: their messages are missing` +
        whereShut([...hidden.values()].filter((g) => !g.opened)) : "") +
      (expandError ? `; ERROR opening blocked/ignored messages: ${expandError}` : "");
  });
  btn("Close", () => {
    stopAuto();
    clearTimeout(observer.t);
    observer.disconnect();
    panel.remove();
  });

  const observer = new MutationObserver(() => {
    clearTimeout(observer.t);
    observer.t = setTimeout(() => {
      expandSafely();
      harvest();
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.body.appendChild(panel);
  expandSafely();
  harvest();
})();
