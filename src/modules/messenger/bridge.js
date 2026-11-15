// Runs in the content-script isolated world on the Messenger tab. The collector (in the
// page's MAIN world) posts its export with its media Blobs here; the export tab then reads
// the JSON in 8 MiB string chunks and each media Blob in 6 MiB base64 slices.
(() => {
  if (window.__leketMessengerBridgeAlive && window.__leketMessengerBridgeAlive()) return;
  window.__leketMessengerBridgeAlive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  document.documentElement.dataset.leketMessengerBridge = "1";
  const CHUNK = 8 * 1024 * 1024;
  const FILE_CHUNK = 6 * 1024 * 1024;
  // Media is large, so only the latest save is kept: an older one goes once the newer one's
  // export tab has opened, never before (a refused handoff leaves the older save readable).
  const held = new Map();
  // One accepted post per 10 s: every post opens a tab, and the page world can post too.
  const MIN_GAP_MS = 10 * 1000;
  let lastPost = -Infinity;
  // the worker's refusal reasons the collector understands; anything else is dropped
  const FORWARDED_REASONS = ["not-a-thread", "too-soon"];
  const GONE = "This save is gone: the Messenger tab was reloaded, or Save was pressed again since. Press Save there again.";

  const bounds = (s) => {
    const out = [0];
    while (out[out.length - 1] < s.length) {
      let at = Math.min(out[out.length - 1] + CHUNK, s.length);
      const c = s.charCodeAt(at - 1);
      if (at < s.length && c >= 0xd800 && c <= 0xdbff) at--;
      out.push(at);
    }
    return out.length > 1 ? out : [0, 0];
  };

  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const toBase64 = (buf) => {
    const bytes = new Uint8Array(buf);
    if (typeof bytes.toBase64 === "function") return bytes.toBase64();
    if (typeof btoa === "function") {
      let bin = "";
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(bin);
    }
    let out = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
    }
    if (i < bytes.length) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      out += B64_CHARS[a >> 2] + B64_CHARS[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64_CHARS[(b & 15) << 2] : "=") + "=";
    }
    return out;
  };

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (e.source !== window || e.origin !== location.origin || !d || d.type !== "leket:messenger-export") return;
    if (typeof d.json !== "string" || typeof d.file !== "string") return;
    if (!window.__leketMessengerBridgeAlive()) return;
    const ack = (ok, reason) => window.postMessage({ type: "leket:ack", id: d.id, ok, ...(reason ? { reason } : {}) }, location.origin);
    const now = Date.now();
    if (now - lastPost < MIN_GAP_MS) return ack(false, "too-soon");
    const priorPost = lastPost;
    lastPost = now;
    // the handoff can take a while (the worker opens a tab): tell the collector it was accepted
    window.postMessage({ type: "leket:ack", id: d.id, pending: true }, location.origin);
    const files = Array.isArray(d.files)
      ? d.files
          .filter((f) => f && typeof f.name === "string" && f.blob && typeof f.blob.size === "number" && typeof f.blob.slice === "function")
          .map((f) => ({ name: f.name, blob: f.blob }))
      : [];
    const key = crypto.randomUUID();
    held.set(key, { file: d.file, json: d.json, files, bounds: bounds(d.json) });
    let ok = false;
    let reason;
    try {
      const r = await chrome.runtime.sendMessage({ type: "leket:ready", key });
      ok = !!(r && r.ok);
      if (!ok && r && FORWARDED_REASONS.includes(r.reason)) reason = r.reason;
    } catch {
      ok = false;
    }
    // a newer save already in place has dropped this one: it is no longer readable
    ok = ok && held.has(key);
    if (ok) {
      // only saves older than this one: a newer post may still be waiting on its own handoff
      for (const k of [...held.keys()]) {
        if (k === key) break;
        held.delete(k);
      }
    } else {
      held.delete(key);
      // only a handoff that opened a tab counts toward the throttle (unless a newer post took the slot since)
      if (lastPost === now) lastPost = priorPost;
    }
    ack(ok, ok ? undefined : reason);
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    const x = held.get(msg.key);
    if (msg.type === "leket:chunk") {
      if (!x) return reply({ error: GONE, gone: true });
      const total = x.bounds.length - 1;
      if (!(Number.isInteger(msg.index) && msg.index >= 0 && msg.index < total)) return reply({ error: `no piece ${msg.index}` });
      reply({ file: x.file, files: x.files.length, total, chunk: x.json.slice(x.bounds[msg.index], x.bounds[msg.index + 1]) });
    } else if (msg.type === "leket:file") {
      if (!x) return reply({ error: GONE, gone: true });
      const entry = Number.isInteger(msg.index) && msg.index >= 0 ? x.files[msg.index] : undefined;
      if (!entry) return reply({ error: `no file ${msg.index}` });
      const size = entry.blob.size;
      if (!(Number.isSafeInteger(msg.offset) && msg.offset >= 0 && msg.offset < Math.max(size, 1))) {
        return reply({ error: `no offset ${msg.offset} in file ${msg.index} (${size} bytes)` });
      }
      const offset = msg.offset;
      entry.blob.slice(offset, Math.min(offset + FILE_CHUNK, size)).arrayBuffer().then(
        (buf) => reply({ name: entry.name, size, data: toBase64(buf) }),
        (err) => reply({ error: (err && err.message) || String(err) }),
      );
      return true;
    } else if (msg.type === "leket:release") {
      held.delete(msg.key);
      reply({});
    }
  });
})();
