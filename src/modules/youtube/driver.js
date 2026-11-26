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

  // the overlay, one line per phase; a re-run replaces its lines. White on #1e1f22
  // reads on YouTube's dark and light themes alike
  let panel = document.getElementById("leket-youtube-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "leket-youtube-panel";
    panel.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;max-width:360px;"
      + "padding:8px 12px;border-radius:8px;background:#1e1f22;color:#fff;"
      + "font:13px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.5)";
    document.documentElement.appendChild(panel);
  } else {
    panel.replaceChildren();
  }
  const say = (text) => {
    const p = document.createElement("div");
    p.textContent = text;
    panel.appendChild(p);
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
  const headerCount = document.querySelector("ytd-comments-header-renderer #count");
  const metadata = {
    title,
    channel: channelEl ? clean(channelEl.textContent) : "",
    url: videoId ? "https://www.youtube.com/watch?v=" + videoId : location.href,
    video_id: videoId,
    total_comments_reported: headerCount ? clean(headerCount.textContent) : "",
    transcript_note: "",
    comments_note: "",
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

  say("Opening the transcript…");
  let transcript = readTranscript();
  if (transcript.length === 0) {
    const expand = document.querySelector("#description-inline-expander #expand");
    if (expand) expand.click();
    const buttonEnd = Date.now() + transcriptWaitMs;
    let button = document.querySelector("ytd-video-description-transcript-section-renderer button");
    while (!button && Date.now() < buttonEnd) {
      await sleep(stepMs / 2);
      button = document.querySelector("ytd-video-description-transcript-section-renderer button");
    }
    if (!button) {
      // the description offers no transcript section: some videos have none at all
      metadata.transcript_note = "YouTube shows no transcript for this video.";
    } else {
      button.click();
      const segEnd = Date.now() + transcriptWaitMs;
      while (Date.now() < segEnd && readTranscript().length === 0) await sleep(stepMs / 2);
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
  }

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
  const commentsBox = document.querySelector("ytd-comments");
  if (commentsBox) {
    try { commentsBox.scrollIntoView(); } catch { /* nowhere to scroll */ }
    const line = say("Loading comments: " + threadCount() + " so far…");
    let threads = threadCount();
    let stalls = 0;
    while (Date.now() < deadline) {
      const cont = topContinuation();
      if (!cont) break;
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

  // ---- replies: rounds of clicking every thread's #more-replies (each once — the
  // clicked buttons are tracked in a WeakSet) and every replies-continuation button,
  // visible or not, waiting half a step after each. A round that found nothing may
  // just be ahead of the DOM, so it waits a beat before counting as empty; stallSteps
  // empty rounds in a row, or maxMs, end the phase ----
  say("Opening replies…");
  const clicked = new WeakSet();
  let emptyRounds = 0;
  while (Date.now() < deadline && emptyRounds < stallSteps) {
    const toClick = [];
    for (const b of document.querySelectorAll("ytd-comment-replies-renderer #more-replies button")) {
      if (!clicked.has(b)) toClick.push(b);
    }
    for (const b of document.querySelectorAll("ytd-comment-replies-renderer ytd-continuation-item-renderer button")) {
      toClick.push(b);
    }
    const before = replyCount();
    for (const b of toClick) {
      try { b.scrollIntoView(); } catch { /* nowhere to scroll */ }
      b.click();
      clicked.add(b);
      await sleep(stepMs / 2);
    }
    let after = replyCount();
    if (toClick.length === 0) {
      await sleep(stepMs / 2);
      after = replyCount();
    }
    if (toClick.length > 0 || after > before) emptyRounds = 0; else emptyRounds++;
  }

  // ---- the threads, read into the shape buildExtract takes: the top comment is the
  // thread's first ytd-comment-view-model outside any replies renderer; a reply's
  // lc= id (on its time element's link) is unique, so replies re-rendered as a thread
  // loads more are deduped on it, falling back to author+text ----
  const readComment = (el) => ({
    author: readText(el, "#author-text"),
    likes: readText(el, "#vote-count-middle") || "0",
    time: readText(el, "#published-time-text"),
    text: readText(el, "#content-text"),
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

  const replyTotal = comments.reduce((n, c) => n + c.replies.length, 0);
  say("Done: " + comments.length + " comments, " + replyTotal + " replies, " + transcript.length
    + " transcript lines. Leket is saving the files.");
  return { metadata, transcript, comments, stats: { threads: comments.length, replies: replyTotal } };
}
