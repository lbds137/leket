// leket reddit: the CLI half of the Reddit save. The Markdown itself is md.js's, tested
// in md.test.js; these pin what the CLI adds: the same bytes as render(), the image
// folder, --file / stdout, refusals that write nothing, and the logged-out URL path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { render } from "../src/modules/reddit/md.js";
import { fetchRedditPost, redditPostId, redditUrl, saveRedditPost } from "../bin/leket.js";
import { postPage } from "./fixtures/reddit.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "leket.js");
const leket = (args, cwd) => spawnSync(process.execPath, [BIN, "reddit", ...args], { encoding: "utf8", cwd });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-reddit-"));

const comment = (id, body, replies = "") => ({ kind: "t1", data: {
  id, author: "replier", score: 3, created_utc: 1699000100, body, replies,
} });

// a self post with a nested reply and a collapsed branch: no image, so no network
const selfPost = postPage({ selftext: "Hello <world>\n\n```\nunclosed" }, [
  comment("c1", "top", { kind: "Listing", data: { children: [comment("c2", "nested")] } }),
  { kind: "more", data: { count: 4, parent_id: "t3_abc123", children: ["c3"] } },
]);

// Run saveRedditPost in this process with its prints collected. Patching
// process.stdout instead would swallow node's own test reports, which travel over it.
async function captured(data, opts) {
  const out = [], err = [];
  const code = await saveRedditPost(data, { ...opts, say: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test("--from-json writes reddit-<id>.md into --out, byte for byte what the extension renders", () => {
  const dir = tmp();
  const src = join(dir, "reddit-abc123.json");
  writeFileSync(src, JSON.stringify(selfPost));
  const out = join(dir, "saves", "new");
  const r = leket(["--from-json", src, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const dest = join(out, "reddit-abc123.md");
  assert.equal(r.stdout, `${dest}\n`);
  assert.equal(readFileSync(dest, "utf8"), render(selfPost));
  assert.deepEqual(readdirSync(out), ["reddit-abc123.md"], "no image folder for a post without images");
});

test("--file - prints the Markdown and writes nothing; --file PATH writes there", () => {
  const dir = tmp();
  const src = join(dir, "post.json");
  writeFileSync(src, JSON.stringify(selfPost));
  const r = leket(["--from-json", src, "--file", "-"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, render(selfPost));
  assert.deepEqual(readdirSync(dir), ["post.json"]);
  const named = join(dir, "kept.md");
  const w = leket(["--from-json", src, "--file", named]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(readFileSync(named, "utf8"), render(selfPost));
});

test("a gallery saves what it can into <name>-images, links the rest out and exits 3", async () => {
  const dir = tmp();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const data = postPage({
    is_gallery: true,
    gallery_data: { items: [{ media_id: "m1", caption: "first" }, { media_id: "m2" }, { media_id: "m3" }, { media_id: "m4" }] },
    media_metadata: {
      m1: { status: "valid", m: "image/png", s: { u: "https://i.redd.it/one.png" } },
      m2: { status: "valid", m: "image/jpeg", s: { u: "https://i.redd.it/gone.jpg" } },
      m3: { e: "RedditVideo", s: { mp4: "https://v.redd.it/clip.mp4" } },
      m4: { status: "failed" },
    },
  });
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    return url.endsWith("one.png")
      ? new Response(png, { headers: { "content-type": "image/png" } })
      : new Response("gone", { status: 404 });
  };
  const r = await captured(data, { out: dir, fetch });
  assert.equal(r.code, 3, r.stderr);
  assert.deepEqual(asked, ["https://i.redd.it/one.png", "https://i.redd.it/gone.jpg"], "only items with a picture are fetched");
  assert.match(r.stderr, /couldn't save image 2 \(the server answered 404\); the \.md links https:\/\/i\.redd\.it\/gone\.jpg/);
  const folder = join(dir, "reddit-abc123-images");
  assert.deepEqual(readdirSync(folder), ["01.png"]);
  assert.deepEqual(new Uint8Array(readFileSync(join(folder, "01.png"))), png);
  const md = readFileSync(join(dir, "reddit-abc123.md"), "utf8");
  assert.equal(md, render(data, { 1: "01.png" }, "reddit-abc123-images"), "the extension's Markdown for the same saved set");
  assert.ok(md.includes("![first](<reddit-abc123-images/01.png>)"), md);
  assert.ok(md.includes("![image 2](<https://i.redd.it/gone.jpg>)"), md);
});

test("an image refused before any request (not https) is linked out without a fetch", async () => {
  const dir = tmp();
  const data = postPage({ post_hint: "image", url: "http://example.com/a.jpg", is_self: false });
  let asked = 0;
  const r = await captured(data, { out: dir, fetch: async () => { asked++; } });
  assert.equal(r.code, 3);
  assert.equal(asked, 0);
  assert.match(r.stderr, /only https images are fetched/);
  assert.ok(!existsSync(join(dir, "reddit-abc123-images")), "no folder when nothing saved");
});

test("data that isn't a post, or an id that isn't reddit's, writes nothing (exit 1)", async () => {
  const dir = tmp();
  const notPost = await captured({ kind: "Listing" }, { out: dir });
  assert.equal(notPost.code, 1);
  assert.match(notPost.stderr, /isn't a reddit post page.*nothing written/);
  const evil = postPage({ id: "../../escape" });
  const badId = await captured(evil, { out: dir });
  assert.equal(badId.code, 1);
  assert.match(badId.stderr, /isn't reddit's form; give --file PATH/);
  assert.deepEqual(readdirSync(dir), []);
  const named = join(dir, "ok.md");
  const withFile = await captured(evil, { file: named });
  assert.equal(withFile.code, 0, "--file names the path, so the id is never used");
  assert.ok(existsSync(named));
});

test("usage: one source, --out or --file, a reddit address; an unreadable or non-JSON file is exit 1", () => {
  const dir = tmp();
  const src = join(dir, "x.json");
  writeFileSync(src, JSON.stringify(selfPost));
  assert.equal(leket([]).status, 2);
  assert.equal(leket(["https://www.reddit.com/comments/abc123", "--from-json", src]).status, 2);
  assert.equal(leket(["--from-json", src, "--out", dir, "--file", join(dir, "a.md")]).status, 2);
  const off = leket(["https://example.com/r/x/comments/abc123/"]);
  assert.equal(off.status, 2);
  assert.match(off.stderr, /give a reddit post address/);
  assert.equal(leket(["--help"]).status, 0);
  const missing = leket(["--from-json", join(dir, "nope.json")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /couldn't read/);
  const junk = join(dir, "junk.json");
  writeFileSync(junk, "<html>");
  const notJson = leket(["--from-json", junk]);
  assert.equal(notJson.status, 1);
  assert.match(notJson.stderr, /isn't JSON/);
});

test("redditUrl takes reddit's hosts only; redditPostId reads /comments/ID and redd.it/ID", () => {
  for (const ok of ["https://www.reddit.com/r/x/comments/abc123/t/", "old.reddit.com/comments/abc123", "http://np.reddit.com/r/x/s/Code", "https://redd.it/abc123"]) {
    assert.ok(redditUrl(ok), ok);
  }
  for (const bad of ["https://reddit.com.evil.example/comments/abc123", "ftp://reddit.com/comments/abc123", "https://evilreddit.com/comments/x", "not a url"]) {
    assert.equal(redditUrl(bad), null, bad);
  }
  assert.equal(redditPostId(redditUrl("https://www.reddit.com/r/x/comments/abc123/t/")), "abc123");
  assert.equal(redditPostId(redditUrl("https://redd.it/abc123")), "abc123");
  assert.equal(redditPostId(redditUrl("https://www.reddit.com/r/x/s/Code")), null);
});

test("fetchRedditPost resolves a share link by its redirect, then asks for the post's JSON", async () => {
  const asked = [];
  const fetch = async (url, opts) => {
    asked.push({ url, opts });
    if (url.includes("/s/")) return new Response(null, { status: 301, headers: { location: "/r/x/comments/abc123/a_post/" } });
    return new Response(JSON.stringify(selfPost), { headers: { "content-type": "application/json" } });
  };
  assert.deepEqual(await fetchRedditPost("https://www.reddit.com/r/x/s/Code", { fetch }), selfPost);
  assert.deepEqual(asked.map((a) => a.url), [
    "https://www.reddit.com/r/x/s/Code",
    "https://www.reddit.com/comments/abc123.json?raw_json=1&limit=500",
  ], "the post page itself is never fetched: the redirect already names it");
  for (const { opts } of asked) {
    assert.equal(opts.redirect, "manual", "every hop is checked before it is followed");
    assert.match(opts.headers["user-agent"], /^leket /);
  }
});

test("fetchRedditPost: a redirect off reddit, a 403, a 5xx and a page instead of JSON each fail with a reason", async () => {
  const offSite = async () => new Response(null, { status: 302, headers: { location: "https://evil.example/r/x/comments/abc123/" } });
  await assert.rejects(fetchRedditPost("https://www.reddit.com/r/x/s/Code", { fetch: offSite }), /redirects off reddit, to https:\/\/evil\.example/);
  const refused = async () => new Response("blocked", { status: 403 });
  await assert.rejects(fetchRedditPost("https://redd.it/abc123", { fetch: refused }), /refused a logged-out fetch \(HTTP 403\).*--from-json reddit-abc123\.json/);
  await assert.rejects(fetchRedditPost("https://www.reddit.com/r/x/s/Code", { fetch: refused }), /didn't lead to a post \(reddit answered 403\)/);
  const down = async () => new Response("", { status: 503 });
  await assert.rejects(fetchRedditPost("https://redd.it/abc123", { fetch: down }), /reddit answered 503 for post abc123/);
  const page = async () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(fetchRedditPost("https://redd.it/abc123", { fetch: page }), /a page, not the post's JSON/);
  const offline = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(fetchRedditPost("https://redd.it/abc123", { fetch: offline }), /couldn't reach reddit \(fetch failed\)/);
});

test("redditUrl asks over https only, on the default port, with no login; a post id is a whole segment", () => {
  assert.equal(redditUrl("http://np.reddit.com/r/x/s/Code").href, "https://np.reddit.com/r/x/s/Code");
  for (const bad of ["https://me:pw@www.reddit.com/comments/abc123", "https://www.reddit.com:8443/comments/abc123"]) {
    assert.equal(redditUrl(bad), null, bad);
  }
  assert.equal(redditPostId(redditUrl("https://www.reddit.com/comments/abc_def/")), null);
  assert.equal(redditPostId(redditUrl("https://www.reddit.com/comments/abc123.json")), "abc123");
});

test("fetchRedditPost follows reddit's redirect of the JSON address; a bare or broken Location and a failed read say so", async () => {
  const asked = [];
  const moved = async (url) => {
    asked.push(url);
    return url.includes("/comments/abc123.json?")
      ? new Response(null, { status: 301, headers: { location: "/r/x/comments/abc123/a_post/.json?raw_json=1" } })
      : new Response(JSON.stringify(selfPost));
  };
  assert.deepEqual(await fetchRedditPost("https://redd.it/abc123", { fetch: moved }), selfPost);
  assert.equal(asked[1], "https://www.reddit.com/r/x/comments/abc123/a_post/.json?raw_json=1");
  const bare = async () => new Response(null, { status: 302 });
  await assert.rejects(fetchRedditPost("https://redd.it/abc123", { fetch: bare }), /answered 302 without saying where to/);
  const broken = async () => new Response(null, { status: 302, headers: { location: "http://[" } });
  await assert.rejects(fetchRedditPost("https://redd.it/abc123", { fetch: broken }), /redirects off reddit, to http:\/\/\[/);
  const cut = async () => new Response(new ReadableStream({ start(c) { c.error(new Error("connection reset")); } }));
  await assert.rejects(fetchRedditPost("https://redd.it/abc123", { fetch: cut }), /couldn't read reddit's answer for post abc123 \(connection reset\)/);
});
