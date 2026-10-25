// src/lib/build.js, files.js and render.js: an export in, the zip's files out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, fetchFile } from "../src/lib/build.js";
import { attachmentList, fetchable, fileName } from "../src/lib/files.js";
import { render } from "../src/lib/render.js";

const CHECK = fileURLToPath(new URL("./zipcheck.py", import.meta.url));
const CDN = "https://cdn.discordapp.com/attachments/1";

const exp = () => ({
  channel: "general", guild_name: "Test <Server>", extracted_at: "2021-01-03T12:00:00Z",
  reached_start: false, reached_since: null, hidden_groups: { not_opened: 1 }, forwards_without_snapshot: 0,
  participants: [{ id: "1", username: "alice_u", global_name: "Alice", nick: "Al", webhook: false }],
  messages: [
    { id: "10", datetime: "2021-01-01T10:00:00.000Z", author: "Alice", author_id: "1", nick: "Al",
      text: "hi <@1> see https://example.com/a?b=1&c=2). <script>x</script> `code <b>` <:wave:123>",
      reply_to: null, attachments: [{ filename: "cat pic.png", url: `${CDN}/10/cat.png?ex=1` }], embeds: [], edited: true },
    { id: "11", datetime: "2021-01-01T10:01:00.000Z", author: "Bob", author_id: "2", nick: null, text: "```js\nlet a = '<i>';\n```",
      reply_to: "10", attachments: [{ filename: "gone.mp4", url: `${CDN}/11/gone.mp4` }, { filename: "evil.png", url: "https://evil.example/x.png" }],
      embeds: [{ title: "Card", url: "https://example.com", description: "desc" }] },
    { id: "12", datetime: "2021-01-02T09:00:00.000Z", author: "Bob", author_id: "2", text: "", reply_to: null, attachments: [], embeds: [],
      forward_of: { message_id: "5" }, forwarded: [{ text: "fwd text", attachments: [{ filename: "f.ogg", url: `${CDN}/12/f.ogg` }], embeds: [] }] },
  ],
});

// a fetch that answers from a table: bytes, or a status
const fakeFetch = (table) => async (url) => {
  const v = table[url.split("?")[0]];
  if (v === undefined) throw new TypeError("Failed to fetch");
  if (typeof v === "number") return new Response("", { status: v });
  return new Response(v, { status: 200, headers: { "content-length": String(Buffer.byteLength(v)) } });
};

async function unzip(parts) {
  const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "build-"));
  const paths = [];
  for (const [i, { blob }] of parts.entries()) {
    const p = join(dir, `${i}.zip`);
    writeFileSync(p, Buffer.from(await blob.arrayBuffer()));
    paths.push(p);
  }
  const got = JSON.parse(execFileSync("python3", [CHECK, ...paths], { encoding: "utf8" }));
  return paths.map((p) => got[p]);
}

test("file names follow the Python fetcher's layout and stay under 240 bytes", () => {
  assert.equal(fileName("2021-01-01_10_0_", "cat pic (1).png"), "2021-01-01_10_0_cat_pic_1_.png");
  const long = fileName("2021-01-01_10_0_", `${"ש".repeat(200)}.jpeg`);
  assert.ok(Buffer.byteLength(long) <= 240, Buffer.byteLength(long));
  assert.ok(long.endsWith(".jpeg"));
  const list = attachmentList(exp());
  assert.deepEqual(list.map((r) => r.file), ["2021-01-01_10_0_cat_pic.png", "2021-01-01_11_0_gone.mp4",
    "2021-01-01_11_1_evil.png", "2021-01-02_12_f0_0_f.ogg"]);
  assert.equal(list[3].forwarded, 0);
  assert.ok(fetchable(`${CDN}/x.png`) && fetchable("https://media.discordapp.net/x.png"));
  assert.ok(!fetchable("https://evil.example/x.png") && !fetchable("http://cdn.discordapp.com/x") && !fetchable("nonsense"));
});

test("an expired link isn't retried; a network error is, then reported", async () => {
  let calls = 0;
  const gone = await fetchFile(`${CDN}/a`, { fetchFn: async () => { calls++; return new Response("", { status: 404 }); }, wait: 0 });
  assert.deepEqual([gone.error, calls], ["link expired or gone (HTTP 404)", 1]);
  calls = 0;
  const flaky = await fetchFile(`${CDN}/a`, { fetchFn: async () => { if (++calls < 3) throw new TypeError("Failed to fetch"); return new Response("ok"); }, wait: 0 });
  assert.equal(await flaky.blob.text(), "ok");
  const down = await fetchFile(`${CDN}/a`, { fetchFn: async () => new Response("", { status: 503 }), wait: 0, tries: 2 });
  assert.equal(down.error, "HTTP 503");
  const short = await fetchFile(`${CDN}/a`, { fetchFn: async () => new Response("abc", { headers: { "content-length": "10" } }), wait: 0, tries: 1 });
  assert.equal(short.error, "got 3 of 10 bytes");
  // a compressed response's length is not the file's
  const gz = await fetchFile(`${CDN}/a`, { fetchFn: async () => new Response("abcdef", { headers: { "content-length": "4", "content-encoding": "gzip" } }), wait: 0, tries: 1 });
  assert.equal(await gz.blob.text(), "abcdef");
});

