// Leket Messenger collector: runs in the page's MAIN world after read.js.
// Sweeps the thread scroller up to the start and back down, harvests messages and
// data:/blob: photos and videos from React fibers and the DOM, and hands the save
// and its media Blobs to src/modules/messenger/bridge.js (or downloads JSON alone).
(() => {
  // a page can hint a faster sweep than the default — the smoke harness serves its
  // thread page with the hint; a real Messenger page never carries it, and the hint
  // can only hurry the sweep, never slow it past the default
  const STEP_MS = Math.min(Number(document.querySelector('meta[name="leket-poll-ms"]')?.content) || Infinity, 900);
  const STEP_FRACTION = 0.85;
  const ROWS_WAIT_MS = 10000;
  const STILL_STEPS = 3;
  const STALL_STEPS = 10;
  const ACK_WAIT_MS = 10000;
  // after the bridge says it accepted the post, how long the worker may take to open the export tab
  const ACK_FINAL_MS = 120000;
  const LARGE_BYTES = 1024 * 1024 * 1024;

  if (document.getElementById("leket-messenger-panel")) return;

  const ok = (location.hostname === "www.messenger.com" && /^\/(e2ee\/)?t\/\d+\/?$/.test(location.pathname))
    || (location.hostname === "www.facebook.com" && /^\/messages\/(e2ee\/)?t\/\d+\/?$/.test(location.pathname));

  const panel = document.createElement("div");
  panel.id = "leket-messenger-panel";
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;background:#111;color:#eee;max-width:420px;" +
    "font:13px sans-serif;padding:8px 10px;border-radius:6px;border:1px solid #555";

  const btn = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "margin:6px 6px 0 0;padding:3px 8px;cursor:pointer";
    b.onclick = fn;
    panel.appendChild(b);
    return b;
  };

  if (!ok) {
    const status = document.createElement("div");
    status.textContent = "Open a one-to-one conversation on messenger.com or facebook.com/messages, then click Leket's button again.";
    panel.appendChild(status);
    btn("Close", () => panel.remove());
    document.body.appendChild(panel);
    return;
  }

  const { normalize, mediaName, validMediaName } = globalThis.LeketMessengerRead;

  const cleanTitle = (raw) => {
    let t = String(raw ?? "").replace(/^\(\d+\)\s*/, "");
    const cut = t.indexOf(" | Messenger");
    if (cut >= 0) t = t.slice(0, cut);
    return t.trim();
  };

  const nameOf = (raw) => {
    const t = cleanTitle(raw) || "messenger";
    return [...t.replace(/[^\p{L}\p{N}._-]+/gu, "_")].slice(0, 50).join("") || "messenger";
  };

  const threadId = (location.pathname.match(/\/t\/(\d+)\/?$/) || [])[1] || "0";

  // The panel belongs to the conversation it was opened on: Messenger is a single-page app,
  // so the tab can move to another thread while this script stays.
  const pathOf = () => String(location.pathname).replace(/\/+$/, "");
  const launchPath = pathOf();
  const launchTitle = document.title;
  const MOVED_TEXT = "This tab moved to another conversation. Go back to the conversation this panel was opened on, or close this panel.";
  const movedAway = () => pathOf() !== launchPath;

  const heading = document.createElement("div");
  heading.textContent = `Leket: ${nameOf(launchTitle)}`;
  heading.style.cssText = "font-weight:bold;margin-bottom:4px";
  panel.appendChild(heading);

  const countsLine = document.createElement("div");
  panel.appendChild(countsLine);

  const statusLine = document.createElement("div");
  statusLine.style.cssText = "margin-top:4px";
  panel.appendChild(statusLine);

  // messageId -> { msg, capturedKeys, capturedSigs, capturedSlots, notCaptured, everSawMedia, captureSeq }
  const seen = new Map();
  // sender_id -> first contact.name seen for that sender
  const senders = new Map();
  // folded media file names already assigned in this save
  const takenNames = new Set();
  // rowIds (or row elements) whose harvest threw and did not later succeed
  const unreadableRows = new Set();
  // [{ name, blob }] in capture order
  const capturedFiles = [];
  let totalPhotos = 0;
  let totalVideos = 0;
  let totalBytes = 0;

  const isGroup = () => {
    const ids = new Set();
    for (const { msg } of seen.values()) {
      if (msg.sender_id !== null) ids.add(msg.sender_id);
    }
    return ids.size > 2;
  };

  const GROUP_WARN_TEXT = "This looks like a group conversation; groups aren't checked yet.";

  const setStatus = (text, withGroup = true) => {
    const warn = withGroup && isGroup() && !text.includes(GROUP_WARN_TEXT) ? ` ${GROUP_WARN_TEXT}` : "";
    statusLine.textContent = `${text}${warn}`;
  };

  const oldestDay = () => {
    let oldest = null;
    for (const { msg } of seen.values()) {
      if (msg.time) {
        const d = msg.time.slice(0, 10);
        if (!oldest || d < oldest) oldest = d;
      }
    }
    return oldest || "-";
  };

  const LARGE_NOTE = " — large save: keep this tab and the export tab open until it finishes";

  const renderCounts = () => {
    heading.textContent = `Leket: ${nameOf(launchTitle)}`;
    const mb = (totalBytes / 1048576).toFixed(1);
    const large = totalBytes > LARGE_BYTES ? LARGE_NOTE : "";
    countsLine.textContent = `${seen.size} messages, oldest ${oldestDay()}, photos ${totalPhotos}, videos ${totalVideos}, ${mb} MB${large}`;
  };

  const ROW_SEL = 'div[data-message-id][data-scope="messages_table"]';
  const getRows = () => {
    const list = document.querySelectorAll(ROW_SEL);
    if (list && list.length) return [...list];
    return [...document.querySelectorAll("div[data-message-id]")].filter(
      (el) => !el.dataset || !el.dataset.scope || el.dataset.scope === "messages_table",
    );
  };

  const findScroller = () => {
    const main = document.querySelector('[role="main"]');
    if (!main) return null;
    const candidates = [main, ...(main.querySelectorAll ? [...main.querySelectorAll("*")] : [])];
    let best = null;
    for (const el of candidates) {
      const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
      const oy = style ? style.overflowY : "";
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 50) {
        if (!best || el.clientHeight > best.clientHeight) best = el;
      }
    }
    return best;
  };

  const hasHeaderImg = (root) => {
    if (!root) return false;
    let foundRow = false;
    let foundImg = false;
    const walk = (node) => {
      if (!node || foundRow || foundImg) return;
      const tag = String(node.tagName || node.tag || "").toLowerCase();
      const msgId = (node.dataset && node.dataset.messageId)
        || (typeof node.getAttribute === "function" && node.getAttribute("data-message-id"));
      if (tag === "div" && msgId) {
        foundRow = true;
        return;
      }
      if (tag === "img") {
        const rectW = typeof node.getBoundingClientRect === "function" ? (node.getBoundingClientRect() || {}).width || 0 : 0;
        const w = node.naturalWidth || node.width || rectW || 0;
        if (w >= 48) {
          foundImg = true;
          return;
        }
      }
      const kids = node.children || [];
      for (let i = 0; i < kids.length; i++) {
        walk(kids[i]);
        if (foundRow || foundImg) return;
      }
    };
    walk(root);
    return foundImg;
  };

  const sourceKey = (src) => {
    if (src.startsWith("data:")) {
      const head = [...src.slice(0, 64)].join("");
      const tail = [...src.slice(-64)].join("");
      return `${src.length}:${head}${tail}`;
    }
    return src;
  };

  const hexOf = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  };

  const byteSig = (kind, size, first, last) =>
    `${kind}:${size}:${hexOf(first)}:${hexOf(last)}`;

  const sniffMime = (b) => {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
    if (
      b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    ) return "image/webp";
    if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
    return "";
  };

  const readMediaSource = async (src) => {
    if (src.startsWith("data:")) {
      const comma = src.indexOf(",");
      if (comma < 0) throw new Error("malformed data URL");
      const header = src.slice(5, comma);
      const body = src.slice(comma + 1);
      const rawMime = (header.split(";")[0] || "").trim().toLowerCase();
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const size = bytes.byteLength;
      const head = bytes.subarray(0, 64);
      const tail = bytes.subarray(Math.max(0, size - 64));
      const mime = rawMime || sniffMime(head);
      const blob = new Blob([bytes], { type: mime });
      return { size, head, tail, blob, mime };
    }
    const res = await fetch(src);
    if (res && res.ok === false) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const size = blob.size;
    // Guard (blob slice memory): hash/sniff with blob.slice(0, 64) and blob.slice(Math.max(0, size - 64)) and blob.size; never arrayBuffer() the whole blob
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const tail = new Uint8Array(await blob.slice(Math.max(0, size - 64)).arrayBuffer());
    const rawMime = String(blob.type || "").split(";")[0].trim().toLowerCase();
    const mime = rawMime || sniffMime(head);
    return { size, head, tail, blob, mime };
  };

  const withCollisionSuffix = (base, k) => {
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    const tail = `-${k}${ext}`;
    const cut = [...stem].slice(0, Math.max(1, 120 - tail.length)).join("");
    const candidate = `${cut}${tail}`;
    return validMediaName(candidate) ? candidate : mediaName("x", "x", k, "");
  };

  const uniqueMediaName = (day, messageId, n, mime) => {
    const base = mediaName(day, messageId, n, mime);
    let name = base;
    let suffix = 1;
    // Guard (name collision): if already taken case-insensitively, insert -2, -3, ... before the extension
    while (takenNames.has(name.toLowerCase())) name = withCollisionSuffix(base, ++suffix);
    takenNames.add(name.toLowerCase());
    return name;
  };

  const insideHttpLink = (el, stopAt) => {
    for (let p = el && el.parentElement; p && p !== stopAt; p = p.parentElement) {
      const tag = String(p.tagName || p.tag || "").toLowerCase();
      if (tag === "a") {
        const href = String((typeof p.getAttribute === "function" && p.getAttribute("href")) || p.href || "");
        if (href.startsWith("http")) return true;
      }
    }
    return false;
  };

  const firstHttpLink = (row) => {
    const links = row.querySelectorAll ? [...row.querySelectorAll('a[href^="http"], a')] : [];
    for (const a of links) {
      const href = String((typeof a.getAttribute === "function" && a.getAttribute("href")) || a.href || "");
      if (href.startsWith("http")) return href;
    }
    return null;
  };

  const NEVER_LOADED = "the photo never finished loading";

  const isComplete = (entry) => {
    const m = entry.msg;
    if (m.time === null || m.sender_id === null || typeof m.outgoing !== "boolean" || m.sender === null) return false;
    // Guard (photo-late): a media row is complete only once at least one item was captured and every seen item is captured
    // Guard (settled row): or once every seen item is accounted for (captured, or not capturable for a reason that a later visit cannot change)
    if (m.kinds.includes("media") && !entry.settled) return false;
    return true;
  };

  const isSlotOrKeyCaptured = (entry, slot, key) =>
    entry.capturedSlots.has(slot) || Boolean(key && entry.capturedKeys.has(key));

  const setNotCaptured = (entry, slot, key, kind, reason) => {
    if (isSlotOrKeyCaptured(entry, slot, key)) return;
    entry.notCaptured.set(slot, { kind, reason, key: key || null, slot });
  };

  const clearNotCaptured = (entry, slot, key) => {
    // Guard (photo-late): an item captured on a later visit removes its earlier not-captured state
    entry.notCaptured.delete(slot);
    if (key) {
      for (const [k, v] of entry.notCaptured) {
        if (v.key === key) entry.notCaptured.delete(k);
      }
    }
    entry.capturedSlots.add(slot);
  };

  const readRowFiber = (row, rowId) => {
    const fKey = Object.keys(row).find((k) => k.startsWith("__reactFiber$"));
    let msgObj = null;
    let outgoing = null;
    let senderName = null;
    for (let f = fKey ? row[fKey] : null, depth = 0; f && depth <= 80; f = f.return, depth++) {
      const p = f.memoizedProps;
      if (!p || typeof p !== "object") continue;
      if (!msgObj && p.message && typeof p.message === "object" && String(p.message.messageId) === String(rowId)) {
        msgObj = p.message;
      }
      if (msgObj) {
        if (outgoing === null && typeof p.outgoing === "boolean") outgoing = p.outgoing;
        if (senderName === null && p.value && p.value.contact && typeof p.value.contact.name === "string" && p.value.contact.name) {
          senderName = p.value.contact.name;
        }
        if (outgoing !== null && senderName !== null) break;
      }
    }
    return { msgObj, outgoing, senderName };
  };

  let sweeping = false;
  let stopRequested = false;
  let closed = false;
  let sweepPromise = null;
  let cancelSleep = null;
  let cancelHandOver = null;

  // True once the tab has left the launch conversation: the sweep stops and nothing more is collected.
  let moved = false;
  const checkMoved = () => {
    moved = movedAway();
    if (!moved) return false;
    stopRequested = true;
    if (cancelSleep) cancelSleep();
    setStatus(MOVED_TEXT, false);
    return true;
  };

  const harvestImpl = async () => {
    if (checkMoved()) return;
    for (const row of getRows()) {
      if (closed) return;
      if (checkMoved()) return;
      let rowKey = row;
      try {
        const rowId = (row.dataset && row.dataset.messageId)
          || (typeof row.getAttribute === "function" && row.getAttribute("data-message-id"));
        if (!rowId) continue;
        rowKey = String(rowId);
        const existing = seen.get(rowKey);
        if (existing && isComplete(existing)) continue;

        const { msgObj, outgoing, senderName } = readRowFiber(row, rowId);
        if (!msgObj) continue;
        const norm = normalize(msgObj, senderName, outgoing);
        if (!norm || !norm.id) continue;

        if (norm.sender_id && senderName && !senders.has(norm.sender_id)) {
          senders.set(norm.sender_id, senderName);
        }

        let entry = existing;
        if (!entry) {
          entry = {
            msg: norm,
            capturedKeys: new Set(),
            capturedSigs: new Set(),
            capturedSlots: new Set(),
            notCaptured: new Map(),
            everSawMedia: false,
            settled: false,
            captureSeq: 0,
          };
          seen.set(norm.id, entry);
        } else {
          const m = entry.msg;
          for (const k of ["time", "sender_id", "sender", "outgoing", "text", "reply_to"]) {
            if (m[k] === null && norm[k] !== null) m[k] = norm[k];
          }
          m.unsent = m.unsent || norm.unsent;
          m.edited = m.edited || norm.edited;
          for (const kind of norm.kinds) {
            if (!m.kinds.includes(kind)) m.kinds.push(kind);
          }
        }

        const href = firstHttpLink(row);
        if (entry.msg.link === null && href) entry.msg.link = href;

        if (entry.msg.kinds.includes("media") && !entry.msg.unsent) {
          const allImgs = row.querySelectorAll ? [...row.querySelectorAll("img")] : [];
          const imgs = allImgs.filter((img) => !insideHttpLink(img, row));
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            const slot = `img:${i}`;
            const isComp = Boolean(img.complete && img.naturalWidth > 0);
            if (isComp) {
              if (!(img.naturalWidth >= 150 && img.naturalHeight >= 150)) continue;
              entry.everSawMedia = true;
              const src = String(img.currentSrc || img.src || "");
              if (!src.startsWith("data:") && !src.startsWith("blob:")) {
                const key = src ? sourceKey(src) : null;
                if (isSlotOrKeyCaptured(entry, slot, key)) continue;
                const scheme = (src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [null, "none"])[1].toLowerCase();
                setNotCaptured(entry, slot, key, "photo", `not a data: or blob: source (${scheme})`);
                continue;
              }
              const key = sourceKey(src);
              if (entry.capturedKeys.has(key)) {
                clearNotCaptured(entry, slot, key);
                continue;
              }
              try {
                const { size, head, tail, blob, mime } = await readMediaSource(src);
                if (closed || checkMoved()) return;
                clearNotCaptured(entry, slot, key);
                entry.capturedKeys.add(key);
                const sig = byteSig("photo", size, head, tail);
                // Guard (remint): drop an item whose kind, size, and first/last 64 bytes match one already captured in this message
                if (entry.capturedSigs.has(sig)) continue;
                entry.capturedSigs.add(sig);
                const day = entry.msg.time ? entry.msg.time.slice(0, 10) : "no-date";
                const file = uniqueMediaName(day, entry.msg.id, ++entry.captureSeq, mime);
                entry.msg.media.push({
                  file,
                  kind: "photo",
                  mime,
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                  bytes: size,
                  duration_s: null,
                });
                capturedFiles.push({ name: file, blob });
                totalBytes += size;
                totalPhotos++;
              } catch (err) {
                if (closed || checkMoved()) return;
                if (isSlotOrKeyCaptured(entry, slot, key)) continue;
                setNotCaptured(entry, slot, key, "photo", `fetch failed: ${(err && err.message) || String(err)}`);
              }
            } else {
              const rect = typeof img.getBoundingClientRect === "function" ? img.getBoundingClientRect() : null;
              if (!(rect && rect.width >= 100 && rect.height >= 100)) continue;
              entry.everSawMedia = true;
              const src = String(img.currentSrc || img.src || "");
              const key = src ? sourceKey(src) : null;
              if (isSlotOrKeyCaptured(entry, slot, key)) continue;
              setNotCaptured(entry, slot, key, "photo", NEVER_LOADED);
            }
          }

          const allVideos = row.querySelectorAll ? [...row.querySelectorAll("video")] : [];
          const videos = allVideos.filter((v) => !insideHttpLink(v, row));
          for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            const slot = `video:${i}`;
            entry.everSawMedia = true;
            // Guard (video kind): a seen video adds "video" to the message's kinds
            if (!entry.msg.kinds.includes("video")) entry.msg.kinds.push("video");
            const src = String(video.currentSrc || video.src || "");
            if (!src) {
              if (isSlotOrKeyCaptured(entry, slot, null)) continue;
              setNotCaptured(entry, slot, null, "video", "no video source");
              continue;
            }
            if (!src.startsWith("blob:") && !src.startsWith("data:")) {
              const key = sourceKey(src);
              if (isSlotOrKeyCaptured(entry, slot, key)) continue;
              const scheme = (src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [null, "none"])[1].toLowerCase();
              setNotCaptured(entry, slot, key, "video", `not a data: or blob: source (${scheme})`);
              continue;
            }
            const key = sourceKey(src);
            if (entry.capturedKeys.has(key)) {
              clearNotCaptured(entry, slot, key);
              continue;
            }
            try {
              const { size, head, tail, blob, mime } = await readMediaSource(src);
              if (closed || checkMoved()) return;
              clearNotCaptured(entry, slot, key);
              entry.capturedKeys.add(key);
              const sig = byteSig("video", size, head, tail);
              // Guard (remint): drop an item whose kind, size, and first/last 64 bytes match one already captured in this message
              if (entry.capturedSigs.has(sig)) continue;
              entry.capturedSigs.add(sig);
              const day = entry.msg.time ? entry.msg.time.slice(0, 10) : "no-date";
              const file = uniqueMediaName(day, entry.msg.id, ++entry.captureSeq, mime);
              const vw = Number(video.videoWidth) > 0 ? Number(video.videoWidth) : null;
              const vh = Number(video.videoHeight) > 0 ? Number(video.videoHeight) : null;
              const dur = Number.isFinite(video.duration) ? video.duration : null;
              entry.msg.media.push({
                file,
                kind: "video",
                mime,
                width: vw,
                height: vh,
                bytes: size,
                duration_s: dur,
              });
              capturedFiles.push({ name: file, blob });
              totalBytes += size;
              totalVideos++;
            } catch (err) {
              if (closed || checkMoved()) return;
              if (isSlotOrKeyCaptured(entry, slot, key)) continue;
              // Guard (video fetch failure): record a failed video fetch in media_not_captured
              setNotCaptured(entry, slot, key, "video", `fetch failed: ${(err && err.message) || String(err)}`);
            }
          }

          // Guard (settled row): an item was seen, and every item not
          // captured failed for a reason a later visit cannot change (its source scheme); a
          // failed fetch, a missing video source or a photo still loading is tried again
          entry.settled = (entry.msg.media.length > 0 || entry.notCaptured.size > 0)
            && [...entry.notCaptured.values()].every((v) => v.reason.startsWith("not a data: or blob: source"));
        }
        unreadableRows.delete(rowKey);
      } catch {
        unreadableRows.add(rowKey);
      }
    }
    if (closed || checkMoved()) return;
    renderCounts();
  };

  let inFlightHarvest = null;
  const harvest = () => {
    const p = harvestImpl().finally(() => {
      if (inFlightHarvest === p) inFlightHarvest = null;
    });
    inFlightHarvest = p;
    return p;
  };

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => {
      cancelSleep = null;
      resolve();
    }, ms);
    cancelSleep = () => {
      clearTimeout(t);
      cancelSleep = null;
      resolve();
    };
  });

  const skipNote = () => (unreadableRows.size > 0 ? ` (${unreadableRows.size} ${unreadableRows.size === 1 ? "row" : "rows"} could not be read)` : "");

  const finishStopped = () => {
    sweeping = false;
    if (!closed && !checkMoved()) {
      setStatus(`Stopped: press Save to keep what was collected, or Start to go on.${skipNote()}`);
    }
  };

  const atTop = (s) => s.scrollTop <= 2;
  const atBottom = (s) => s.scrollHeight - s.clientHeight - s.scrollTop <= 2;

  const runSweep = async () => {
    try {
      if (checkMoved()) return;
      let waited = 0;
      while (getRows().length === 0 && waited < ROWS_WAIT_MS && !stopRequested) {
        const chunk = Math.min(STEP_MS, ROWS_WAIT_MS - waited);
        await sleep(chunk);
        if (checkMoved()) return;
        waited += chunk;
      }
      if (stopRequested) return finishStopped();
      if (getRows().length === 0) {
        setStatus("No messages are showing. If Messenger is asking for your PIN to restore chats, enter it there, then press Start again.", false);
        return;
      }

      const s0 = findScroller();
      if (!s0) {
        await sleep(STEP_MS);
        if (stopRequested) return finishStopped();
        await harvest();
        if (stopRequested) return finishStopped();
        const root = document.querySelector('[role="main"]') || document.body;
        if (hasHeaderImg(root)) {
          setStatus(`Done: ${seen.size} messages from the start of the conversation. Press Save.${skipNote()}`);
        } else {
          setStatus(`STALLED, not at the start: ${seen.size} messages collected. Press Save to keep them, or Start to try again.${skipNote()}`);
        }
        return;
      }

      s0.scrollTop = s0.scrollHeight;
      await sleep(STEP_MS);
      if (stopRequested) return finishStopped();
      await harvest();
      if (stopRequested) return finishStopped();
      setStatus(`Going up: ${seen.size} messages…`);

      let stillSteps = 0;
      let noHeaderSteps = 0;
      let upUnchangedSteps = 0;
      let stalled = false;

      while (!stopRequested) {
        const s = findScroller() || s0;
        const before = seen.size;
        const prevTop = s.scrollTop;
        const delta = Math.max(1, Math.round(s.clientHeight * STEP_FRACTION));
        s.scrollTop = Math.max(0, s.scrollTop - delta);
        await sleep(STEP_MS);
        if (stopRequested) return finishStopped();
        const sc = findScroller() || s0;
        await harvest();
        if (stopRequested) return finishStopped();
        setStatus(`Going up: ${seen.size} messages…`);

        const unmoved = sc.scrollTop === prevTop;
        upUnchangedSteps = unmoved ? upUnchangedSteps + 1 : 0;

        if (atTop(sc)) {
          stillSteps = seen.size === before ? stillSteps + 1 : 0;
          if (hasHeaderImg(sc)) {
            noHeaderSteps = 0;
            if (stillSteps >= STILL_STEPS) break;
          } else {
            noHeaderSteps++;
            if (noHeaderSteps >= STALL_STEPS) {
              stalled = true;
              break;
            }
          }
        } else if (unmoved) {
          stillSteps = 0;
          noHeaderSteps++;
          if (upUnchangedSteps >= STILL_STEPS || noHeaderSteps >= STALL_STEPS) {
            stalled = true;
            break;
          }
        } else {
          stillSteps = 0;
          noHeaderSteps = 0;
        }
      }

      await sleep(STEP_MS);
      if (stopRequested) return finishStopped();
      await harvest();
      if (stopRequested) return finishStopped();

      let downStillSteps = 0;
      while (!stopRequested) {
        const s = findScroller() || s0;
        if (atBottom(s)) break;
        const prevTop = s.scrollTop;
        const delta = Math.max(1, Math.round(s.clientHeight * STEP_FRACTION));
        s.scrollTop = Math.min(Math.max(0, s.scrollHeight - s.clientHeight), s.scrollTop + delta);
        await sleep(STEP_MS);
        if (stopRequested) return finishStopped();
        const sc = findScroller() || s0;
        await harvest();
        if (stopRequested) return finishStopped();
        setStatus(`Going down: ${seen.size} messages…`);
        if (atBottom(sc)) break;
        if (sc.scrollTop === prevTop) {
          downStillSteps++;
          if (downStillSteps >= STILL_STEPS) break;
        } else {
          downStillSteps = 0;
        }
      }

      await sleep(STEP_MS);
      if (stopRequested) return finishStopped();
      await harvest();
      if (stopRequested) return finishStopped();

      if (stalled) {
        setStatus(`STALLED, not at the start: ${seen.size} messages collected. Press Save to keep them, or Start to try again.${skipNote()}`);
      } else {
        setStatus(`Done: ${seen.size} messages from the start of the conversation. Press Save.${skipNote()}`);
      }
    } catch (err) {
      if (!closed) {
        const msg = (err && err.message) || String(err);
        setStatus(`ERROR: ${msg}. Press Save to keep what was collected.`);
      }
      throw err;
    } finally {
      sweeping = false;
    }
  };

  btn("Start", () => {
    if (sweeping || closed) return;
    sweeping = true;
    stopRequested = false;
    moved = false;
    const p = runSweep();
    p.catch(() => {}).finally(() => {
      if (sweepPromise === p) sweepPromise = null;
    });
    sweepPromise = p;
  });

  btn("Stop", () => {
    if (!sweeping) return;
    stopRequested = true;
    if (cancelSleep) cancelSleep();
  });

  const handOver = (file, json, files) => new Promise((resolve) => {
    if (closed || !document.documentElement || document.documentElement.dataset?.leketMessengerBridge !== "1") {
      return resolve({ bridged: false, ok: false });
    }
    const id = `${Date.now()}-${Math.random()}`;
    const done = (res) => {
      clearTimeout(timeout);
      cancelHandOver = null;
      window.removeEventListener("message", onAck);
      resolve(res);
    };
    const giveUp = () => done({ bridged: true, ok: false, reason: "timeout" });
    let pendingSeen = false;
    const onAck = (e) => {
      const d = e.data;
      if (e.source === window && d && d.type === "leket:ack" && d.id === id) {
        if (d.pending === true) {
          // the bridge accepted the post and its handoff is under way: wait longer for the final ack
          if (!pendingSeen) {
            pendingSeen = true;
            clearTimeout(timeout);
            timeout = setTimeout(giveUp, ACK_FINAL_MS);
          }
          return;
        }
        done({ bridged: true, ok: Boolean(d.ok), reason: d.reason || null });
      }
    };
    let timeout = setTimeout(giveUp, ACK_WAIT_MS);
    cancelHandOver = () => done({ bridged: true, ok: false, reason: "closed" });
    window.addEventListener("message", onAck);
    window.postMessage({ type: "leket:messenger-export", id, file, json, files }, location.origin);
  });

  let saving = false;
  btn("Save", async () => {
    if (saving || closed) return;
    saving = true;
    try {
      // Guard (thread pin): a tab that has moved to another conversation saves nothing
      if (checkMoved()) return;
      if (sweeping || inFlightHarvest || sweepPromise) {
        stopRequested = true;
        if (cancelSleep) cancelSleep();
        if (inFlightHarvest) {
          try { await inFlightHarvest; } catch {}
          if (closed) return;
        }
        if (sweepPromise) {
          try { await sweepPromise; } catch {}
          if (closed) return;
        }
      }
      if (closed) return;
      if (checkMoved()) return;
      if (seen.size === 0) {
        setStatus("Nothing collected yet: press Start.", false);
        return;
      }

      const entries = [...seen.values()];
      entries.sort((a, b) => {
        const ta = a.msg.time;
        const tb = b.msg.time;
        if (ta !== null && tb !== null) {
          const cmp = Date.parse(ta) - Date.parse(tb) || ta.localeCompare(tb);
          if (cmp !== 0) return cmp;
        } else if (ta !== null) {
          return -1;
        } else if (tb !== null) {
          return 1;
        }
        return String(a.msg.id).localeCompare(String(b.msg.id));
      });

      const mediaNotCaptured = [];
      const messages = entries.map((entry) => {
        const m = entry.msg;
        const resolvedSender = (m.sender_id && senders.get(m.sender_id)) || m.sender || null;
        if (m.kinds.includes("media") && !m.unsent) {
          if (!entry.everSawMedia && m.media.length === 0 && !m.link) {
            mediaNotCaptured.push({ message_id: m.id, kind: "photo", reason: "no media element" });
          } else {
            for (const item of entry.notCaptured.values()) {
              mediaNotCaptured.push({ message_id: m.id, kind: item.kind, reason: item.reason });
            }
          }
        }
        return {
          ...m,
          sender: resolvedSender,
          kinds: [...m.kinds],
          media: m.media.map((med) => ({ ...med })),
        };
      });

      const sendersObj = {};
      for (const [sid, sname] of senders) sendersObj[sid] = sname;

      const rawTitle = cleanTitle(launchTitle);
      const name = nameOf(launchTitle);
      const file = `messenger-${name}-${threadId}.json`;
      let tz = "UTC";
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        tz = "UTC";
      }

      const exp = {
        leket: "messenger",
        version: 1,
        host: location.hostname,
        thread_id: threadId,
        url: location.href,
        title: rawTitle || null,
        saved_at: new Date().toISOString(),
        time_zone: tz,
        count: messages.length,
        senders: sendersObj,
        group_warning: isGroup(),
        media_not_captured: mediaNotCaptured,
        messages,
      };

      const hasBridge = Boolean(document.documentElement && document.documentElement.dataset?.leketMessengerBridge === "1");
      if (hasBridge) {
        const json = JSON.stringify(exp, null, 1);
        const ack = await handOver(file, json, capturedFiles.map((f) => ({ name: f.name, blob: f.blob })));
        if (closed) return;
        // Guard (thread pin, after the handoff): a refused or unanswered handoff on a tab that has since moved neither downloads nor reports
        if (!ack.ok && checkMoved()) return;
        if (ack.ok) {
          const big = totalBytes > LARGE_BYTES
            ? ` This is a large save (${(totalBytes / 1073741824).toFixed(1)} GB): keep this tab and the export tab open until the export tab finishes.`
            : "";
          setStatus(`Handed to the export tab (it opens next to this one): ${messages.length} messages, ${totalPhotos} photos, ${totalVideos} videos.${big}`);
          return;
        }
        // Guard (handoff not-a-thread): the worker refused because this tab left the conversation's page; do not download
        if (ack.reason === "not-a-thread") {
          setStatus("This tab is no longer on the conversation's page. Go back to the conversation and press Save again.");
          return;
        }
        // Guard (handoff too-soon): wait and do not download when the bridge throttles a repeat save
        if (ack.reason === "too-soon") {
          setStatus("Saved less than 10 seconds ago: wait a moment and press Save again.");
          return;
        }
      }
      if (closed) return;

      // Guard (handoff fallback media): move every media entry into media_not_captured and empty each media list
      for (const m of exp.messages) {
        for (const med of m.media) {
          exp.media_not_captured.push({
            message_id: m.id,
            kind: med.kind,
            reason: "saved without the extension, so media files were not kept",
          });
        }
        m.media = [];
      }

      const fallbackJson = JSON.stringify(exp, null, 1);
      const objUrl = URL.createObjectURL(new Blob([fallbackJson], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);

      if (hasBridge) {
        setStatus(`The extension didn't answer (reload this tab and click Leket's button again for photos and videos); saved ${messages.length} messages to Downloads/${file}.`);
      } else {
        setStatus(`Saved ${messages.length} messages to Downloads/${file}.`);
      }
    } finally {
      saving = false;
    }
  });

  btn("Close", () => {
    closed = true;
    stopRequested = true;
    if (cancelSleep) cancelSleep();
    if (cancelHandOver) cancelHandOver();
    panel.remove();
  });

  renderCounts();
  setStatus("Press Start to collect this conversation.", false);
  document.body.appendChild(panel);
})();
