// Leket Messenger collector stub (Unit B); Unit C replaces this with the sweep and harvest.
(() => {
  const ok = (location.hostname === "www.messenger.com" && /^\/(e2ee\/)?t\/\d+\/?$/.test(location.pathname))
    || (location.hostname === "www.facebook.com" && /^\/messages\/(e2ee\/)?t\/\d+\/?$/.test(location.pathname));
  if (!ok || document.getElementById("leket-messenger-panel")) return;
  const panel = document.createElement("div");
  panel.id = "leket-messenger-panel";
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;background:#111;color:#eee;max-width:420px;" +
    "font:13px sans-serif;padding:8px 10px;border-radius:6px;border:1px solid #555";
  const status = document.createElement("div");
  status.textContent = "Leket: collecting is not built yet.";
  panel.appendChild(status);
  document.body.appendChild(panel);
})();
