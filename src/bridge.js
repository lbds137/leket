// Runs in the content-script world on the Discord tab. The collector (in the page's world)
// posts its export here; the export tab then reads it back in pieces, since one extension
// message holds at most 64 MiB and a long channel's JSON can be near that.
(() => {
  // a bridge left behind by an extension reload can no longer reach the extension: then a
  // new one is installed beside it
  if (window.__discordToolsBridgeAlive && window.__discordToolsBridgeAlive()) return;
  window.__discordToolsBridgeAlive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  // a mark both worlds can see, so the collector knows to hand its export over
  document.documentElement.dataset.discordToolsBridge = "1";
  const CHUNK = 8 * 1024 * 1024;
  // a few saves are kept until their export tab is done with them (it may be reloaded)
  const KEEP = 3;
  const held = new Map();

  // piece boundaries, never between the two halves of a surrogate pair (an emoji), which
  // the messaging's UTF-8 would turn into two replacement characters
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

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (e.source !== window || e.origin !== location.origin || !d || d.type !== "discord-tools:export") return;
    if (typeof d.json !== "string" || typeof d.file !== "string") return;
    const ack = (ok) => window.postMessage({ type: "discord-tools:ack", id: d.id, ok }, location.origin);
    const key = crypto.randomUUID();
    held.set(key, { file: d.file, json: d.json, attachments: !!d.attachments, bounds: bounds(d.json) });
    while (held.size > KEEP) held.delete(held.keys().next().value);
    try {
      const r = await chrome.runtime.sendMessage({ type: "discord-tools:ready", key });
      ack(!!(r && r.ok));
    } catch {
      held.delete(key);
      ack(false);
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    const x = held.get(msg.key);
    if (msg.type === "discord-tools:chunk") {
      if (!x) return reply({ error: "This save is gone: the Discord tab was reloaded since. Press Save there again." });
      const total = x.bounds.length - 1;
      if (!(msg.index >= 0 && msg.index < total)) return reply({ error: `no piece ${msg.index}` });
      reply({ file: x.file, attachments: x.attachments, total, chunk: x.json.slice(x.bounds[msg.index], x.bounds[msg.index + 1]) });
    } else if (msg.type === "discord-tools:release") {
      held.delete(msg.key);
      reply({});
    }
  });
})();
