// The pure reddit → Markdown converter (src/modules/reddit/md.js), ported part for
// part from dev-docs bin/reddit-export (python): shape validation, the exact render of
// a plain self-post, nested comments, "load more" counts, link lines, images and
// galleries (remote links only — the image-folder download stays CLI-only), null
// safety. No chrome, no fetch: the file-level purity pin lives in offscreen.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import { postOf, mediaPost, images, when, quote, comments, notFetched, safeBody, quoteBody, render } from "../src/modules/reddit/md.js";
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

test("a more node with count 1 names one reply, count 2 names replies, count 0 cuts link the branch or stay silent, other kinds are skipped", () => {
  const one = render(postPage({}, [{ kind: "more", data: { count: 1 } }]));
  assert.ok(one.includes("> *[1 more reply not loaded: https://www.reddit.com/r/x/comments/abc123/a_post/]*"), one);
  const two = render(postPage({}, [{ kind: "more", data: { count: 2 } }]));
  assert.ok(two.includes("*[2 more replies not loaded: https://www.reddit.com/r/x/comments/abc123/a_post/]*"), two);
  const twoBranch = render(postPage({}, [{ kind: "more", data: { count: 2, parent_id: "t1_abc9" } }]));
  assert.ok(twoBranch.includes("> *[2 more replies not loaded: https://www.reddit.com/r/x/comments/abc123/a_post/abc9/]*"), twoBranch);
  const twoPost = render(postPage({}, [{ kind: "more", data: { count: 2, parent_id: "t3_abc123" } }]));
  assert.ok(twoPost.includes("> *[2 more replies not loaded: https://www.reddit.com/r/x/comments/abc123/a_post/]*"), twoPost);
  const twoBadId = render(postPage({}, [{ kind: "more", data: { count: 2, parent_id: "t1_../x" } }]));
  assert.ok(twoBadId.includes("> *[2 more replies not loaded: https://www.reddit.com/r/x/comments/abc123/a_post/]*"), twoBadId);
  const cut = render(postPage({}, [{ kind: "more", data: { count: 0, parent_id: "t1_abc9" } }]));
  assert.ok(cut.includes("> *[thread continues: https://www.reddit.com/r/x/comments/abc123/a_post/abc9/]*"), cut);
  const zero = render(postPage({}, [{ kind: "more", data: { count: 0 } }]));
  assert.ok(zero.includes("*(no comments)*"), zero);
  assert.ok(!zero.includes("more repl") && !zero.includes("thread continues"), zero);
  const t4 = render(postPage({}, [{ kind: "t4", data: {} }]));
  assert.ok(t4.includes("*(no comments)*"), t4);
});

test("notFetched sums nested more counts and count-0 cuts, and render() writes the note once after ## Comments", () => {
  const tree = postPage({}, [
    comment({
      replies: {
        kind: "Listing",
        data: {
          children: [
            { kind: "more", data: { count: 3, parent_id: "t1_c1" } },
            { kind: "more", data: { count: 0, parent_id: "t1_c1" } },
          ],
        },
      },
    }),
    { kind: "more", data: { count: 4, parent_id: "t3_abc123" } },
    { kind: "more", data: { count: 0 } },
    { kind: "more", data: { count: "bad" } },
  ]);
  assert.deepEqual(notFetched(tree), { count: 8, atLeast: true }, "a cut counts 1 and makes the count a floor");
  const md = render(tree);
  const note = "*(This save holds the comments reddit sent in one page; reddit counts at least 8 more that were not fetched — the links below open them on reddit.)*";
  assert.ok(md.includes(`## Comments\n\n${note}\n\n> **u/alice**`), md);
  assert.equal(md.split("This save holds the comments reddit sent in one page").length - 1, 1);

  const singleCut = postPage({}, [{ kind: "more", data: { count: 0, parent_id: "t1_abc9" } }]);
  assert.deepEqual(notFetched(singleCut), { count: 1, atLeast: true });
  assert.ok(render(singleCut).includes("reddit counts at least 1 more that was not fetched — the links below open them on reddit."), render(singleCut));

  // no cut: the count is reddit's own, said without "at least"
  const countsOnly = postPage({}, [{ kind: "more", data: { count: 7, parent_id: "t1_abc9" } }]);
  assert.deepEqual(notFetched(countsOnly), { count: 7, atLeast: false });
  assert.ok(render(countsOnly).includes("reddit counts 7 more that were not fetched — the links"), render(countsOnly));

  const complete = postPage({}, [comment()]);
  assert.deepEqual(notFetched(complete), { count: 0, atLeast: false });
  assert.ok(!render(complete).includes("not fetched"), render(complete));
  assert.ok(render(complete, {}, "", { count: 3, atLeast: false }).includes("reddit counts 3 more that were not fetched"));
});

