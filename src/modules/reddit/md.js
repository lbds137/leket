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
//   destination (`[x](<url>)`), which then shows as text, and a `<https://…>` autolink,
//   which turns into plain text (the URL still reads; it just isn't a link): rare in
//   reddit, accepted.
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
      let run = parts[i];
      const bs = parts[i - 1].match(/\\+$/);
      if (bs && bs[0].length % 2 === 1) {
        out += "`";
        run = run.slice(1);
        if (!run) continue;
      }
      let close = -1;
      for (let j = i + 2; j < parts.length; j += 2) {
        if (parts[j].length === run.length) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        out += run;
        for (let k = i + 1; k <= close; k++) out += parts[k];
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
const PREFIX = new RegExp(`^${MARKERS}`);
const FENCE_OPEN = new RegExp(`^(${MARKERS}[ ]{0,3})` + "(`{3,}|~{3,})(.*)$");
const FENCE_CLOSE = new RegExp(`^(${MARKERS}[ ]*)` + "(`{3,}|~{3,})\\s*$");
const LIST_ITEM = /^ *(?:[-*+]|\d{1,9}[.)]) +/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
// a thematic break or a setext underline: a line of its own that ends any paragraph
const RULE = /^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+|-+)[ \t]*$/;
// the HTML blocks that may interrupt a paragraph (CommonMark types 1-6); type 7 (any
// other tag, `<b>`) can't, so it stays inline and is escaped with its paragraph
const HTML_BLOCK = /^ {0,3}<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$))/i;

// the container markers a prefix carries, spaces dropped: "> " → ">", "- " → "-", "  " → ""
const markersOf = (prefix) => prefix.replace(/\s/g, "");
const quotesOf = (line) => (line.match(PREFIX)[0].match(/>/g) || []).length;

export function safeBody(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let fenceChar = "";
  let fenceLen = 0;
  let fencePrefix = "";
  // a 4-space (or tab) line is indented code only where a paragraph can't be continuing
  // (at the start, after a blank line, after an ATX heading, or after another
  // indented-code line) and its indent reaches the active list item's content column + 4.
  // Consecutive paragraph lines are buffered and escaped together so multi-line code
  // spans match across line breaks; any line that starts a new block flushes the buffer
  // first, so a span never reaches past a block boundary (flushing only escapes more).
  let para = [];
  let paraQuotes = 0;
  let inIndentedCode = false;
  // the content columns of the open list items, innermost last: a dedent closes only the
  // items deeper than the line, so a nested list's end returns to its parent's column
  const lists = [];
  const listCol = () => (lists.length ? lists[lists.length - 1] : 0);
  const closeListsPast = (indent) => {
    while (lists.length && lists[lists.length - 1] > indent) lists.pop();
  };
  // the content column a fence lives in: below it, a non-blank line ends the fence
  let fenceCol = 0;
  const flushPara = () => {
    if (para.length) {
      out.push(...escapeLine(para.join("\n")).split("\n"));
      para = [];
    }
  };
  for (const line of lines) {
    const blank = /^\s*$/.test(line);
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
    if (fenceLen) {
      // a fence ends when its container ends (fewer > markers for a quote, or a
      // non-blank line indented less than its list item's content column), with no
      // closer appended; the ending line then goes through normal processing. A
      // top-level fence has column 0, so its own 1-3 space indent never ends it
      const fenceQuotes = (fencePrefix.match(/>/g) || []).length;
      const ended = fenceQuotes
        ? quotesOf(line) < fenceQuotes
        : !blank && indent < fenceCol;
      if (!ended) {
        // a closer belongs to the opener's own container: inside a top-level fence, "- ```"
        // or "> ```" is code, not a closer (and a blockquoted fence needs its ">")
        const m = line.match(FENCE_CLOSE);
        if (m && m[2][0] === fenceChar && m[2].length >= fenceLen
            && markersOf(m[1]) === markersOf(fencePrefix) && m[1].length <= fencePrefix.length + 3) {
          fenceChar = "";
          fenceLen = 0;
          fencePrefix = "";
        }
        out.push(line);
        continue;
      }
      fenceChar = "";
      fenceLen = 0;
      fencePrefix = "";
    }
    // a line outside the open items, not a lazy paragraph continuation, closes them
    if (!blank && !para.length) closeListsPast(indent);
    if (!blank && RULE.test(line)) {
      flushPara();
      closeListsPast(indent);
      inIndentedCode = false;
      out.push(escapeLine(line));
      continue;
    }
    // a list marker four or more columns past the content column is indented code
    const list = indent < listCol() + 4 && !(inIndentedCode && indent >= 4) ? line.match(LIST_ITEM) : null;
    if (list) {
      flushPara();
      closeListsPast(indent);
      lists.push(list[0].length);
    }
    const open = line.match(FENCE_OPEN);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
      flushPara();
      if (!list) closeListsPast(indent);
      fenceCol = listCol();
      fenceChar = open[2][0];
      fenceLen = open[2].length;
      // the closer, if one must be added, stays inside the same blockquote (a bare one
      // would open a new top-level fence there); list markers become their width in spaces
      fencePrefix = open[1].replace(/[^>]/g, " ");
      inIndentedCode = false;
      out.push(line);
      continue;
    }
    if (blank) {
      flushPara();
      out.push(line);
      continue;
    }
    if (!list && indent >= listCol() + 4 && (inIndentedCode || !para.length)) {
      inIndentedCode = true;
      out.push(line);
      continue;
    }
    inIndentedCode = false;
    if (ATX_HEADING.test(line) || HTML_BLOCK.test(line)) {
      // a block of its own: escaped alone, never joined to a paragraph's spans
      flushPara();
      out.push(escapeLine(line));
      continue;
    }
    // a deeper blockquote starts a new paragraph; a line with fewer > is a lazy continuation
    const q = quotesOf(line);
    if (para.length && q > paraQuotes) flushPara();
    if (!para.length) paraQuotes = q;
    para.push(line);
  }
  flushPara();
  if (fenceLen) out.push(fencePrefix + fenceChar.repeat(fenceLen));
  return out.join("\n");
}

