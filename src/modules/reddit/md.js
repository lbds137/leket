// The reddit post → Markdown converter, ported part for part from the dev-docs CLI
// bin/reddit-export (its post_of, media_post, images, when, quote, comments, render —
// the python file is the spec). Pure by design: no chrome APIs, no fetch, no DOM —
// the extension's fetch half lives in prepare.js and the CLI's image-folder download
// (save_images) and its network half stay CLI-only. Images render as remote links; the
// saved/folderRel arguments are the follow-on images PR's surface, unused by the
// extension for now.
//
// Where the port deliberately differs from the python: null fields fall back to the
// placeholder (u/[deleted], r/?, (untitled)) where python's .get(key, default) would
// print None; ?? guards keep 0 falsy-safe (score: 0 renders "0 points"); null
// children/body/replies cannot crash the port.

const MIME_EXT = { "image/png": ".png", "image/jpg": ".jpg", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

export function when(ts) {
  return new Date((ts || 0) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function quote(text, depth) {
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
      const item = items[i];
      const m = (item.media_id && meta[item.media_id]) || {};
      const s = m.s || {};
      const u = s.u || s.gif;
      const caption = item.caption || "";
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

export function comments(children, depth, permalink, out) {
  for (const c of children || []) {
    const kind = c && c.kind;
    const d = (c && c.data) || {};
    if (kind === "more") {
      const n = d.count ?? 0;
      if (n) {
        out.push(quote(`*[${n} more repl${n === 1 ? "y" : "ies"} not loaded: https://www.reddit.com${permalink}]*`, depth));
        out.push("");
      }
      continue;
    }
    if (kind !== "t1") continue;
    const head = `**u/${d.author ?? "[deleted]"}** · ${d.score ?? "?"} points · ${when(d.created_utc)}`;
    out.push(quote(head, depth));
    out.push(quote("", depth));
    out.push(quote(d.body ?? "", depth));
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
    `# ${p.title ?? "(untitled)"}`,
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
      out.push("", `![${alt}](${u})`);
    }
  }
  out.push("", p.selftext || "*(no body text)*", "", "---", "", "## Comments", "");
  const before = out.length;
  comments(data[1] && data[1].data && data[1].data.children, 1, p.permalink ?? "", out);
  if (out.length === before) out.push("*(no comments)*");
  return out.join("\n").trimEnd() + "\n";
}