// --- the "Links to:" line ---

test("a link post gets a Links to line; a url equal to the reddit link does not", () => {
  const link = render(postPage({ is_self: false, url: "https://example.com/article", post_hint: "link" }));
  assert.ok(link.includes("Links to: https://example.com/article"), link);
  const same = render(postPage({ is_self: false, url: "https://www.reddit.com/r/x/comments/abc123/a_post/" }));
  assert.ok(!same.includes("Links to:"), same);
});

// --- single images ---

test("an image post renders a remote image line in angle brackets and no Links to line", () => {
  const hinted = render(postPage({ post_hint: "image", url_overridden_by_dest: "https://i.redd.it/pic.png" }));
  assert.ok(hinted.includes("![image 1](<https://i.redd.it/pic.png>)"), hinted);
  assert.ok(!hinted.includes("Links to:"), hinted);
  const byExtension = render(postPage({ url: "https://example.com/photo.png" }));
  assert.ok(byExtension.includes("![image 1](<https://example.com/photo.png>)"), byExtension);
  const parensAndSpace = render(postPage({ post_hint: "image", url_overridden_by_dest: "https://example.com/a (1).png" }));
  assert.ok(parensAndSpace.includes("![image 1](<https://example.com/a%20(1).png>)"), parensAndSpace);
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
  assert.ok(md.includes("![A photo o/ here](<https://preview.redd.it/one.png>)"), md);
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
  assert.ok(md.includes("![5](<https://preview.redd.it/one.png>)"), md);
});

test("a gallery item caption of 0 renders \"0\", and an object caption renders empty", () => {
  const post = {
    is_gallery: true,
    gallery_data: { items: [
      { media_id: "m1", caption: 0 },
      { media_id: "m2", caption: { text: "object" } },
    ] },
    media_metadata: {
      m1: { status: "valid", m: "image/png", s: { u: "https://preview.redd.it/one.png" } },
      m2: { status: "valid", m: "image/png", s: { u: "https://preview.redd.it/two.png" } },
    },
  };
  assert.deepEqual(images(post), [
    [1, "https://preview.redd.it/one.png", "0", ".png", ""],
    [2, "https://preview.redd.it/two.png", "", ".png", ""],
  ]);
  const md = render(postPage(post));
  assert.ok(md.includes("![0](<https://preview.redd.it/one.png>)"), md);
  assert.ok(md.includes("![image 2](<https://preview.redd.it/two.png>)"), md);
});

// --- crossposts: the media comes from the parent ---