function moreKind(d) {
  if (Number.isFinite(d.count) && d.count > 0) return { count: d.count };
  const parent = t1Parent(d);
  return parent ? { cut: parent } : null;
}

function sumMore(children, acc) {
  for (const c of children || []) {
    const kind = c && c.kind;
    const d = (c && c.data) || {};
    if (kind === "more") {
      const m = moreKind(d);
      if (m && m.count) acc.count += m.count;
      else if (m) {
        acc.count += 1;
        acc.atLeast = true;
      }
      continue;
    }
    if (kind !== "t1") continue;
    const replies = d.replies;
    if (replies && typeof replies === "object") sumMore(((replies.data || {}).children) || [], acc);
  }
  return acc;
}

// What the one-page fetch left behind: count sums reddit's own "more" counts, plus 1 for
// each thread-continues cut (a cut hides at least one reply, of a number reddit doesn't
// give), and atLeast says a cut was counted, so the count is a floor, not reddit's figure.
export function notFetched(data) {
  return sumMore(Array.isArray(data) && data[1] && data[1].data && data[1].data.children, { count: 0, atLeast: false });
}

export function comments(children, depth, permalink, out) {
  for (const c of children || []) {
    const kind = c && c.kind;
    const d = (c && c.data) || {};
    if (kind === "more") {
      const m = moreKind(d);
      if (m) {
        const parent = m.cut || t1Parent(d);
        // the branch is <post permalink><comment id>/, so it needs a permalink to hang off:
        // without one the line links the post, as before
        const branch = parent && permalink.endsWith("/") ? `${parent}/` : "";
        const url = `https://www.reddit.com${permalink}${branch}`;
        if (m.count) {
          out.push(quote(`*[${m.count} more repl${m.count === 1 ? "y" : "ies"} not loaded: ${url}]*`, depth));
        } else {
          out.push(quote(`*[thread continues: ${url}]*`, depth));
        }
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
export function render(data, saved = {}, folderRel = "", nf = notFetched(data)) {
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
  const { count, atLeast } = nf;
  if (count > 0) {
    out.push(`*(This save holds the comments reddit sent in one page; reddit counts ${atLeast ? "at least " : ""}${count} more that ${count === 1 ? "was" : "were"} not fetched — the links below open them on reddit.)*`, "");
  }
  const before = out.length;
  comments(data[1] && data[1].data && data[1].data.children, 1, p.permalink ?? "", out);
  if (out.length === before) out.push("*(no comments)*");
  return out.join("\n").trimEnd() + "\n";
}