test("a download that stalls is dropped after the idle time, and the build goes on", async () => {
  const stalls = async (url, { signal }) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("par"));
      signal.addEventListener("abort", () => c.error(signal.reason));
    },
  }));
  const t = Date.now();
  const r = await fetchFile(`${CDN}/a`, { fetchFn: stalls, wait: 0, tries: 2, idle: 100 });
  assert.equal(r.error, "nothing received for 0.1 s");
  assert.ok(Date.now() - t < 2000);
});

test("the zip holds the JSON, the page, the manifest and the files that came", async () => {
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: "PNGDATA", [`${CDN}/11/gone.mp4`]: 404, [`${CDN}/12/f.ogg`]: "OGG" });
  const r = await build(exp(), { file: "discord-general-600.json", fetchFn, wait: 0 });
  assert.deepEqual(r.parts.map((p) => p.name), ["discord-general-600.zip"]);
  assert.equal(r.saved, 2);
  assert.deepEqual(r.failed.map((f) => [f.filename, f.error]), [["gone.mp4", "link expired or gone (HTTP 404)"],
    ["evil.png", "not a Discord attachment link"]]);
  const [files] = await unzip(r.parts);
  assert.deepEqual(Object.keys(files), ["discord-general-600.json", "index.html", "discord-attachments.json",
    "discord-attachments/2021-01-01_10_0_cat_pic.png", "discord-attachments/2021-01-02_12_f0_0_f.ogg"]);
  assert.equal(files["discord-attachments/2021-01-01_10_0_cat_pic.png"], "PNGDATA");
  assert.equal(JSON.parse(files["discord-general-600.json"]).messages.length, 3);
  const manifest = JSON.parse(files["discord-attachments.json"]);
  assert.deepEqual(manifest[0], { message_id: "10", filename: "cat pic.png", file: "2021-01-01_10_0_cat_pic.png" });
  assert.deepEqual(manifest[3], { message_id: "12", filename: "f.ogg", file: "2021-01-02_12_f0_0_f.ogg", forwarded: 0 });
  assert.equal(manifest[1].error, "link expired or gone (HTTP 404)");
  assert.ok(!JSON.stringify(manifest).includes("ex=1"), "no signed links in the manifest");
});

test("without attachments, nothing is fetched and the page says so", async () => {
  const r = await build(exp(), { file: "x.json", attachments: false, fetchFn: () => assert.fail("fetched") });
  const [files] = await unzip(r.parts);
  assert.deepEqual(Object.keys(files), ["x.json", "index.html"]);
  assert.match(files["index.html"], /saving attachments was turned off/);
});

test("past the part limit the save comes in numbered parts, the page in the first", async () => {
  const big = "x".repeat(40000);
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: big, [`${CDN}/11/gone.mp4`]: big, [`${CDN}/12/f.ogg`]: big });
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, partLimit: 60000 });
  assert.deepEqual(r.parts.map((p) => p.name), ["d-part1-of-3.zip", "d-part2-of-3.zip", "d-part3-of-3.zip"]);
  const parts = await unzip(r.parts);
  assert.ok("index.html" in parts[0]);
  assert.equal(parts.flatMap((p) => Object.keys(p)).filter((n) => n.startsWith("discord-attachments/")).length, 3);
});

test("the page escapes what people wrote and shows Discord's markup readably", () => {
  const records = attachmentList(exp());
  records[1].error = "link expired or gone (HTTP 404)";
  const html = render(exp(), records, { timeZone: "UTC" });
  assert.ok(!html.includes("<script>x</script>") && html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes("<title>general · Test &lt;Server&gt;</title>"));
  assert.ok(html.includes('<a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>).'));
  assert.ok(html.includes('<span class="mention">@Al</span>'));
  assert.ok(html.includes("<code>code &lt;b&gt;</code>"));
  assert.ok(html.includes('<span class="emoji">:wave:</span>'));
  assert.ok(html.includes("<pre>let a = &#39;&lt;i&gt;&#39;;\n</pre>"));
  assert.ok(html.includes('<img loading="lazy" src="discord-attachments/2021-01-01_10_0_cat_pic.png" alt="cat pic.png">'));
  assert.ok(html.includes("gone.mp4 <em>(not saved: link expired or gone (HTTP 404))</em>"));
  assert.ok(html.includes('<a class="reply" href="#m10">↪ Al: hi'));
  assert.ok(html.includes('<div class="f-label">Forwarded</div>fwd text'));
  assert.ok(html.includes('<audio controls preload="metadata" src="discord-attachments/2021-01-02_12_f0_0_f.ogg">'));
  assert.ok(html.includes("(edited)"));
  assert.ok(html.includes("Friday, January 1, 2021") && html.includes("Saturday, January 2, 2021"));
  assert.match(html, /The start of the conversation was not reached/);
  assert.match(html, /1 group\(s\) of blocked or ignored messages would not open/);
  // only web addresses are links; a wiki address keeps its closing parenthesis
  const odd = exp();
  odd.messages[0].text = "see https://en.wikipedia.org/wiki/Foo_(bar), ok";
  odd.messages[1].embeds = [{ title: "Click", url: "javascript:alert(1)", image: "data:text/html,x" }];
  const oddHtml = render(odd, [], { timeZone: "UTC" });
  assert.ok(oddHtml.includes('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>, ok'));
  assert.ok(!/href="(javascript|data):/i.test(oddHtml));
  assert.ok(oddHtml.includes('<div class="e-title">Click</div>'));
  // nothing on the page reaches out to the web by itself: no remote src
  assert.ok(![...html.matchAll(/\ssrc="([^"]+)"/g)].some(([, s]) => /^https?:/.test(s)));
});