test("a crosspost takes its image from the parent and still links the child's url", () => {
  const md = render(postPage({
    is_self: false,
    url: "https://example.com/thing",
    crosspost_parent_list: [{ post_hint: "image", url_overridden_by_dest: "https://i.redd.it/g1.jpg" }],
  }));
  assert.ok(md.includes("![image 1](<https://i.redd.it/g1.jpg>)"), md);
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
  assert.ok(md.includes("![image 1](<https://preview.redd.it/p1.jpg>)"), md);
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
  assert.ok(md.includes("![image 1](<https://preview.redd.it/one.png>)"), md);
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

test("quote splits at a lone \\r too and turns leading tabs into the spaces they stood for", () => {
  assert.equal(quote("a\rb\r\nc", 1), "> a\n> b\n> c");
  // "\t<x>" is code on its own; behind "> " a tab would be 2 columns wide and make it text
  assert.equal(quote("\t<x>", 1), ">     <x>");
  assert.equal(quote("-\tfoo\n  \tbar", 1), "> -   foo\n>     bar");
  // a tab past the line's lead stays a tab, and depth 0 leaves the line alone
  assert.equal(quote("a\tb", 1), "> a\tb");
  assert.equal(quote("\tx", 0), "\tx");
  // an even depth moves columns by a multiple of 4, so every tab keeps its width
  assert.equal(quote("\t<x>", 2), "> > \t<x>");
});

test("quote keeps trailing spaces: a hard line break and code survive quoting", () => {
  assert.equal(quote("a  \nb", 1), "> a  \n> b");
  assert.equal(quote("  ", 1), ">   ");
});

test("quoteBody keeps a code line's own tabs and expands only what its containers use", () => {
  const F = "```";
  // fence content keeps its tab: "> " takes 2 columns, the tab then runs from 2 to 4, as
  // the reader shows a tab at a code line's start anyway
  assert.equal(quoteBody(`${F}\n\tx\n${F}`, 1), `> ${F}\n> \tx\n> ${F}`);
  // indented code: the 4 columns that make it code are spaces now, the rest is as written
  assert.equal(quoteBody("\t\tx", 1), ">     \tx");
  // a fence indented 2 strips 2 columns of the tab and keeps the other 2 as spaces
  assert.equal(quoteBody(`  ${F}\n\tx\n  ${F}`, 1), `>   ${F}\n>     x\n>   ${F}`);
  // a quoted fence: ">\t" uses part of the tab, so the whole tab expands
  assert.equal(quoteBody(`> ${F}\n>\tx`, 1), `> > ${F}\n> >   x\n> > ${F}`);
  // closer-shaped: kept, the tab would be 2 wide and close the fence, so it expands
  assert.equal(quoteBody(`${F}\n\t${F}\n<b>\n${F}`, 1), `> ${F}\n>     ${F}\n> <b>\n> ${F}`);
  // another fence char doesn't close it: kept as written
  assert.equal(quoteBody(`${F}\n\t~~~\n${F}`, 1), `> ${F}\n> \t~~~\n> ${F}`);
  // text lines still expand, and depth 2 expands nothing
  assert.equal(quoteBody("-\tfoo", 1), "> -   foo");
  assert.equal(quoteBody(`${F}\n\t${F}\n${F}`, 2), `> > ${F}\n> > \t${F}\n> > ${F}`);
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

test("safeBody escapes < outside code and closes unclosed fences in post and comment bodies", () => {
  assert.equal(safeBody("    <x>"), "    <x>");
  assert.equal(safeBody("\t<x>"), "\t<x>");
  assert.equal(safeBody("a <T> b"), "a &lt;T> b");
  assert.equal(safeBody("<!-- x\nafter"), "&lt;!-- x\nafter");
  assert.equal(safeBody("`a<b`"), "`a<b`");
  assert.equal(safeBody("```\n<x>\n```\n<y>"), "```\n<x>\n```\n&lt;y>");
  assert.equal(safeBody("~~~~\n<x>\n```\n<y>\n~~~~\n<z>"), "~~~~\n<x>\n```\n<y>\n~~~~\n&lt;z>");
  assert.equal(safeBody("`` a <b `c<d` <e>"), "`` a &lt;b `c<d` &lt;e>");

  const postMd = render(postPage({ selftext: "a <T> b\n```\n<x>" }));
  assert.ok(postMd.includes("a &lt;T> b\n```\n<x>\n```\n\n---\n\n## Comments"), postMd);

  const commentMd = render(postPage({}, [comment({ body: "<!-- x\n`a<b` and <c>\n~~~~\n<raw>" })]));
  assert.ok(commentMd.includes("> &lt;!-- x\n> `a<b` and &lt;c>\n> ~~~~\n> <raw>\n> ~~~~"), commentMd);
});

test("a title's bare < is escaped like a body's, outside code spans", () => {
  const md = render(postPage({ title: "Why <T> beats `a<b`" }));
  assert.ok(md.startsWith("# Why &lt;T> beats `a<b`\n"), md);
});

test("a branch link needs a permalink to hang off: without one the more line links the post", () => {
  const md = render(postPage({ permalink: null }, [{ kind: "more", data: { count: 2, parent_id: "t1_abc9" } }]));
  assert.ok(md.includes("> *[2 more replies not loaded: https://www.reddit.com]*"), md);
  assert.ok(!md.includes("reddit.comabc9"), md);
});

test("safeBody's fences: a longer same-char closer closes, a shorter one doesn't, a backtick info string isn't a fence", () => {
  assert.equal(safeBody("```\n<x>\n`````\n<y>"), "```\n<x>\n`````\n&lt;y>");
  assert.equal(safeBody("````\n<x>\n```\n<y>"), "````\n<x>\n```\n<y>\n````");
  assert.equal(safeBody("``` a`b\n<x>"), "``` a`b\n&lt;x>");
});

test("safeBody tracks fences behind list and blockquote markers, and closes them inside their container", () => {
  // a list item's fence closes on its indented closer: no stray fence, text after is escaped
  assert.equal(safeBody("- ```\n  <x>\n  ```\n<y>"), "- ```\n  <x>\n  ```\n&lt;y>");
  assert.equal(safeBody("1. ```\n   <x>\n   ```"), "1. ```\n   <x>\n   ```");
  // a blockquoted fence keeps its code raw, and an unclosed one closes inside the quote
  assert.equal(safeBody("> ```\n> <x>\n> ```"), "> ```\n> <x>\n> ```");
  assert.equal(safeBody("> ```\n> <x>"), "> ```\n> <x>\n> ```");
  assert.equal(safeBody("- ```\n  <x>"), "- ```\n  <x>\n  ```");
});

test("a list fence closes at its own content depth; a top-level fence keeps a 4-space closer as content", () => {
  assert.equal(safeBody("10. ```\n    <x>\n    ```\n<y>"), "10. ```\n    <x>\n    ```\n&lt;y>");
  assert.equal(safeBody("```\n    ```\n<x>"), "```\n    ```\n<x>\n```");
});

test("inside a top-level fence, a marker-prefixed fence line is code, not the closer", () => {
  // the review's case: a fenced markdown example holding a fenced list item
  assert.equal(safeBody("```md\n- ```\n<x>\n```\nafter <y>"), "```md\n- ```\n<x>\n```\nafter &lt;y>");
  assert.equal(safeBody("```\n> ```\n<x>\n```\n<y>"), "```\n> ```\n<x>\n```\n&lt;y>");
  // a blockquoted fence isn't closed by a bare closer either: the bare ``` ends the quote
  // and opens a top-level fence, which gets closed at EOF
  assert.equal(safeBody("> ```\n> <x>\n```\n<y>"), "> ```\n> <x>\n```\n<y>\n```");
});

test("a 4-space line is indented code only where no paragraph is continuing", () => {
  assert.equal(safeBody("- item\n    <T> here"), "- item\n    &lt;T> here");
  assert.equal(safeBody("text\n    <b>"), "text\n    &lt;b>");
  assert.equal(safeBody("text\n\n    <b>\n    <c>"), "text\n\n    <b>\n    <c>");
  assert.equal(safeBody("    <a>\n\n    <b>\nafter <c>"), "    <a>\n\n    <b>\nafter &lt;c>");
});

test("spans pair within a line; after an unclosed backtick the paragraph's later < are all escaped", () => {
  // a span the renderer carries across the break over-escapes (cosmetic), never leaks
  assert.equal(safeBody("`a <b>\nfoo` and <c>"), "`a &lt;b>\nfoo` and &lt;c>");
  assert.equal(safeBody("> `a <b>\n> foo` and <c>"), "> `a &lt;b>\n> foo` and &lt;c>");
  // a later line's own span isn't trusted while a backtick is open: it may pair across
  assert.equal(safeBody("x `a\nfoo `<x>`"), "x `a\nfoo `&lt;x>`");
  // a blank line, a quote-only line or a fence ends the paragraph and restores trust
  assert.equal(safeBody("`a\n\n`<b>`"), "`a\n\n`<b>`");
  assert.equal(safeBody("> `a\n>\n> `<b>`"), "> `a\n>\n> `<b>`");
  // a balanced line before leaves the next line's spans trusted
  assert.equal(safeBody("`a` b\n`<c>`"), "`a` b\n`<c>`");
});

test("safeBody treats backslash-escaped backticks outside a code span as literal, and backslashes inside a span as literal", () => {
  assert.equal(safeBody("\\`<b>\\`"), "\\`&lt;b>\\`");
  assert.equal(safeBody("\\\\`<b>` <c>"), "\\\\`<b>` &lt;c>");
  assert.equal(safeBody("\\``<b>` <c>"), "\\``<b>` &lt;c>");
  assert.equal(safeBody("`<b>\\`<c>"), "`<b>\\`&lt;c>");
});

test("safeBody requires list content column + 4 for indented code, and treats a 4-space line after an ATX heading as code", () => {
  assert.equal(safeBody("- item\n\n    <!-- note\n\nrest"), "- item\n\n    &lt;!-- note\n\nrest");
  assert.equal(safeBody("10. item\n\n    <x>\n\n        <y>"), "10. item\n\n    &lt;x>\n\n        <y>");
  assert.equal(safeBody("- item\nlazy\n\n    <x>"), "- item\nlazy\n\n    &lt;x>");
  assert.equal(safeBody("- item\n\nafter\n\n    <x>"), "- item\n\nafter\n\n    <x>");
  assert.equal(safeBody("# Heading <T>\n    <x>"), "# Heading &lt;T>\n    <x>");
});

test("a fence ends without a synthetic closer when its list item or blockquote ends", () => {
  assert.equal(safeBody("- ```\n  <x>\n<y>"), "- ```\n  <x>\n&lt;y>");
  assert.equal(safeBody("- ```\n  <x>\n\n  <y>"), "- ```\n  <x>\n\n  <y>\n  ```");
  assert.equal(safeBody("> ```\n> <x>\n\n<y>"), "> ```\n> <x>\n\n&lt;y>");
  assert.equal(safeBody("> > ```\n> > <x>\n> <y>"), "> > ```\n> > <x>\n> &lt;y>");
});

test("a top-level fence indented 1-3 spaces isn't ended by a shallower line", () => {
  assert.equal(safeBody(" ```\nx\n```\nafter <b>"), " ```\nx\n```\nafter &lt;b>");
  assert.equal(safeBody("   ```\n<x>\n   ```\n<y>"), "   ```\n<x>\n   ```\n&lt;y>");
});

test("a span never reaches past a line that starts a new block", () => {
  const t = "`";
  // an HTML block that may interrupt a paragraph is escaped on its own
  assert.equal(safeBody(`${t}a\n<div>\nfoo${t}\n\nrest <x>`), `${t}a\n&lt;div>\nfoo${t}\n\nrest &lt;x>`);
  assert.equal(safeBody(`${t}a\n<!-- c\nfoo${t}`), `${t}a\n&lt;!-- c\nfoo${t}`);
  // a blockquote start, a thematic break and a setext underline end the paragraph
  assert.equal(safeBody(`${t}a\n> <b>\nfoo${t}`), `${t}a\n> &lt;b>\nfoo${t}`);
  assert.equal(safeBody(`${t}a\n***\n<b>\nfoo${t}`), `${t}a\n***\n&lt;b>\nfoo${t}`);
  assert.equal(safeBody(`${t}a\n===\n<b>\n${t}`), `${t}a\n===\n&lt;b>\n${t}`);
  // spans don't cross lines: inside a would-be multi-line span the < over-escapes
  assert.equal(safeBody(`${t}a\n<b>\nfoo${t}`), `${t}a\n&lt;b>\nfoo${t}`);
  assert.equal(safeBody(`> ${t}a\n<b>${t}`), `> ${t}a\n&lt;b>${t}`);
  // a block starting behind quote markers: never a raw <
  assert.equal(safeBody(`> ${t}a\n> - <b>${t}`), `> ${t}a\n> - &lt;b>${t}`);
  assert.equal(safeBody(`> ${t}a\n> # <b>${t}`), `> ${t}a\n> # &lt;b>${t}`);
  assert.equal(safeBody(`> ${t}a\n> ***\n> <b>${t}`), `> ${t}a\n> ***\n> &lt;b>${t}`);
  // an ordered marker other than 1 can't interrupt: mid-paragraph "2. ```" is no fence
  assert.equal(safeBody("foo\n2. ```\n   <x>"), "foo\n2. ```\n   &lt;x>");
});

test("a nested list's end returns to its parent item's content column", () => {
  assert.equal(safeBody("- a\n  - b\n\n  c\n\n    <!-- x\n\nrest <y>"), "- a\n  - b\n\n  c\n\n    &lt;!-- x\n\nrest &lt;y>");
  // a nested item's own code needs its column + 4
  assert.equal(safeBody("- a\n  - b\n\n        <x>"), "- a\n  - b\n\n        <x>");
  // a marker four columns past the content column is code, not a list item
  assert.equal(safeBody("text\n\n    - <x>"), "text\n\n    - <x>");
});

test("indents count tabs to the next multiple of 4, and a list gap of 5+ columns is one space", () => {
  // "  \t" is column 4, two past the item's content column: a paragraph, not code
  assert.equal(safeBody("- a\n\n  \t<!-- x\n\nrest <y>"), "- a\n\n  \t&lt;!-- x\n\nrest &lt;y>");
  assert.equal(safeBody("- a\n\n   \t<!-- x"), "- a\n\n   \t&lt;!-- x");
  // a tab after the marker: content at column 4, so a 4-space line is item text
  assert.equal(safeBody("-\tfoo\n\n    <!-- x"), "-\tfoo\n\n    &lt;!-- x");
  // a 6-column gap: content at column 2, so "  bar" stays in the item
  assert.equal(safeBody("-      foo\n\n  bar\n\n     <!-- x"), "-      foo\n\n  bar\n\n     &lt;!-- x");
  // real code inside the item still stays raw
  assert.equal(safeBody("- a\n\n  \t  <x>"), "- a\n\n  \t  <x>");
});

test("a quote-only line ends the quote's paragraph, so a span can't pair across it", () => {
  const t = "`";
  assert.equal(safeBody(`> ${t}a\n>\n> <b>${t}`), `> ${t}a\n>\n> &lt;b>${t}`);
  assert.equal(safeBody(`> ${t}a\n> \n> <b>${t}`), `> ${t}a\n> \n> &lt;b>${t}`);
  assert.equal(safeBody(`> > ${t}a\n>\n> > <b>${t}`), `> > ${t}a\n>\n> > &lt;b>${t}`);
  assert.equal(safeBody(`> > ${t}a\n> >\n> > <b>${t}`), `> > ${t}a\n> >\n> > &lt;b>${t}`);
  // within one quote paragraph spans don't cross lines either: over-escaped, not raw
  assert.equal(safeBody(`> ${t}a\n> <b>${t}`), `> ${t}a\n> &lt;b>${t}`);
});

test("a list item's fence inside a quote ends where the item ends", () => {
  const f = "```";
  assert.equal(safeBody(`> - ${f}\n> <x>`), `> - ${f}\n> &lt;x>`);
  // still inside the item: kept raw, and the closer closes it
  assert.equal(safeBody(`> - ${f}\n>   <x>\n>   ${f}\n> <y>`), `> - ${f}\n>   <x>\n>   ${f}\n> &lt;y>`);
  // unclosed and never left: closed at the end inside the quote
  assert.equal(safeBody(`> - ${f}\n>   <x>`), `> - ${f}\n>   <x>\n>   ${f}`);
});

test("an escaped HTML block start joins the paragraph, so its backticks pair as the output renders them", () => {
  const t = "`";
  assert.equal(safeBody(`<div>${t}\nfoo ${t}<x>${t}`), `&lt;div>${t}\nfoo ${t}&lt;x>${t}`);
  // inside a container too
  assert.equal(safeBody(`> <div>${t}\n> foo ${t}<x>${t}`), `> &lt;div>${t}\n> foo ${t}&lt;x>${t}`);
  // inside a span the up-front escape only over-escapes (deliberate): nothing stays raw
  assert.equal(safeBody(`${t}a\n<div>\nfoo${t}`), `${t}a\n&lt;div>\nfoo${t}`);
});

test("an empty list item opens its content column; after a paragraph a lone - is a setext underline", () => {
  assert.equal(safeBody("-\n    <!-- x\n\nrest <y>"), "-\n    &lt;!-- x\n\nrest &lt;y>");
  assert.equal(safeBody("- \n    <!-- x"), "- \n    &lt;!-- x");
  assert.equal(safeBody("- a\n-\n  b\n\n    <!-- x"), "- a\n-\n  b\n\n    &lt;!-- x");
  assert.equal(safeBody("1.\n    <!-- x"), "1.\n    &lt;!-- x");
  // a setext heading closes its paragraph, so the 4-space line after it is code
  assert.equal(safeBody("foo\n-\n    <!-- x"), "foo\n-\n    <!-- x");
});
