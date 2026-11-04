// One download through Chrome's downloads API, followed until it ends. Kept apart from the
// export page so the tests can run it under node with a stand-in for chrome.downloads.

export const NO_WORD_MS = 15 * 60 * 1000;

// Starts the download and waits until THIS one (matched by the id the call returns, never
// by name) is done: true once it completes, false if it is interrupted or refused, null
// after `timeout` ms with no word (it may still be downloading). onStart(id) gets the id
// the moment Chrome gives it, so a later click can ask about this download. With onLate,
// a download still going at the timeout stays watched: onLate(ok, id) gets how it ended.
export function trackDownload(downloads, { url, filename }, { timeout = NO_WORD_MS, onStart = () => {}, onLate = null } = {}) {
  return new Promise((resolve) => {
    let id = null;
    let settled = false;
    let watching = true;
    const unwatch = () => {
      if (!watching) return;
      watching = false;
      downloads.onChanged.removeListener(onChanged);
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (v !== null || !onLate) unwatch();
      resolve(v);
    };
    // this download's end: settles the promise, or after the timeout goes to onLate
    const ended = (ok) => {
      if (!settled) return done(ok);
      if (!watching) return;
      unwatch();
      onLate(ok, id);
    };
    const onChanged = (delta) => {
      if (id == null || delta.id !== id) return;
      const state = delta.state && delta.state.current;
      if (state === "complete" || state === "interrupted") ended(state === "complete");
    };
    const timer = setTimeout(() => done(null), timeout);
    downloads.onChanged.addListener(onChanged);
    downloads.download({ url, filename }).then(async (mid) => {
      id = mid;
      onStart(mid);
      // a small part can finish before the promise resolved, and its `complete` event
      // was ignored above (no id yet): settle from the download record instead
      try {
        const [item] = await downloads.search({ id });
        const state = item && item.state;
        if (state === "complete" || state === "interrupted") ended(state === "complete");
      } catch { /* the events will tell */ }
    }, () => ended(false));
  });
}

// where a download started earlier stands now: "in_progress", "complete", "interrupted",
// null when Chrome answered and no longer lists it (erased from the list — a click may
// download it again), or "unavailable" when Chrome couldn't be asked at all (the search
// failed — nothing is known about the download, so a click says so instead of guessing)
export async function downloadState(downloads, id) {
  try {
    const [item] = await downloads.search({ id });
    return (item && item.state) || null;
  } catch {
    return "unavailable";
  }
}
