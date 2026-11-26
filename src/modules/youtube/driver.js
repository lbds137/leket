// The YouTube driver: one function that runs IN the watch tab, injected there by the
// module's page (src/modules/youtube/page.js) through
// chrome.scripting.executeScript({ func: driveYouTube }) — the tab is where the
// scroll-driven loading has to happen. Chrome serializes the func with toString(), so
// the function must stand entirely on its own: no imports, no references to anything
// outside its own body (test/youtube-driver.test.js pins that). What it reads follows
// the 11-25 probes (backlog TASK-29 notes): the transcript panel's host element varies
// by A/B, so the SEGMENTS are selected, never the panel id; the top-level continuation
// lives inside ytd-comments but never inside a ytd-comment-replies-renderer; labels are
// localized, so nothing is ever selected or matched by its text; and like counts can
// carry bidi marks, which are stripped so the saved likes parse. A missing piece is
// never a throw: it comes back as an empty list plus its note, and the page is left as
// the driver found it apart from its own overlay and the clicks YouTube itself answers.
export async function driveYouTube(opts) {
  opts = opts && typeof opts === "object" ? opts : {};
  const stepMs = opts.stepMs || 1200;
  const stallSteps = opts.stallSteps || 8;
  const transcriptWaitMs = opts.transcriptWaitMs || 15000;
  const maxMs = opts.maxMs || 15 * 60 * 1000;
  const deadline = Date.now() + maxMs;

  // one reader for every text on the page: bidi marks off (like counts carry them),
  // whitespace collapsed, trimmed
  const bidi = /[\u202a-\u202e\u200e\u200f\u2066-\u2069]/g;
  const clean = (s) => (s == null ? "" : String(s)).replace(bidi, "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const readText = (root, sel) => {
    const el = root ? root.querySelector(sel) : null;
    return el ? clean(el.textContent) : "";
  };
  // a comment's own text keeps its line breaks (the CLI's yt-dlp path keeps them too):
  // a newline in a text node or a <br> is a break (which one YouTube uses is unprobed);
  // each line is cleaned, blank lines at either end dropped
  const readBlock = (root, sel) => {
    const el = root ? root.querySelector(sel) : null;
    if (!el) return "";
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) parts.push(node.data);
      else if (node.nodeName === "BR") parts.push("\n");
      else for (const child of node.childNodes) walk(child);
    };
    walk(el);
    return parts.join("").replace(bidi, "").replace(/\r\n?/g, "\n").split("\n")
      .map((l) => l.replace(/[^\S\n]+/g, " ").trim()).join("\n").replace(/^\n+|\n+$/g, "");
  };

  // the overlay, one line per phase; a re-run replaces its lines. White on #1e1f22
  // reads on YouTube's dark and light themes alike
  let panel = document.getElementById("leket-youtube-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "leket-youtube-panel";
    // clicks pass through it (it sits over YouTube's own top-right controls), and a
    // screen reader hears each phase
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;max-width:360px;"
      + "padding:8px 12px;border-radius:8px;background:#1e1f22;color:#fff;pointer-events:none;"
      + "font:13px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.5)";
    document.documentElement.appendChild(panel);
  } else {
    // an earlier run's panel, possibly mid-fade: this run owns it now
    panel.replaceChildren();
    panel.style.transition = "";
    panel.style.opacity = "";
  }
  // this run's token: a newer run ("Save again") overwrites it, and from then on the tab
  // and its panel are that run's. The token lives in the extension's isolated world,
  // which every injection into this page shares
  const runToken = String(Math.random());
  window.__leketYouTubeRun = runToken;
  const owned = () => window.__leketYouTubeRun === runToken;
  // a run a newer one superseded keeps narrating into a line nobody sees
  const say = (text) => {
    const p = document.createElement("div");
    p.textContent = text;
    if (owned()) panel.appendChild(p);
    return p;
  };

  // metadata, read live from the page: ytInitialPlayerResponse is stale after an
  // in-site navigation, so the address bar and the live DOM are the sources
  let videoId = "";
  try {
    videoId = new URL(location.href).searchParams.get("v") || "";
  } catch { /* no id: the url falls back to the address bar */ }
  const h1 = document.querySelector("ytd-watch-metadata h1");
  let title = h1 ? clean(h1.textContent) : "";
  if (!title) title = clean(document.title.replace(/ - YouTube$/, ""));
  const channelEl = document.querySelector("ytd-watch-metadata ytd-channel-name a");
  // the header count mounts with the comment section, often only once it is scrolled
  // to: read again after the comments load, keeping the first non-empty reading
  const readHeaderCount = () => readText(document, "ytd-comments-header-renderer #count");
  const metadata = {
    title,
    channel: channelEl ? clean(channelEl.textContent) : "",
    url: videoId ? "https://www.youtube.com/watch?v=" + videoId : location.href,
    video_id: videoId,
    total_comments_reported: readHeaderCount(),
    transcript_note: "",
    comments_note: "",
  };

  // why the run must stop early, or "": the time budget is spent; YouTube navigated
  // in-site to another video (autoplay, a recommendation clicked), so what loads now
  // belongs to a different video than the title above; or a newer run took over this
  // tab (its token replaced runToken, above)
  let aborted = "";
  const stopReason = () => {
    if (!owned()) return "superseded";
    let v = "";
    try { v = new URL(location.href).searchParams.get("v") || ""; } catch { /* keep "" */ }
    if (v !== videoId) return "video-changed";
    if (Date.now() >= deadline) return "time";
    return "";
  };
  const stopped = () => {
    const why = stopReason();
    if (why && !aborted) aborted = why;
    return !!why;
  };

  // ---- the transcript panel: whichever renderer the A/B served. In a
  // transcript-segment-view-model the stamp is .ytwTranscriptSegmentViewModelTimestamp
  // and the text span.ytAttributedStringHost; the a11y label beside the stamp is a
  // localized duration and is never read. In the older ytd-transcript-segment-renderer
  // it's .segment-timestamp and .segment-text. Chapter headings interleave in the panel
  // and match neither selector ----
  const readTranscript = () => {
    const rows = [];
    const current = document.querySelectorAll("transcript-segment-view-model");
    const segs = current.length ? current : document.querySelectorAll("ytd-transcript-segment-renderer");
    for (const seg of segs) {
      const stamp = seg.querySelector(current.length ? ".ytwTranscriptSegmentViewModelTimestamp" : ".segment-timestamp");
      const textEl = seg.querySelector(current.length ? "span.ytAttributedStringHost" : ".segment-text");
      const text = textEl ? clean(textEl.textContent) : "";
      if (text) rows.push({ time: stamp ? clean(stamp.textContent) : "", text });
    }
    return rows;
  };

  const transcriptLine = say("Opening the transcript…");
  let transcript = readTranscript();
  if (transcript.length === 0) {
    const expand = document.querySelector("#description-inline-expander #expand");
    if (expand) expand.click();
    const buttonEnd = Math.min(deadline, Date.now() + transcriptWaitMs);
    let button = document.querySelector("ytd-video-description-transcript-section-renderer button");
    while (!button && Date.now() < buttonEnd && !stopped()) {
      await sleep(stepMs / 2);
      button = document.querySelector("ytd-video-description-transcript-section-renderer button");
    }
    if (!button) {
      // the description offers no transcript section: some videos have none at all
      metadata.transcript_note = "YouTube shows no transcript for this video.";
    } else {
      button.click();
      const segEnd = Math.min(deadline, Date.now() + transcriptWaitMs);
      while (Date.now() < segEnd && readTranscript().length === 0 && !stopped()) await sleep(stepMs / 2);
      transcript = readTranscript();
      if (transcript.length === 0) {
        metadata.transcript_note = "The transcript panel never showed its segments within "
          + Math.round(transcriptWaitMs / 1000) + "s.";
      }
    }
  }
  // the panel shows the language YouTube chose for this viewer and has no picker
  if (transcript.length > 0) {
    metadata.transcript_note = "As YouTube's transcript panel showed it; the language is YouTube's "
      + "choice for this viewer (interface language: " + (document.documentElement.lang || "unknown") + ").";
  } else if (aborted) {
    // a stop cut the waits short: the transcript was never read, not found missing
    metadata.transcript_note = "Not read: the save stopped before the transcript loaded.";
  }
  transcriptLine.textContent = transcript.length > 0
    ? "Transcript: " + transcript.length + " lines."
    : aborted ? "Transcript: not read (the save stopped)."
      : "Transcript: none. " + metadata.transcript_note;

  // ---- comments: the top-level continuation loads more threads while it is on
  // screen; a continuation inside a ytd-comment-replies-renderer belongs to that
  // thread's replies, not to the top-level list ----
  const threadCount = () => document.querySelectorAll("ytd-comments ytd-comment-thread-renderer").length;
  const replyCount = () => document.querySelectorAll("ytd-comment-replies-renderer ytd-comment-view-model").length;
  const topContinuation = () => {
    for (const el of document.querySelectorAll("ytd-comments ytd-continuation-item-renderer")) {
      if (!el.closest("ytd-comment-replies-renderer")) return el;
    }
    return null;
  };
  // the section may mount late, and its first batch renders only once it is near the
  // screen: wait (within the run's budget) for a thread or the continuation, scrolling
  // the section into view whenever it appears, before deciding there's nothing to load
  let commentsBox = null;
  let scrolledBox = null;
  const firstEnd = Math.min(deadline, Date.now() + transcriptWaitMs);
  for (;;) {
    commentsBox = document.querySelector("ytd-comments");
    if (commentsBox && commentsBox !== scrolledBox) {
      try { commentsBox.scrollIntoView(); } catch { /* nowhere to scroll */ }
      scrolledBox = commentsBox;
    }
    if (threadCount() > 0 || topContinuation() || Date.now() >= firstEnd || stopped()) break;
    await sleep(stepMs / 2);
  }
  // after a stop, the phases below are skipped: their lines would narrate work that
  // never ran
  if (commentsBox && !aborted) {
    const line = say("Loading comments: " + threadCount() + " so far…");
    let threads = threadCount();
    let stalls = 0;
    // YouTube may drop the old continuation a moment before the next batch brings its
    // replacement: the list is only finished once it has stayed gone a few steps
    let goneSteps = 0;
    while (!stopped()) {
      const cont = topContinuation();
      if (!cont) {
        if (++goneSteps >= 3) break;
        await sleep(stepMs);
        const now = threadCount();
        if (now > threads) { threads = now; line.textContent = "Loading comments: " + threads + " so far…"; }
        continue;
      }
      goneSteps = 0;
      if (stalls >= stallSteps) {
        metadata.comments_note = "YouTube stopped loading more comments after " + threads + " threads.";
        break;
      }
      try { cont.scrollIntoView(); } catch { /* nowhere to scroll */ }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(stepMs);
      const now = threadCount();
      if (now > threads) { threads = now; stalls = 0; } else stalls++;
      line.textContent = "Loading comments: " + threads + " so far…";
    }
  }

  // ---- replies: rounds of clicking every thread's #more-replies (once each) and every
  // replies-continuation button (up to 3 times each: a click can land before the button
  // is ready, and YouTube may or may not reuse one element per "more replies" page:
  // unprobed, so TASK-29's notes carry it for the live check), visible or not, half a
  // step apart. A #more-replies whose thread still shows no reply after its click gets
  // one more try, for a click that landed before YouTube wired the button. Clicks are
  // counted per element in a WeakMap, so a button that never answers runs out of
  // tries. A round is progress only when replies grew or a button never clicked before
  // turned up; stallSteps rounds without progress, the time budget, or a stop reason
  // end the phase ----
  if (!aborted) say("Opening replies…");
  const tries = new WeakMap();
  const threadHasReplies = (b) => {
    const box = b.closest("ytd-comment-replies-renderer");
    return !!(box && box.querySelector("ytd-comment-view-model"));
  };
  let emptyRounds = 0;
  while (!stopped() && emptyRounds < stallSteps) {
    const toClick = new Set();
    for (const b of document.querySelectorAll("ytd-comment-replies-renderer #more-replies button")) {
      const n = tries.get(b) || 0;
      if (n === 0 || (n === 1 && !threadHasReplies(b))) toClick.add(b);
    }
    for (const b of document.querySelectorAll("ytd-comment-replies-renderer ytd-continuation-item-renderer button")) {
      if ((tries.get(b) || 0) < 3) toClick.add(b);
    }
    let fresh = 0;
    const before = replyCount();
    for (const b of toClick) {
      if (stopped()) break;
      if (!b.isConnected || b.disabled) continue;
      if (!tries.has(b)) fresh++;
      tries.set(b, (tries.get(b) || 0) + 1);
      try { b.scrollIntoView(); } catch { /* nowhere to scroll */ }
      b.click();
      await sleep(stepMs / 2);
    }
    if (fresh === 0) await sleep(stepMs / 2);
    if (fresh > 0 || replyCount() > before) emptyRounds = 0; else emptyRounds++;
  }

  // ---- the threads, read into the shape buildExtract takes: the top comment is the
  // thread's first ytd-comment-view-model outside any replies renderer; a reply's
  // lc= id (on its time element's link) is unique, so replies re-rendered as a thread
  // loads more are deduped on it, falling back to author+text ----
  const readComment = (el) => ({
    author: readText(el, "#author-text"),
    likes: readText(el, "#vote-count-middle") || "0",
    time: readText(el, "#published-time-text"),
    text: readBlock(el, "#content-text"),
  });
  const comments = [];
  for (const thread of document.querySelectorAll("ytd-comments ytd-comment-thread-renderer")) {
    let top = null;
    for (const vm of thread.querySelectorAll("ytd-comment-view-model")) {
      if (!vm.closest("ytd-comment-replies-renderer")) { top = vm; break; }
    }
    if (!top) continue;
    const head = readComment(top);
    const more = thread.querySelector("ytd-comment-replies-renderer #more-replies button");
    const replies = [];
    const seen = new Set();
    for (const vm of thread.querySelectorAll("ytd-comment-replies-renderer ytd-comment-view-model")) {
      const reply = readComment(vm);
      let id = "";
      const link = vm.querySelector("#published-time-text a");
      if (link) {
        const m = /(?:^|[?&])lc=([^&#]+)/.exec(link.getAttribute("href") || "");
        if (m) id = m[1];
      }
      const key = id || (reply.author + "\n" + reply.text);
      if (seen.has(key)) continue;
      seen.add(key);
      replies.push(reply);
    }
    comments.push({
      author: head.author,
      likes: head.likes,
      time: head.time,
      pinned: !!thread.querySelector("ytw-pinned-comment-badge-renderer, ytd-pinned-comment-badge-renderer"),
      reply_count_label: more ? (clean(more.textContent) || null) : null,
      text: head.text,
      replies,
    });
  }

  if (!metadata.total_comments_reported) metadata.total_comments_reported = readHeaderCount();
  if (aborted === "time") {
    // a save cut short still saves what it read, and says so
    const left = document.querySelectorAll("ytd-comment-replies-renderer ytd-continuation-item-renderer button").length;
    metadata.comments_note = (metadata.comments_note ? metadata.comments_note + " " : "")
      + "Leket stopped at its " + Math.round(maxMs / 60000) + "-minute limit after " + comments.length
      + " threads" + (topContinuation() ? ", with more comments still to load" : "")
      + (left ? ", " + left + " reply button(s) left unopened" : "") + ".";
  }
  if (comments.length === 0 && !metadata.comments_note) {
    // the driver can't tell an empty or switched-off section from one that never loaded
    metadata.comments_note = commentsBox
      ? "No comments were collected: the section showed none before the driver moved on."
      : "No comments were collected: the page never showed a comment section (comments may be turned off).";
  }
  const replyTotal = comments.reduce((n, c) => n + c.replies.length, 0);
  // the overlay's last line stays long enough to read, then the panel fades out — unless
  // a newer run has taken the panel over by then. The fade is skipped for a reader who
  // asked for reduced motion
  const fadeOut = () => {
    setTimeout(() => {
      if (!owned() || !panel.isConnected) return;
      let still = false;
      try { still = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* fade */ }
      if (still) { panel.remove(); return; }
      panel.style.transition = "opacity .6s";
      panel.style.opacity = "0";
      setTimeout(() => { if (owned()) panel.remove(); }, 700);
    }, 6000);
  };
  if (aborted === "superseded") {
    // a newer run owns this tab and its panel: this run writes nothing more there, and
    // the page saves nothing from it
    return { metadata, transcript: [], comments: [], stats: { threads: 0, replies: 0 }, aborted };
  }
  if (aborted === "video-changed") {
    // what was read belongs to another video: the page saves nothing from this run
    say("Stopped: the tab moved to another video.");
    fadeOut();
    return { metadata, transcript: [], comments: [], stats: { threads: 0, replies: 0 }, aborted };
  }
  say("Done: " + comments.length + " comments, " + replyTotal + " replies, " + transcript.length
    + " transcript lines. Leket is saving the files.");
  fadeOut();
  return { metadata, transcript, comments, stats: { threads: comments.length, replies: replyTotal }, aborted };
}
