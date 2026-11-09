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
// - code spans pair within one line: a `<` in a span the renderer carries across a line
//   break shows as `&lt;`, and after an unclosed backtick every `<` in the rest of the
//   paragraph is escaped (safeBody). Block boundaries come from a port of CommonMark's
//   own block parser (scanBlocks), checked against the real one (test/md-oracle.test.js).
// - a paragraph opening with `[` that a setext underline (`===`, `---`) turns into a
//   heading gets `\[` (safeBody; it shows as `[`): a link reference definition there
//   would decide whether the heading forms, and that parse isn't ported.
// - a lone \r ends a line, as it does for the renderer; quote() expands a line's leading
//   tabs, since "> " shifts the columns a tab's width depends on.

const MIME_EXT = { "image/png": ".png", "image/jpg": ".jpg", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

export function when(ts) {
  const ms = Number.isFinite(Number(ts)) ? Number(ts) * 1000 : 0;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// A tab's width depends on its column, and "> " moves every column by 2: a line's leading
// tabs (in its indent and container markers) become the spaces they stood for on their
// own, so "\tcode" stays code inside a quote. Tabs further in don't shape blocks.
function expandLeadingTabs(line) {
  const lead = line.match(/^[ \t>*+\-.)\d]*/)[0];
  if (!lead.includes("\t")) return line;
  let col = 0;
  let spaced = "";
  for (const ch of lead) {
    const width = ch === "\t" ? 4 - (col % 4) : 1;
    spaced += ch === "\t" ? " ".repeat(width) : ch;
    col += width;
  }
  return spaced + line.slice(lead.length);
}

export function quote(text, depth) {
  text = String(text ?? "");
  const prefix = "> ".repeat(depth);
  // a lone \r ends a line for the renderer too, so it gets its own "> "
  return text.split(/\r\n|\r|\n/).map((line) => (prefix + (depth ? expandLeadingTabs(line) : line)).trimEnd()).join("\n");
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

// One line's escape: code spans pair within the line only. `open` says a backtick run
// found no closer here; in the rendered file it may close on a later line of the same
// paragraph, so safeBody stops trusting spans on the lines after it.
function escapeSpans(line) {
  const parts = line.split(/(`+)/);
  let out = "";
  let open = false;
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
        open = true;
      }
    }
  }
  return { text: out, open };
}

function escapeLine(line) {
  return escapeSpans(line).text;
}

// safeBody's block pass: commonmark.js 0.31.2's line-by-line block parser (lib/blocks.js),
// ported for the one thing safeBody needs from it, each line's fate: paragraph or heading
// text (escaped) or code (kept as written). Container matching, lazy continuation, list
// padding and tab columns follow the reference line for line, because a misjudged
// boundary swaps code and text and leaves a `<` raw. HTML blocks are left out on purpose:
// every `<` that could start one is escaped, so the line is paragraph text in the output
// too. test/md-oracle.test.js checks the result against the real parser.
const CODE_INDENT = 4;
const RE_NON_SPACE = /[^ \t\f\v\r\n]/;
const RE_MAYBE_SPECIAL = /^[#`~*+_=<>0-9-]/;
const RE_THEMATIC = /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/;
const RE_BULLET = /^[*+-]/;
const RE_ORDERED = /^(\d{1,9})([.)])/;
const RE_ATX = /^#{1,6}(?:[ \t]+|$)/;
const RE_FENCE = /^`{3,}(?!.*`)|^~{3,}/;
const RE_CLOSING_FENCE = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const RE_SETEXT = /^(?:=+|-+)[ \t]*$/;
const isSpaceOrTab = (c) => c === " " || c === "\t";

// Returns, per line, the id of the paragraph or heading it is text of (0: kept as is),
// the paragraph-opening `[`s a setext underline turns into headings (see safeBody), and
// the closer an unclosed fence needs, behind its containers' markers ("" if none).
function scanBlocks(lines) {
  const node = (type, parent) => ({ type, parent, open: true, last: null, hasChild: false });
  const doc = node("document", null);
  const kinds = [];
  const brackets = [];
  let ids = 0;
  let tip = doc;
  let oldtip = doc;
  let lastMatched = doc;
  let allClosed = true;
  let ln = "";
  let offset = 0;
  let column = 0;
  let nextNonspace = 0;
  let nextNonspaceColumn = 0;
  let indent = 0;
  let indented = false;
  let blank = false;
  let partial = false;
  let atx = 0;

  const canContain = (t, c) => (t === "list" ? c === "item" : (t === "document" || t === "block_quote" || t === "item") && c !== "item");
  const finalize = (b) => {
    b.open = false;
    tip = b.parent;
  };
  const addChild = (type) => {
    while (!canContain(tip.type, type)) finalize(tip);
    const b = node(type, tip);
    tip.last = b;
    tip.hasChild = true;
    tip = b;
    return b;
  };
  const closeUnmatched = () => {
    if (allClosed) return;
    while (oldtip !== lastMatched) {
      const parent = oldtip.parent;
      finalize(oldtip);
      oldtip = parent;
    }
    allClosed = true;
  };
  const advanceOffset = (count, columns) => {
    let c;
    while (count > 0 && (c = ln[offset])) {
      if (c === "\t") {
        const toTab = 4 - (column % 4);
        if (columns) {
          partial = toTab > count;
          const by = toTab > count ? count : toTab;
          column += by;
          offset += partial ? 0 : 1;
          count -= by;
        } else {
          partial = false;
          column += toTab;
          offset += 1;
          count -= 1;
        }
      } else {
        partial = false;
        offset += 1;
        column += 1;
        count -= 1;
      }
    }
  };
  const advanceNextNonspace = () => {
    offset = nextNonspace;
    column = nextNonspaceColumn;
    partial = false;
  };
  const findNextNonspace = () => {
    let i = offset;
    let cols = column;
    let c;
    while ((c = ln.charAt(i)) !== "") {
      if (c === " ") {
        i++;
        cols++;
      } else if (c === "\t") {
        i++;
        cols += 4 - (cols % 4);
      } else break;
    }
    blank = c === "\n" || c === "\r" || c === "";
    nextNonspace = i;
    nextNonspaceColumn = cols;
    indent = nextNonspaceColumn - column;
    indented = indent >= CODE_INDENT;
  };

  // 0: matched, 1: not matched, 2: a closing fence ended the line
  const continues = (c) => {
    switch (c.type) {
      case "block_quote":
        if (indented || ln[nextNonspace] !== ">") return 1;
        advanceNextNonspace();
        advanceOffset(1, false);
        if (isSpaceOrTab(ln[offset])) advanceOffset(1, true);
        return 0;
      case "item":
        if (blank) {
          if (!c.hasChild) return 1;
          advanceNextNonspace();
        } else if (indent >= c.markerOffset + c.padding) {
          advanceOffset(c.markerOffset + c.padding, true);
        } else return 1;
        return 0;
      case "heading":
      case "thematic_break":
        return 1;
      case "code_block":
        if (c.fenced) {
          const m = indent <= 3 && ln.charAt(nextNonspace) === c.fenceChar && ln.slice(nextNonspace).match(RE_CLOSING_FENCE);
          if (m && m[0].length >= c.fenceLength) {
            finalize(c);
            return 2;
          }
          for (let i = c.fenceOffset; i > 0 && isSpaceOrTab(ln[offset]); i--) advanceOffset(1, true);
        } else if (indent >= CODE_INDENT) {
          advanceOffset(CODE_INDENT, true);
        } else if (blank) {
          advanceNextNonspace();
        } else return 1;
        return 0;
      case "paragraph":
        return blank ? 1 : 0;
      default: // document, list
        return 0;
    }
  };

  const parseListMarker = (container) => {
    if (indent >= 4) return null;
    const rest = ln.slice(nextNonspace);
    const data = { markerOffset: indent };
    let m;
    if ((m = rest.match(RE_BULLET))) {
      data.listType = "bullet";
      data.bulletChar = m[0];
    } else if ((m = rest.match(RE_ORDERED)) && (container.type !== "paragraph" || Number(m[1]) === 1)) {
      data.listType = "ordered";
      data.delimiter = m[2];
    } else return null;
    const nextc = ln.charAt(nextNonspace + m[0].length);
    if (!(nextc === "" || nextc === "\t" || nextc === " ")) return null;
    // an item that interrupts a paragraph can't start blank
    if (container.type === "paragraph" && !RE_NON_SPACE.test(ln.slice(nextNonspace + m[0].length))) return null;
    advanceNextNonspace();
    advanceOffset(m[0].length, true);
    const startCol = column;
    const startOffset = offset;
    do advanceOffset(1, true);
    while (column - startCol < 5 && isSpaceOrTab(ln[offset]));
    const spaces = column - startCol;
    if (spaces >= 5 || spaces < 1 || offset >= ln.length) {
      data.padding = m[0].length + 1;
      column = startCol;
      offset = startOffset;
      if (isSpaceOrTab(ln[offset])) advanceOffset(1, true);
    } else data.padding = m[0].length + spaces;
    return data;
  };

  // block starts, in the reference's order (its HTML block start left out): 0 no match,
  // 1 a container opened, 2 a leaf opened
  const starts = [
    () => {
      if (indented || ln[nextNonspace] !== ">") return 0;
      advanceNextNonspace();
      advanceOffset(1, false);
      if (isSpaceOrTab(ln[offset])) advanceOffset(1, true);
      closeUnmatched();
      addChild("block_quote");
      return 1;
    },
    () => {
      if (indented || !RE_ATX.test(ln.slice(nextNonspace))) return 0;
      closeUnmatched();
      atx = ++ids;
      addChild("heading");
      advanceNextNonspace();
      advanceOffset(ln.length - offset, false);
      return 2;
    },
    () => {
      const m = indented ? null : ln.slice(nextNonspace).match(RE_FENCE);
      if (!m) return 0;
      closeUnmatched();
      const c = addChild("code_block");
      Object.assign(c, { fenced: true, fenceLength: m[0].length, fenceChar: m[0][0], fenceOffset: indent });
      advanceNextNonspace();
      advanceOffset(m[0].length, false);
      return 2;
    },
    (container) => {
      if (indented || container.type !== "paragraph" || !RE_SETEXT.test(ln.slice(nextNonspace))) return 0;
      closeUnmatched();
      const [line, at] = container.first;
      if (lines[line][at] === "[") brackets.push(container.first);
      container.type = "heading";
      advanceOffset(ln.length - offset, false);
      return 2;
    },
    () => {
      if (indented || !RE_THEMATIC.test(ln.slice(nextNonspace))) return 0;
      closeUnmatched();
      addChild("thematic_break");
      advanceOffset(ln.length - offset, false);
      return 2;
    },
    (container) => {
      if (indented && container.type !== "list") return 0;
      const data = parseListMarker(container);
      if (!data) return 0;
      closeUnmatched();
      if (tip.type !== "list" || container.listType !== data.listType
          || container.delimiter !== data.delimiter || container.bulletChar !== data.bulletChar) {
        Object.assign(addChild("list"), data);
      }
      Object.assign(addChild("item"), data);
      return 1;
    },
    () => {
      if (!indented || tip.type === "paragraph" || blank) return 0;
      advanceOffset(CODE_INDENT, true);
      closeUnmatched();
      addChild("code_block");
      return 2;
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    ln = lines[i];
    offset = 0;
    column = 0;
    blank = false;
    partial = false;
    atx = 0;
    oldtip = tip;
    let container = doc;
    let closedFence = false;
    while (container.last && container.last.open) {
      container = container.last;
      findNextNonspace();
      const r = continues(container);
      if (r === 2) {
        closedFence = true;
        break;
      }
      if (r === 1) {
        container = container.parent;
        break;
      }
    }
    if (closedFence) {
      kinds.push(0);
      continue;
    }
    allClosed = container === oldtip;
    lastMatched = container;
    let matchedLeaf = container.type === "code_block";
    while (!matchedLeaf) {
      findNextNonspace();
      if (!indented && !RE_MAYBE_SPECIAL.test(ln.slice(nextNonspace))) {
        advanceNextNonspace();
        break;
      }
      let res = 0;
      for (const start of starts) if ((res = start(container))) break;
      if (!res) {
        advanceNextNonspace();
        break;
      }
      container = tip;
      matchedLeaf = res === 2;
    }
    if (!allClosed && !blank && tip.type === "paragraph") {
      kinds.push(tip.id); // a lazy continuation
      continue;
    }
    closeUnmatched();
    if (container.type === "paragraph") {
      kinds.push(container.id);
    } else if (container.type === "code_block" || container.type === "heading" || container.type === "thematic_break") {
      kinds.push(atx); // an ATX heading's line is text; a fence, code, a break or an underline isn't
    } else if (offset < ln.length && !blank) {
      const p = addChild("paragraph");
      p.id = ++ids;
      advanceNextNonspace();
      p.first = [i, offset];
      kinds.push(p.id);
    } else {
      kinds.push(0);
    }
  }

  // a fence still open at the end gets its closer inside the same containers: "> " per
  // blockquote, the content column in spaces per list item
  let closer = "";
  if (tip.type === "code_block" && tip.fenced) {
    for (let b = tip.parent; b; b = b.parent) {
      if (b.type === "block_quote") closer = "> " + closer;
      else if (b.type === "item") closer = " ".repeat(b.markerOffset + b.padding) + closer;
    }
    closer += tip.fenceChar.repeat(tip.fenceLength);
  }
  return { kinds, brackets, closer };
}

// Bodies keep every line as written except: a `<` in paragraph or heading text becomes
// `&lt;` (code spans pair within one line; see escapeSpans), and an unclosed fence gets a
// closer line. Code spans pair within a line only: a span the renderer carries across a
// line break shows its `<` as `&lt;`, a cosmetic cost. Once a line leaves a backtick run
// unclosed, every later `<` in that paragraph is escaped, since the run may close on a
// later line. One more edit: a paragraph opening with `[` that a setext underline turns
// into a heading gets `\[`, because a link reference definition there decides whether
// the heading forms at all, and that parse isn't ported; `\[` shows as `[`.
export function safeBody(text) {
  const parts = String(text ?? "").split(/(\r\n|\r|\n)/);
  const lines = parts.filter((_, k) => k % 2 === 0);
  const { kinds, brackets, closer } = scanBlocks(lines);
  for (const [i, at] of brackets) lines[i] = lines[i].slice(0, at) + "\\" + lines[i].slice(at);
  let scope = 0;
  let untrusted = false;
  let out = "";
  lines.forEach((line, i) => {
    if (i) out += parts[2 * i - 1];
    const k = kinds[i];
    if (!k) {
      out += line;
      return;
    }
    if (k !== scope) {
      scope = k;
      untrusted = false;
    }
    if (untrusted) {
      out += line.replace(/</g, "&lt;");
      return;
    }
    const r = escapeSpans(line);
    if (r.open) untrusted = true;
    out += r.text;
  });
  return closer ? out + "\n" + closer : out;
}

function moreKind(d) {
  // { count, parent }: count > 0 is reddit's own figure; count 0 with a parent is a
  // thread-continues cut; neither is no node worth a line (null)
  const parent = t1Parent(d);
  const count = Number.isFinite(d.count) && d.count > 0 ? d.count : 0;
  return count || parent ? { count, parent } : null;
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
        const { parent } = m;
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
