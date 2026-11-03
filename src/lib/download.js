// One download through Chrome's downloads API, followed until it ends. Kept apart from the
// export page so the tests can run it under node with a stand-in for chrome.downloads.

export const NO_WORD_MS = 15 * 60 * 1000;

// Starts the download and waits until THIS one (matched by the id the call returns, never
// by name) is done: true once it completes, false if it is interrupted or refused, null
// after `timeout` ms with no word (it may still be downloading).
export function trackDownload(downloads, { url, filename }, { timeout = NO_WORD_MS } = {}) {
  return new Promise((resolve) => {
    let id = null;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      downloads.onChanged.removeListener(onChanged);
      resolve(v);
    };
    const onChanged = (delta) => {
      if (id == null || delta.id !== id) return;
      const state = delta.state && delta.state.current;
      if (state === "complete" || state === "interrupted") done(state === "complete");
    };
    const timer = setTimeout(() => done(null), timeout);
    downloads.onChanged.addListener(onChanged);
    downloads.download({ url, filename }).then(async (mid) => {
      id = mid;
      // a small part can finish before the promise resolved, and its `complete` event
      // was ignored above (no id yet): settle from the download record instead
      try {
        const [item] = await downloads.search({ id });
        const state = item && item.state;
        if (state === "complete" || state === "interrupted") done(state === "complete");
      } catch { /* the events will tell */ }
    }, () => done(false));
  });
}
