// The pure reddit → Markdown converter (src/modules/reddit/md.js), ported part for
// part from dev-docs bin/reddit-export (python): shape validation, the exact render of
// a plain self-post, nested comments, "load more" counts, link lines, images and
// galleries (remote links only — the image-folder download stays CLI-only), null
// safety. No chrome, no fetch: the file-level purity pin lives in offscreen.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import { postOf, mediaPost, images, when, quote, comments, render } from "../src/modules/reddit/md.js";
import { postPage } from "./fixtures/reddit.js";

const comment = (over = {}) => ({ kind: "t1", data: {
  author: "alice", score: 5, created_utc: 1699000000, body: "top", ...over } });

// --- shape validation (post_of's two refusals) ---

test("a json that isn't a [post, comments] pair is refused", () => {
  for (const bad of [[], {}, [{}], [postPage()]]) {
    assert.throws(() => postOf(bad), /isn't a reddit post page/, `expected the shape refusal for ${JSON.stringify(bad).slice(0, 40)}`);
  }
});

test("a pair with no post in the first listing is refused", () => {
  for (const bad of [
    [{ kind: "Listing", data: {} }, null], // children missing (no comments element either)
    [{ kind: "Listing" }, {}], // no data at all
    [{ kind: "Listing", data: { children: [] } }, {}], // children []
    [{ kind: "Listing", data: { children: [null] } }, {}], // children [null]
  ]) {
    assert.throws(() => postOf(bad), /no post found/, `expected the no-post refusal for ${JSON.stringify(bad).slice(0, 60)}`);
  }
});

// --- the exact render of a plain self-post ---

test("a self-post with no comments renders the exact document", () => {
  assert.equal(render(postPage()),
    "# A post\n\n"
    + "r/x · u/someone · 42 points · 0 comments · 2023-11-03 08:26 UTC\n"
    + "Source: https://www.reddit.com/r/x/comments/abc123/a_post/\n\n"
    + "body text\n\n---\n\n## Comments\n\n*(no comments)*\n");
});

// --- nested comments ---

test("comments nest as blockquotes at the CLI's depth-2 shape, an empty body still gets its quote line", () => {
  const md = render(postPage({}, [
    comment({ replies: { kind: "Listing", data: { children: [comment({ author: "carol", score: 2, body: "nested" })] } } }),
    comment({ author: "charlie", score: 0, body: "" }),
    comment({ author: "bob", score: 1, body: "leaf" }),
  ]));
  assert.equal(md,
    "# A post\n\n"
    + "r/x · u/someone · 42 points · 3 comments · 2023-11-03 08:26 UTC\n"
    + "Source: https://www.reddit.com/r/x/comments/abc123/a_post/\n\n"
    + "body text\n\n---\n\n## Comments\n\n"
    + "> **u/alice** · 5 points · 2023-11-03 08:26 UTC\n"
    + ">\n"
    + "> top\n\n"
    + "> > **u/carol** · 2 points · 2023-11-03 08:26 UTC\n"
    + "> >\n"
    + "> > nested\n\n"
    + "> **u/charlie** · 0 points · 2023-11-03 08:26 UTC\n"
    + ">\n"
    + ">\n\n"
    + "> **u/bob** · 1 points · 2023-11-03 08:26 UTC\n"
    + ">\n"
    + "> leaf\n");
});

test("replies = \"\" (reddit's no-replies marker) is skipped, not recursed into", () => {
  const md = render(postPage({}, [comment({ replies: "" })]));
  assert.ok(!md.includes("> > "), `expected no depth-2 lines, got:\n${md}`);
});

// --- "load more comments" counts ---

test("a more node with count 1 names one reply, count 2 names replies, count 0 is silent, other kinds are skipped", () => {
  const one = render(postPage({}, [{ kind: "more", data: { count: 1 } }]));
  assert.ok(one.includes("> *[1 more reply not loaded: https://www.reddit.com/r/x/comments/abc123/a_post/]*"), one);
  const two = render(postPage({}, [{ kind: "more", data: { count: 2 } }]));
  assert.ok(two.includes("*[2 more replies not loaded: https://www.reddit.com/r/x/comments/abc123/a_post/]*"), two);
  const zero = render(postPage({}, [{ kind: "more", data: { count: 0 } }]));
  assert.ok(zero.includes("*(no comments)*"), zero);
  assert.ok(!zero.includes("more repl"), zero);
  const t4 = render(postPage({}, [{ kind: "t4", data: {} }]));
  assert.ok(t4.includes("*(no comments)*"), t4);
});

// --- the "Links to:" line ---

test("a link post gets a Links to line; a url equal to the reddit link does not", () => {
  const link = render(postPage({ is_self: false, url: "https://example.com/article", post_hint: "link" }));
  assert.ok(link.includes("Links to: https://example.com/article"), link);
  const same = render(postPage({ is_self: false, url: "https://www.reddit.com/r/x/comments/abc123/a_post/" }));
  assert.ok(!same.includes("Links to:"), same);
});

// --- single images ---

test("an image post renders a remote image line and no Links to line", () => {
  const hinted = render(postPage({ post_hint: "image", url_overridden_by_dest: "https://i.redd.it/pic.png" }));
  assert.ok(hinted.includes("![image 1](https://i.redd.it/pic.png)"), hinted);
  assert.ok(!hinted.includes("Links to:"), hinted);
  assert.ok(!hinted.includes("(<"), "a remote image links out, without angle brackets");
  const byExtension = render(postPage({ url: "https://example.com/photo.png" }));
  assert.ok(byExtension.includes("![image 1](https://example.com/photo.png)"), byExtension);
  // the pathname check, not the hint: post_hint "link" keeps a page whose pathname is
  // not an image extension a link (the CLI checks the .pathname, so a bare ".jpg" in
  // the middle of the path is not an image)
  const page = render(postPage({ url: "https://imgur.com/gallery/abc.jpg/", post_hint: "link" }));
  assert.ok(!page.includes("![image"), page);
  assert.ok(page.includes("Links to: https://imgur.com/gallery/abc.jpg/"), page);
});

// --- galleries ---

test("a gallery renders its items in order: image with sanitized alt, failed note (alt, not raw caption), video note", () => {
  const md = render(postPage({
    is_gallery: true,
    gallery_data: { items: [
      { media_id: "m1", caption: "A [photo] \\o/ here" },
      { media_id: "m2", caption: "broken [pic]" },
      { media_id: "m3" },
    ] },
    media_metadata: {
      m1: { status: "valid", m: "image/png", s: { u: "https://preview.redd.it/one.png" } },
      m2: { status: "failed" },
      m3: { e: "RedditVideo", s: { mp4: "https://v.redd.it/clip.mp4" } },
    },
  }));
  assert.ok(md.includes("![A photo o/ here](https://preview.redd.it/one.png)"), md);
  assert.ok(md.includes("*(gallery item 2: broken pic not saved: status failed)*"), md);
  assert.ok(!md.includes("broken [pic]"), "the note carries the sanitized alt, never the raw caption");
  assert.ok(md.includes("*(gallery item 3 not saved: a video or animation (mp4 only))*"), md);
  const one = md.indexOf("![A photo o/ here]");
  const two = md.indexOf("gallery item 2");
  const three = md.indexOf("gallery item 3");
  assert.ok(one !== -1 && one < two && two < three, `expected items numbered 1..3 in order, got:\n${md}`);
});

test("a captionless failed gallery item gets a note without the colon part", () => {
  const md = render(postPage({
    is_gallery: true,
    gallery_data: { items: [{ media_id: "m1" }] },
    media_metadata: { m1: { status: "failed" } },
  }));
  assert.ok(md.includes("*(gallery item 1 not saved: status failed)*"), md);
});

test("a gallery item whose caption is a number stringifies it as the alt, without crashing", () => {
  const md = render(postPage({
    is_gallery: true,
    gallery_data: { items: [{ media_id: "m1", caption: 5 }] },
    media_metadata: { m1: { status: "valid", m: "image/png", s: { u: "https://preview.redd.it/one.png" } } },
  }));
  assert.ok(md.includes("![5](https://preview.redd.it/one.png)"), md);
});

// --- crossposts: the media comes from the parent ---

test("a crosspost takes its image from the parent and still links the child's url", () => {
  const md = render(postPage({
    is_self: false,
    url: "https://example.com/thing",
    crosspost_parent_list: [{ post_hint: "image", url_overridden_by_dest: "https://i.redd.it/g1.jpg" }],
  }));
  assert.ok(md.includes("![image 1](https://i.redd.it/g1.jpg)"), md);
  assert.ok(md.includes("Links to: https://example.com/thing"), md);
});

test("a crosspost whose PARENT holds a gallery renders the parent's items, and no Links to line", () => {
  const md = render(postPage({
    is_self: false,
    url: "https://example.com/thing",
    crosspost_parent_list: [{
      is_gallery: true,
      gallery_data: { items: [{ media_id: "m1" }] },
      media_metadata: { m1: { status: "valid", m: "image/jpeg", s: { u: "https://preview.redd.it/p1.jpg" } } },
    }],
  }));
  // images() must reach the parent's gallery THROUGH mediaPost, and the render's
  // Links-to check looks at mediaPost(p).is_gallery — the parent's gallery suppresses it
  assert.ok(md.includes("![image 1](https://preview.redd.it/p1.jpg)"), md);
  assert.ok(!md.includes("Links to:"), `the gallery parent suppresses the child's Links to line:\n${md}`);
});

// --- null and zero fields ---

test("null fields fall back to placeholders, and a 0 score is not '?'", () => {
  const md = render(postPage({ author: null, subreddit: null, title: null, score: 0, created_utc: null }));
  assert.ok(md.includes("# (untitled)\n"), md);
  assert.ok(md.includes("r/? · u/[deleted] · 0 points · 0 comments · 1970-01-01 00:00 UTC"), md);
});

// --- malformed fields (the null-safety the header claims) ---

test("a gallery with a null item among its items renders the no-image note, without crashing", () => {
  const md = render(postPage({
    is_gallery: true,
    gallery_data: { items: [{ media_id: "m1" }, null] },
    media_metadata: { m1: { status: "valid", m: "image/png", s: { u: "https://preview.redd.it/one.png" } } },
  }));
  assert.ok(md.includes("![image 1](https://preview.redd.it/one.png)"), md);
  assert.ok(md.includes("*(gallery item 2 not saved: no image URL)*"), md);
});

test("a non-numeric created_utc reads as the epoch line, not a crash", () => {
  const md = render(postPage({ created_utc: "abc" }));
  assert.ok(md.includes("r/x · u/someone · 42 points · 0 comments · 1970-01-01 00:00 UTC"), md);
});

test("a comment with a null body renders as an empty quoted line, without crashing", () => {
  const md = render(postPage({}, [comment({ body: null })]));
  assert.ok(md.includes("> **u/alice** · 5 points · 2023-11-03 08:26 UTC\n>\n>\n"), md);
});

test("quote survives null text: an empty quoted line, no crash", () => {
  assert.equal(quote(null, 1), ">");
  assert.equal(quote(undefined, 2), "> >");
});

// --- the saved branch (the follow-on images PR's surface) ---

test("a saved image links its local file and names its source", () => {
  const md = render(postPage({ post_hint: "image", url_overridden_by_dest: "https://i.redd.it/pic.png" }), { 1: "01.jpg" }, "NAME-images");
  assert.ok(md.includes("![image 1](<NAME-images/01.jpg>)"), md);
  assert.ok(md.includes("Image 1 source: https://i.redd.it/pic.png"), md);
});

// --- body and trailing newline ---

test("an empty body says so, and the document ends with exactly one newline", () => {
  const md = render(postPage({ selftext: "" }));
  assert.ok(md.includes("*(no body text)*"), md);
  assert.ok(md.endsWith("\n"), md);
  assert.ok(!md.endsWith("\n\n"), md);
});

// --- the smaller helpers, directly ---

test("when formats a created_utc second count, and 0/null reads as the epoch", () => {
  assert.equal(when(1699000000), "2023-11-03 08:26 UTC");
  assert.equal(when(null), "1970-01-01 00:00 UTC");
  assert.equal(when(undefined), "1970-01-01 00:00 UTC");
  assert.equal(when(0), "1970-01-01 00:00 UTC");
  assert.equal(when("abc"), "1970-01-01 00:00 UTC");
});

test("quote prefixes each line at its depth and trims empty lines", () => {
  assert.equal(quote("a\nb", 1), "> a\n> b");
  assert.equal(quote("a", 2), "> > a");
  assert.equal(quote("", 1), ">");
});

test("mediaPost hands a crosspost's parent over, and keeps a post with its own media", () => {
  const parent = { id: "p1" };
  const child = { id: "c1", crosspost_parent_list: [parent] };
  assert.equal(mediaPost(child), parent);
  const ownGallery = { id: "c2", crosspost_parent_list: [parent], gallery_data: { items: [] } };
  assert.equal(mediaPost(ownGallery), ownGallery);
  const ownImage = { id: "c3", crosspost_parent_list: [parent], post_hint: "image" };
  assert.equal(mediaPost(ownImage), ownImage);
});

test("images numbers a gallery in order and finds a single image without one", () => {
  const gallery = {
    is_gallery: true,
    gallery_data: { items: [{ media_id: "m1" }, { media_id: "m2" }] },
    media_metadata: {
      m1: { status: "valid", m: "image/gif", s: { u: "https://preview.redd.it/one.gif" } },
      m2: { e: "RedditVideo" },
    },
  };
  assert.deepEqual(images(gallery), [
    [1, "https://preview.redd.it/one.gif", "", ".gif", ""],
    [2, null, "", "", "a video or animation (mp4 only)"],
  ]);
  const single = { post_hint: "image", url: "https://example.com/not-the-image", url_overridden_by_dest: "https://i.redd.it/pic.png" };
  assert.deepEqual(images(single), [[1, "https://i.redd.it/pic.png", "", "", ""]]);
  assert.deepEqual(images({}), []);
});

test("comments appends head, blank quote, body, blank — and recurses into reply listings", () => {
  const out = [];
  comments([comment({ body: "first", replies: { kind: "Listing", data: { children: [comment({ author: "kid", body: "deep" })] } } })], 1, "/r/x/comments/abc123/a_post/", out);
  assert.deepEqual(out, [
    "> **u/alice** · 5 points · 2023-11-03 08:26 UTC",
    ">",
    "> first",
    "",
    "> > **u/kid** · 5 points · 2023-11-03 08:26 UTC",
    "> >",
    "> > deep",
    "",
  ]);
  // null children cannot throw
  const empty = [];
  comments(null, 1, "/r/x/", empty);
  assert.deepEqual(empty, []);
});
