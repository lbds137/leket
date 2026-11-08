// The reddit post → Markdown converter, ported part for part from the dev-docs CLI
// bin/reddit-export (its post_of, media_post, images, when, quote, comments, render —
// the python file is the spec). Pure by design: no chrome APIs, no fetch, no DOM —
// the extension's fetch half lives in prepare.js and the CLI's image-folder download
// (save_images) and its network half stay CLI-only. Images render as remote links; the
// saved/folderRel arguments are the follow-on images PR's surface, unused by the
// extension for now.
//
// Where the port deliberately differs from the python:
// - null fields fall back to the placeholder (u/[deleted], r/?, (untitled)) where
//   python's .get(key, default) would print None, and null children/body/replies can't
//   crash it; ?? guards keep 0 falsy-safe (score: 0 renders "0 points").
// - "more" nodes: count-0 cuts render a thread-continues link, and every more line
//   links its own branch (comments()); render() adds the not-fetched note (notFetched()).
// - bodies and the title go through safeBody/escapeLine: a bare `<` outside code becomes
//   `&lt;`, unclosed fences are closed. That includes a `<` in an angle-bracket link
//   destination (`[x](<url>)`), which then shows as text: rare in reddit, accepted.
// - remote image links are wrapped in `<...>`.

const MIME_EXT = { "image/png": ".png", "image/jpg": ".jpg", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

export function when(ts) {
  const ms = Number.isFinite(Number(ts)) ? Number(ts) * 1000 : 0;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function quote(text, depth) {
  text = String(text ?? "");
  const prefix = "> ".repeat(depth);
  return text.split("\n").map((line) => (prefix + line).trimEnd()).join("\n");
}

// The post that holds the media: a crosspost keeps its gallery and image in its parent.
export function mediaPost(p) {
  const parents = p.crosspost_parent_list || [];
  if (parents.length && parents[0] && typeof parents[0] === "object" && !Array.isArray(parents[0])
      && !p.gallery_data && p.post_hint !== "image") {
    return parents[0];
  }
  return p;
}

function pathIsImage(u) {
  try {
    const path = new URL(u).pathname.toLowerCase();
    return IMAGE_EXT.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

// The post's images in display order, numbered as the gallery numbers them: arrays of
// [n, url, caption, extension, skip], where skip says why an item has no image (url null).
export function images(p) {
  p = mediaPost(p);
  const out = [];
  if (p.is_gallery) {
    const meta = p.media_metadata || {};
    const items = (p.gallery_data || {}).items || [];
    for (let i = 0; i < items.length; i++) {
      const n = i + 1;
      const item = items[i] || {};
      const m = (item.media_id && meta[item.media_id]) || {};
      const s = m.s || {};
      const u = s.u || s.gif;
      const caption = typeof item.caption === "string" || typeof item.caption === "number" ? String(item.caption) : "";
      if ((m.status ?? "valid") !== "valid") {
        out.push([n, null, caption, "", `status ${m.status}`]);
      } else if (!u) {
        out.push([n, null, caption, "", s.mp4 || m.e === "RedditVideo" ? "a video or animation (mp4 only)" : "no image URL"]);
      } else {
        out.push([n, u, caption, MIME_EXT[m.m] || "", ""]);
      }
    }
  } else {
    const u = p.url_overridden_by_dest || p.url || "";
    if (u && (p.post_hint === "image" || pathIsImage(u))) out.push([1, u, "", "", ""]);
  }
  return out;
}

function t1Parent(d) {
  if (typeof d.parent_id !== "string" || !d.parent_id.startsWith("t1_")) return null;
  const id = d.parent_id.slice(3);
  return /^[a-z0-9]+$/i.test(id) ? id : null;
}

function encodeAngle(u) {
  return String(u).replace(/</g, "%3C").replace(/>/g, "%3E").replace(/ /g, "%20");
}

function escapeLine(line) {
  if (!line.includes("<")) return line;
  const parts = line.split(/(`+)/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      out += parts[i].replace(/</g, "&lt;");
    } else {
      const run = parts[i];
      let close = -1;
      for (let j = i + 2; j < parts.length; j += 2) {
        if (parts[j].length === run.length) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        for (let k = i; k <= close; k++) out += parts[k];
        i = close;
      } else {
        out += run;
      }
    }
  }
  return out;
}

// A fence may sit behind blockquote and list markers ("> ```", "- ```", "1. ```"), and a
// list item's closer is indented to its content ("  ```"), so both regexes allow that
// container prefix. A backtick fence's info string can't hold a backtick (CommonMark).
// A closer may sit as deep as its opener's content ("10. ```" closes at 4 spaces) plus
// the usual 3, so FENCE_CLOSE takes any indent and safeBody checks the width.
const MARKERS = String.raw`(?: {0,3}(?:>[ ]?|[-*+][ ]+|\d{1,9}[.)][ ]+))*`;
const FENCE_OPEN = new RegExp(`^(${MARKERS}[ ]{0,3})` + "(`{3,}|~{3,})(.*)$");
const FENCE_CLOSE = new RegExp(`^(${MARKERS}[ ]*)` + "(`{3,}|~{3,})\\s*$");

// the container markers a prefix carries, spaces dropped: "> " → ">", "- " → "-", "  " → ""
const markersOf = (prefix) => prefix.replace(/\s/g, "");

export function safeBody(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let fenceChar = "";
  let fenceLen = 0;
  let fencePrefix = "";
  // a 4-space (or tab) line is indented code only where a paragraph can't be continuing:
  // at the start, after a blank line, or after another indented-code line. Elsewhere it
  // is a list or paragraph continuation, rendered inline, so its < is escaped as usual.
  let paragraphOpen = false;
  let inIndentedCode = false;
  for (const line of lines) {
    if (fenceLen) {
      // a closer belongs to the opener's own container: inside a top-level fence, "- ```"
      // or "> ```" is code, not a closer (and a blockquoted fence needs its ">")
      const m = line.match(FENCE_CLOSE);
      if (m && m[2][0] === fenceChar && m[2].length >= fenceLen
          && markersOf(m[1]) === markersOf(fencePrefix) && m[1].length <= fencePrefix.length + 3) {
        fenceChar = "";
        fenceLen = 0;
      }
      out.push(line);
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
      fenceChar = open[2][0];
      fenceLen = open[2].length;
      // the closer, if one must be added, stays inside the same blockquote (a bare one
      // would open a new top-level fence there); list markers become their width in spaces
      fencePrefix = open[1].replace(/[^>]/g, " ");
      paragraphOpen = false;
      inIndentedCode = false;
      out.push(line);
      continue;
    }
    const blank = /^\s*$/.test(line);
    if (/^(?: {4,}|\t)/.test(line) && !blank && (inIndentedCode || !paragraphOpen)) {
      inIndentedCode = true;
      out.push(line);
      continue;
    }
    if (!blank) inIndentedCode = false;
    paragraphOpen = !blank;
    out.push(escapeLine(line));
  }
  if (fenceLen) out.push(fencePrefix + fenceChar.repeat(fenceLen));
  return out.join("\n");
}

function sumMore(children) {
  let total = 0;
  for (const c of children || []) {
    const kind = c && c.kind;
    const d = (c && c.data) || {};
    if (kind === "more") {
      const n = Number.isFinite(d.count) && d.count > 0 ? d.count : 0;
      if (n > 0) total += n;
      else if (t1Parent(d)) total += 1;
      continue;
    }
    if (kind !== "t1") continue;
    const replies = d.replies;
    if (replies && typeof replies === "object") {
      total += sumMore(((replies.data || {}).children) || []);
    }
  }
  return total;
}

export function notFetched(data) {
  return sumMore(Array.isArray(data) && data[1] && data[1].data && data[1].data.children);
}

export function comments(children, depth, permalink, out) {
  for (const c of children || []) {
    const kind = c && c.kind;
    const d = (c && c.data) || {};
    if (kind === "more") {
      const parent = t1Parent(d);
      // the branch is <post permalink><comment id>/, so it needs a permalink to hang off:
      // without one the line links the post, as before
      const branch = parent && permalink.endsWith("/") ? `${parent}/` : "";
      const url = `https://www.reddit.com${permalink}${branch}`;
      const n = Number.isFinite(d.count) && d.count > 0 ? d.count : 0;
      if (n > 0) {
        out.push(quote(`*[${n} more repl${n === 1 ? "y" : "ies"} not loaded: ${url}]*`, depth));
        out.push("");
      } else if (parent) {
        out.push(quote(`*[thread continues: ${url}]*`, depth));
        out.push("");
      }
      continue;
    }
    if (kind !== "t1") continue;
    const head = `**u/${d.author ?? "[deleted]"}** · ${d.score ?? "?"} points · ${when(d.created_utc)}`;
    out.push(quote(head, depth));
    out.push(quote("", depth));
    out.push(quote(safeBody(d.body), depth));
    out.push("");
    const replies = d.replies;
    if (replies && typeof replies === "object") {
      comments(((replies.data || {}).children) || [], depth + 1, permalink, out);
    }
  }
}

export function postOf(data) {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("that JSON isn't a reddit post page (expected [post, comments])");
  }
  const children = data[0] && data[0].data && data[0].data.children;
  const post = children && children[0] && children[0].data;
  if (!post) throw new Error("no post found in that JSON");
  return post;
}

// saved maps an image's number to its file name in folderRel (beside the .md); the rest link out.
export function render(data, saved = {}, folderRel = "") {
  const p = postOf(data);
  const link = `https://www.reddit.com${p.permalink ?? ""}`;
  const out = [
    `# ${p.title == null ? "(untitled)" : escapeLine(String(p.title))}`,
    "",
    `r/${p.subreddit ?? "?"} · u/${p.author ?? "[deleted]"} · ${p.score ?? "?"} points · ${p.num_comments ?? "?"} comments · ${when(p.created_utc)}`,
    `Source: ${link}`,
  ];
  const imgs = images(p);
  if (!p.is_self && !mediaPost(p).is_gallery && p.url && p.url !== link
      && !imgs.some((im) => im[1] === p.url)) {
    out.push(`Links to: ${p.url}`);
  }
  for (const [n, u, caption, , skip] of imgs) {
    // Alt text can't hold brackets, backslashes or line breaks without breaking the image line.
    const alt = caption.replace(/[\[\]\\]/g, " ").split(/\s+/).filter(Boolean).join(" ") || `image ${n}`;
    if (!u) {
      out.push("", `*(gallery item ${n}${caption ? ": " + alt : ""} not saved: ${skip})*`);
    } else if (saved[n]) {
      out.push("", `![${alt}](<${folderRel}/${saved[n]}>)`, `Image ${n} source: ${u}`);
    } else {
      out.push("", `![${alt}](<${encodeAngle(u)}>)`);
    }
  }
  out.push("", p.selftext ? safeBody(p.selftext) : "*(no body text)*", "", "---", "", "## Comments", "");
  const missing = notFetched(data);
  if (missing > 0) {
    out.push(`*(This save holds the comments reddit sent in one page; reddit counts ${missing} more that ${missing === 1 ? "was" : "were"} not fetched — the links below open them on reddit.)*`, "");
  }
  const before = out.length;
  comments(data[1] && data[1].data && data[1].data.children, 1, p.permalink ?? "", out);
  if (out.length === before) out.push("*(no comments)*");
  return out.join("\n").trimEnd() + "\n";
}
