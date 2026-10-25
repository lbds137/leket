// Runs in the content-script world on the Discord tab. The collector (in the page's world)
// posts its export here; the export tab then reads it back in pieces, since one extension
// message holds at most 64 MiB and a long channel's JSON can be near that.
(() => {
  if (window.__discordToolsBridge) return;
  window.__discordToolsBridge = true;
  // a mark both worlds can see, so the collector knows to hand its export over
  document.documentElement.dataset.discordToolsBridge = "1";
  const CHUNK = 8 * 1024 * 1024;
  const held = new Map();

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || e.origin !== location.origin || !d || d.type !== "discord-tools:export") return;
    if (typeof d.json !== "string" || typeof d.file !== "string") return;
    // one export at a time: a second Save replaces the first
    held.clear();
    const key = crypto.randomUUID();
    held.set(key, { file: d.file, json: d.json, attachments: !!d.attachments });
    chrome.runtime.sendMessage({ type: "discord-tools:ready", key });
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    const x = held.get(msg.key);
    if (msg.type === "discord-tools:chunk") {
      if (!x) return reply({ error: "This export is gone: the Discord tab was reloaded or saved again. Press Save there again." });
      const at = msg.index * CHUNK;
      reply({ file: x.file, attachments: x.attachments, total: Math.ceil(x.json.length / CHUNK) || 1, chunk: x.json.slice(at, at + CHUNK) });
    } else if (msg.type === "discord-tools:release") {
      held.delete(msg.key);
      reply({});
    }
  });
})();
