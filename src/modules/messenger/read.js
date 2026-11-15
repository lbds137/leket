// Pure helpers for Leket's Messenger module: 64-bit integer and timestamp decoding,
// message normalization, media file naming, and Markdown rendering.
// Runs unchanged as a classic script in the page's MAIN world (before collector.js),
// in the Messenger export tab via <script>, and under node:vm in tests.
(() => {
  const KIND_BITS = new Map([
    [1n, "text"],
    [2n, "media"],
    [1024n, "link"],
    [16384n, "sticker"],
  ]);

  const MIME_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/mov": "mov",
  };

  const NBSP = String.fromCharCode(0xa0);

  function i64(x) {
    try {
      if (Array.isArray(x) && x.length === 2 && typeof x[0] === "number" && typeof x[1] === "number") {
        return (BigInt(x[0]) << 32n) + BigInt(x[1] >>> 0);
      }
      if (typeof x === "bigint") return x;
      if (typeof x === "number" || (typeof x === "string" && x.trim() !== "")) {
        return BigInt(x);
      }
    } catch {
      return null;
    }
    return null;
  }

  // A zero or negative timestamp means the field was missing, not 1970.
  function toIso(ts) {
    const n = i64(ts);
    if (n === null || n <= 0n) return null;
    const d = new Date(Number(n));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function contentKinds(bits) {
    const raw = i64(bits);
    if (raw === null || raw === 0n) return [];
    const out = [];
    // A negative plain number is a signed 32-bit word (bit 31 set), as `[0, n]` is unsigned.
    let rem = raw < 0n ? BigInt.asUintN(32, raw) : raw;
    let bit = 1n;
    while (rem > 0n) {
      if (rem & 1n) out.push(KIND_BITS.get(bit) || `other:${bit}`);
      rem >>= 1n;
      bit <<= 1n;
    }
    return out;
  }

  function normalize(message, senderName = null, outgoing = null) {
    if (!message || typeof message !== "object") return null;
    const sid = i64(message.senderId);
    const replyText = message.replyMessageText ?? message.replySnippet ?? null;
    const edits = Array.isArray(message.editCount) ? i64(message.editCount) : message.editCount;
    return {
      id: message.messageId != null ? String(message.messageId) : null,
      time: toIso(message.timestampMs),
      sender_id: sid !== null ? sid.toString() : null,
      sender: senderName ?? null,
      outgoing: typeof outgoing === "boolean" ? outgoing : null,
      text: message.text != null ? String(message.text) : null,
      unsent: Boolean(message.isUnsent),
      edited: Boolean(edits && Number(edits) > 0),
      reply_to: replyText !== null ? { text: String(replyText) } : null,
      kinds: contentKinds(message.displayedContentTypes),
      link: null,
      media: [],
    };
  }

  function safePart(s, max = 40) {
    const cleaned = [...String(s ?? "")
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/_+/g, "_")
      .replace(/^\.+/, "")]
      .slice(0, max)
      .join("");
    return cleaned || "x";
  }

  // Always passes validMediaName below.
  function mediaName(day, messageId, n, mime) {
    const baseMime = String(mime ?? "").split(";")[0].trim().toLowerCase();
    const ext = Object.hasOwn(MIME_EXT, baseMime) ? MIME_EXT[baseMime] : "bin";
    const idx = Number.isSafeInteger(n) && n >= 0 ? n : 0;
    return safePart(`${safePart(day, 10)}_${safePart(messageId)}_${idx}.${ext}`, 120);
  }

  // The export page's checks on names that come from the page world: a media file name
  // becomes a zip entry under messenger-media/, so no separator, no leading dot, no "..".
  const MEDIA_NAME_RE = /^[\p{L}\p{N}._-]{1,120}$/u;
  function validMediaName(name) {
    return typeof name === "string" && !name.startsWith(".") && MEDIA_NAME_RE.test(name);
  }

  const SAVE_NAME_RE = /^messenger-[\p{L}\p{N}._-]{1,60}-\d{1,25}\.json$/u;
  function validSaveName(file) {
    return typeof file === "string" && SAVE_NAME_RE.test(file) ? file : "messenger-export.json";
  }

  // Inline: every character CommonMark could read as markup is backslash-escaped,
  // so the rendered text matches what was sent.
  function escapeInline(s) {
    return String(s).replace(/[\\`*_[\]<>~|&]/g, "\\$&");
  }

  // Block: leading spaces become no-break spaces (4+ spaces would open a code block),
  // then a line-start marker gets a backslash. CommonMark escapes only ASCII punctuation,
  // so an ordered-list marker is broken before its "." or ")".
  function escapeLine(line) {
    const [, indent, rest] = /^([ \t]*)(.*)$/s.exec(escapeInline(line));
    const lead = indent.replace(/\t/g, "    ").replace(/ /g, NBSP);
    if (/^[#>\-+=:]/.test(rest)) return `${lead}\\${rest}`;
    return lead + rest.replace(/^(\d+)([.)])/, "$1\\$2");
  }

  // Consecutive lines in one paragraph, joined with backslash hard breaks; a blank line
  // in the source starts a new paragraph.
  function paragraphs(text, prefix = "") {
    const blocks = [];
    let cur = [];
    // a lone \r ends a line too, as it does for a CommonMark reader
    for (const ln of String(text).split(/\r\n|\r|\n/)) {
      if (ln.trim() === "") {
        if (cur.length) blocks.push(cur);
        cur = [];
      } else {
        cur.push(prefix + escapeLine(ln));
      }
    }
    if (cur.length) blocks.push(cur);
    return blocks.map((b) => b.join("\\\n")).join(prefix ? `\n${prefix.trimEnd()}\n` : "\n\n");
  }

  function oneLine(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
  }

  // An angle-bracket link destination ends at a space or `>`, and a `\` in it escapes.
  function safeHref(href) {
    return String(href).replace(/[\s<>\\]/g, (c) => encodeURIComponent(c));
  }

  function makeFormatter(tz) {
    const opts = {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    };
    try {
      return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
    } catch {
      return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
    }
  }

  function renderMarkdown(exp, { timeZone } = {}) {
    const fmt = makeFormatter(timeZone || (exp && exp.time_zone) || "UTC");
    const stampOf = (iso) => {
      if (iso == null) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      const parts = {};
      for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
      return { ms: d.getTime(), day: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
    };

    // a save from anywhere is untrusted: only an array's object entries are messages
    const messages = (exp && Array.isArray(exp.messages) ? exp.messages : []).filter((m) => m && typeof m === "object");
    const missing = new Map();
    for (const x of (exp && exp.media_not_captured) || []) {
      if (!x || x.message_id == null) continue;
      const list = missing.get(x.message_id) || [];
      list.push(x);
      missing.set(x.message_id, list);
    }
    const dated = [];
    const undated = [];
    for (const m of messages) {
      const st = stampOf(m.time);
      if (st) dated.push({ m, ...st });
      else undated.push(m);
    }
    dated.sort((a, b) => a.ms - b.ms || String(a.m.id).localeCompare(String(b.m.id)));

    const firstDate = dated.length ? dated[0].day : "(no date)";
    const lastDate = dated.length ? dated[dated.length - 1].day : "(no date)";
    const count = exp && exp.count != null ? exp.count : messages.length;
    const title = oneLine(exp && exp.title) || "Messenger conversation";
    const meta = [
      exp && exp.host ? exp.host : "messenger",
      exp && exp.thread_id != null ? `thread ${exp.thread_id}` : null,
      `${count} messages`,
      `${firstDate} – ${lastDate}`,
      exp && exp.saved_at ? `saved ${exp.saved_at}` : null,
    ].filter(Boolean).map(oneLine).join(" · ");

    const out = [`# ${escapeInline(title).replace(/#/g, "\\#")}`, escapeLine(meta)];

    const renderMessage = (m, hhmm) => {
      const name = oneLine(m.sender) || oneLine(m.sender_id) || "unknown";
      const label = `${escapeInline(name)}${m.outgoing === true ? " (you)" : ""}`;
      const blocks = [`**${label}**${hhmm ? ` ${hhmm}` : ""}`];
      if (m.reply_to && m.reply_to.text != null && String(m.reply_to.text).trim() !== "") {
        blocks.push(paragraphs(m.reply_to.text, "> "));
      }
      if (m.text != null && String(m.text).trim() !== "") blocks.push(paragraphs(m.text));

      const notes = [];
      if (m.unsent) notes.push("[unsent]");
      else {
        const media = m.media || [];
        for (const med of media) {
          if (med.kind === "video") {
            const secs = Number.isFinite(med.duration_s) ? `, ${Math.round(med.duration_s)} s` : "";
            notes.push(`[video${secs}](messenger-media/${med.file})`);
          } else {
            notes.push(`![photo](messenger-media/${med.file})`);
          }
        }
        const kinds = m.kinds || [];
        const lost = missing.get(m.id) || [];
        for (const x of lost) notes.push(`[${x.kind === "video" ? "video" : "photo"}, not captured]`);
        if (!lost.length && !media.length && kinds.includes("media")) {
          notes.push(`[${kinds.includes("video") ? "video" : "photo"}, not captured]`);
        }
        if (kinds.includes("sticker")) notes.push("[sticker]");
        // only a web link renders as one: javascript:, data: and the like are dropped
        if (typeof m.link === "string" && /^https?:\/\//i.test(m.link)) notes.push(`[link preview](<${safeHref(m.link)}>)`);
      }
      if (notes.length) blocks.push(notes.join("\\\n"));
      out.push(blocks.join("\n\n"));
    };

    let lastDay = null;
    for (const { m, day, hhmm } of dated) {
      if (day !== lastDay) {
        out.push(`## ${day}`);
        lastDay = day;
      }
      renderMessage(m, hhmm);
    }

    if (undated.length) {
      out.push("## (no date)");
      for (const m of undated) renderMessage(m, "");
    }

    return `${out.join("\n\n")}\n`;
  }

  const api = { i64, toIso, contentKinds, normalize, renderMarkdown, safePart, mediaName, validMediaName, validSaveName };
  globalThis.LeketMessengerRead = api;
  if (typeof module === "object" && module) module.exports = api;
})();
