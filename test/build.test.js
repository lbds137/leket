// src/lib/build.js, files.js and render.js: an export in, the zip's files out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, fetchFile, restBetweenFiles } from "../src/lib/build.js";
import { attachmentList, fetchable, fileName, needsParts } from "../src/lib/files.js";
import { PART_LIMIT } from "../src/lib/zip.js";
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
  assert.ok(!("size" in list[0]), "a size the export doesn't carry stays absent");
  const sized = attachmentList({ messages: [{ id: "9", datetime: "2021-01-01T10:00:00.000Z",
    attachments: [{ filename: "a.png", url: `${CDN}/a`, size: "123" }] }] });
  assert.equal(sized[0].size, 123);
  assert.ok(fetchable(`${CDN}/x.png`) && fetchable("https://media.discordapp.net/x.png"));
  assert.ok(!fetchable("https://evil.example/x.png") && !fetchable("http://cdn.discordapp.com/x") && !fetchable("nonsense"));
});

test("a save streams when the attachments are big, or their sizes unknown", () => {
  const rec = (size) => ({ url: `${CDN}/x`, size });
  assert.equal(needsParts([]), false);
  assert.equal(needsParts([rec(1000)]), false);
  assert.equal(needsParts([rec(PART_LIMIT)]), true);
  assert.equal(needsParts([{ url: `${CDN}/x` }]), true, "no size: assume it doesn't fit");
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
  // a CDN 504 stretch gets the default five tries, backing off between them
  calls = 0;
  const t1 = Date.now();
  const timing = await fetchFile(`${CDN}/a`, { fetchFn: async () => { calls++; return new Response("", { status: 504 }); }, wait: 5 });
  assert.equal(timing.error, "HTTP 504");
  assert.equal(calls, 5);
  // the waits back off (5+10+15+20 ms); a flat wait would sum to 20 ms
  assert.ok(Date.now() - t1 >= 40, "the waits between the tries back off");
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
  const r = await build(exp(), { file: "discord-general-600.json", fetchFn, wait: 0, gap: 0 });
  assert.deepEqual(r.parts.map((p) => p.name), ["discord-general-600.zip"]);
  assert.equal(r.saved, 2);
  assert.deepEqual(r.failed.map((f) => [f.filename, f.error]), [["gone.mp4", "link expired or gone (HTTP 404)"],
    ["evil.png", "not a Discord attachment link"]]);
  const [files] = await unzip(r.parts);
  // small saves pack as they always did: page, manifest, then the files
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

test("a streamed page names the manifest as its failure list; a small save's page does not", () => {
  assert.ok(render(exp(), [], { timeZone: "UTC", streamed: true }).includes("files missing here are listed in discord-attachments.json"));
  assert.ok(!render(exp(), [], { timeZone: "UTC" }).includes("files missing here are listed"));
});

test("past the part limit the save comes in numbered parts, the page in the first", async () => {
  const big = "x".repeat(40000);
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: big, [`${CDN}/11/gone.mp4`]: big, [`${CDN}/12/f.ogg`]: big });
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, gap: 0, partLimit: 60000 });
  assert.deepEqual(r.parts.map((p) => p.name), ["d-part1-of-3.zip", "d-part2-of-3.zip", "d-part3-of-3.zip"]);
  const parts = await unzip(r.parts);
  assert.ok("index.html" in parts[0]);
  assert.equal(parts.flatMap((p) => Object.keys(p)).filter((n) => n.startsWith("discord-attachments/")).length, 3);
});

test("streamed, the text part goes out first and the attachment parts follow, one part at a time", async () => {
  const big = "x".repeat(40000);
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: big, [`${CDN}/11/gone.mp4`]: big, [`${CDN}/12/f.ogg`]: big });
  const blobs = [], handed = [];
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, gap: 0, partLimit: 60000,
    onPart: async (p) => { blobs.push(p.blob); handed.push(p); } });
  // the total isn't known while streaming, so names carry only the part number; the
  // manifest comes last, in its own small part
  assert.deepEqual(r.parts.map((p) => [p.name, p.index]),
    [["d-part1.zip", 1], ["d-part2.zip", 2], ["d-part3.zip", 3], ["d-part4.zip", 4], ["d-part5.zip", 5]]);
  assert.ok(r.parts.every((p) => !("blob" in p)));
  const [text, catPart, gonePart, oggPart, manifestPart] = await unzip(blobs.map((blob) => ({ blob })));
  assert.deepEqual(Object.keys(text), ["d.json", "index.html"]);
  for (const p of [catPart, gonePart, oggPart])
    assert.ok(Object.keys(p).length === 1 && Object.keys(p)[0].startsWith("discord-attachments/"),
      "each attachment part holds one file, whichever order the fetches finished in");
  assert.deepEqual(Object.keys(manifestPart), ["discord-attachments.json"]);
  assert.equal(r.saved, 3);
  assert.equal(r.leftBehind, 0);
});

test("when the last attachment part fails, nothing is left behind: retrying that part completes the save", async () => {
  const big = "x".repeat(40000);
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: big, [`${CDN}/11/gone.mp4`]: big, [`${CDN}/12/f.ogg`]: big });
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, gap: 0, partLimit: 60000,
    onPart: async (p) => p.index !== 4 });
  assert.deepEqual(r.parts.map((p) => p.index), [1, 2, 3, 4, 5]);
  assert.equal(r.records.filter((m) => (m.error || "").startsWith("saved into part 4")).length, 1);
  assert.equal(r.leftBehind, 0);
});

test("streamed with nothing fetched (every link gone), the text and the manifest still come out", async () => {
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: 404, [`${CDN}/11/gone.mp4`]: 404, [`${CDN}/12/f.ogg`]: 404 });
  const blobs = [], handed = [];
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, gap: 0, partLimit: 60000,
    onPart: async (p) => { blobs.push(p.blob); handed.push(p); } });
  assert.deepEqual(r.parts.map((p) => p.name), ["d-part1.zip", "d-part2.zip"]);
  const [text, manifestPart] = await unzip(blobs.map((blob) => ({ blob })));
  assert.deepEqual(Object.keys(text), ["d.json", "index.html"]);
  assert.deepEqual(Object.keys(manifestPart), ["discord-attachments.json"]);
  assert.equal(r.saved, 0);
});

test("a handed-off part's blob is released once its download is done, mid-build", async () => {
  const big = "x".repeat(40000);
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: big, [`${CDN}/11/gone.mp4`]: big, [`${CDN}/12/f.ogg`]: big });
  const handed = [];
  let seenReleased = null;
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, gap: 0, partLimit: 60000,
    onPart: async (p) => {
      // while part 3's download runs, parts 1 and 2 must already be out of the build's hands
      if (p.index === 3) seenReleased = handed[0].blob === null && handed[1].blob === null;
      handed.push(p);
    } });
  assert.equal(seenReleased, true, "earlier parts were released while a later one downloaded");
  assert.ok(handed.every((p) => p.blob === null));
  assert.ok(r.parts.every((p) => !("blob" in p)));
});

test("onPart false stops the save: nothing downloads after the failed part, the manifest lists the rest", async () => {
  const big = "x".repeat(40000);
  const fetchFn = fakeFetch({ [`${CDN}/10/cat.png`]: big, [`${CDN}/11/gone.mp4`]: big, [`${CDN}/12/f.ogg`]: big });
  const blobs = [], handed = [];
  // three fetches in flight when part 2 fails: the counts below are for that timing
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, gap: 0, concurrency: 3, partLimit: 60000,
    onPart: async (p) => { blobs.push(p.blob); handed.push(p); return p.index !== 2; } });
  // part 1 (text) + part 2 (the failed one) + the manifest part; the half-filled part is
  // discarded, so nothing after part 2 comes out — and part 3 is the manifest, not files
  assert.deepEqual(r.parts.map((p) => [p.name, p.index]),
    [["d-part1.zip", 1], ["d-part2.zip", 2], ["d-part3.zip", 3]]);
  const [text, , manifestPart] = await unzip(blobs.map((blob) => ({ blob })));
  assert.deepEqual(Object.keys(text), ["d.json", "index.html"]);
  assert.deepEqual(Object.keys(manifestPart), ["discord-attachments.json"]);
  const manifest = JSON.parse(manifestPart["discord-attachments.json"]);
  // zipcheck reads zip contents as latin-1, so the em-dashes in the markers arrive
  // mangled; the ASCII prefixes pin them
  const inFailedPart = manifest.filter((m) => (m.error || "").startsWith("saved into part 2"));
  assert.equal(inFailedPart.length, 1, "the failed part's file is named by part");
  const unsaved = manifest.filter((m) => (m.error || "").startsWith("not saved"));
  assert.equal(unsaved.length, 2, "everything not in a downloaded part is listed unsaved");
  assert.equal(r.saved, 0);
  assert.equal(r.failed.length, 4);
});

test("a fetch in flight when the save stops still counts as failed", async () => {
  const big = "x".repeat(40000);
  let release404;
  const slow404 = new Promise((r) => { release404 = r; });
  const fetchFn = async (url) => {
    const u = url.split("?")[0];
    if (u === `${CDN}/11/gone.mp4`) { await slow404; return new Response("", { status: 404 }); }
    const v = { [`${CDN}/10/cat.png`]: big, [`${CDN}/12/f.ogg`]: big }[u];
    if (v === undefined) throw new TypeError("Failed to fetch");
    return new Response(v, { status: 200, headers: { "content-length": String(Buffer.byteLength(v)) } });
  };
  const blobs = [];
  const r = await build(exp(), { file: "d.json", fetchFn, wait: 0, gap: 0, partLimit: 60000,
    onPart: async (p) => {
      blobs.push(p.blob);
      if (p.index !== 2) return true;
      // gone's 404 must land after the stop: release it here, with no await before
      // the false comes back, so the stop is already set when the fetch resumes
      release404();
      return false;
    } });
  // cat alone is packed into part 2, whose download failed and stopped the save; f.ogg's
  // add is what seals part 2, so f.ogg sits in the half-filled part 3 that the stop
  // discards; gone's 404 lands after that stop and must still count as failed; evil
  // can't be fetched. The manifest still goes out and names every file's fate.
  assert.equal(r.saved, 0);
  assert.equal(r.failed.length, 4);
  assert.equal(r.records.find((m) => m.filename === "gone.mp4").error, "link expired or gone (HTTP 404)");
  // records are in-process, so unlike the unzipped-manifest asserts below these can
  // pin the full strings, em-dashes included
  assert.equal(r.records.find((m) => m.filename === "cat pic.png").error,
    "saved into part 2, which didn't finish downloading — retry part 2 in the export tab if it's still open, otherwise save again to get this file");
  assert.equal(r.records.find((m) => m.filename === "cat pic.png").failedPart, 2);
  assert.equal(r.records.find((m) => m.filename === "f.ogg").error, "not saved — the save stopped early");
  assert.equal(r.records.find((m) => m.filename === "f.ogg").failedPart, undefined, "in no part at all");
  // f.ogg is in no part, so retrying part 2 can't complete this save
  assert.equal(r.leftBehind, 1);
  assert.deepEqual(r.parts.map((p) => [p.name, p.index]),
    [["d-part1.zip", 1], ["d-part2.zip", 2], ["d-part3.zip", 3]]);
  const [text, , manifestPart] = await unzip(blobs.map((blob) => ({ blob })));
  assert.deepEqual(Object.keys(text), ["d.json", "index.html"]);
  assert.deepEqual(Object.keys(manifestPart), ["discord-attachments.json"]);
  const manifest = JSON.parse(manifestPart["discord-attachments.json"]);
  // zipcheck reads zip contents as latin-1, so the em-dashes in the markers arrive
  // mangled; the ASCII prefixes pin them
  const inFailedPart = manifest.filter((m) => (m.error || "").startsWith("saved into part 2"));
  assert.equal(inFailedPart.length, 1, "the failed part's file is named by part");
  assert.ok(manifest.every((m) => !("failedPart" in m)), "the manifest says it in words only");
  const unsaved = manifest.filter((m) => (m.error || "").startsWith("not saved"));
  assert.equal(unsaved.length, 1, "the file that triggered the seal sat in the discarded half-filled part");
});

test("streamed hand-offs gate the fetches: a failing worker waits, it does not churn on", async () => {
  const big = "x".repeat(40000);
  let fetches = 0;
  const table = { [`${CDN}/1/f.png`]: big, [`${CDN}/2/f.png`]: big };
  const fetchFn = async (url) => {
    fetches++;
    const v = table[url.split("?")[0]];
    if (v === undefined) return new Response("", { status: 404 });
    return new Response(v, { status: 200, headers: { "content-length": String(Buffer.byteLength(v)) } });
  };
  // f1 and f2 fill part 2; every record after is a 404, and a worker holding one skips the
  // post-add drain — only the top-of-loop gate stops it from churning through the rest
  // while part 2's download is held
  const many = exp();
  many.messages = Array.from({ length: 30 }, (_, k) => ({ id: String(k + 1),
    datetime: `2021-01-01T10:${String(k).padStart(2, "0")}:00.000Z`,
    attachments: [{ filename: `f${k + 1}.png`, url: `${CDN}/${k + 1}/f.png` }] }));
  let release;
  const gate = new Promise((r) => { release = r; });
  let reachedGate;
  const reached = new Promise((r) => { reachedGate = r; });
  const building = build(many, { file: "d.json", fetchFn, wait: 0, gap: 0, partLimit: 60000,
    onPart: async (p) => { if (p.index === 2) { reachedGate(); await gate; } } });
  await reached;   // part 2 sealed and its hand-off is gated
  // the initial workers (two by default), plus the handful one may have churned before the gate
  // landed; ungated, the 404 workers would run through all 30 records
  assert.ok(fetches <= 10, `fetches stalled near the initial workers (got ${fetches})`);
  release();
  await building;
});

test("streamed gate: a worker waking at the gate after others claimed the last record stops cleanly", async () => {
  const four = exp();
  four.messages = Array.from({ length: 4 }, (_, k) => ({
    id: String(k + 1),
    datetime: `2021-01-01T10:0${k}:00.000Z`,
    attachments: [{ filename: `f${k + 1}.bin`, url: `${CDN}/${k + 1}/f.bin` }],
  }));
  const payload = "x".repeat(15000);
  const blobs = [];
  const r = await build(four, {
    file: "d.json",
    partLimit: 20000,
    concurrency: 3,
    wait: 0, gap: 0,
    fetchFn: async () => new Response(payload, { status: 200, headers: { "content-length": "15000" } }),
    onPart: async (p) => {
      blobs.push(p.blob);
      await new Promise((res) => setTimeout(res, 20));
    },
  });
  assert.equal(r.saved, 4);
  assert.equal(r.failed.length, 0);
  const lastPart = (await unzip([{ blob: blobs[blobs.length - 1] }]))[0];
  assert.deepEqual(Object.keys(lastPart), ["discord-attachments.json"]);
});

test("a dead link answering while a part downloads parks its worker at the gate; the save still finishes", async () => {
  const five = exp();
  five.messages = Array.from({ length: 5 }, (_, k) => ({
    id: String(k + 1),
    datetime: `2021-01-01T10:0${k}:00.000Z`,
    attachments: [{ filename: `f${k + 1}.bin`, url: `${CDN}/${k + 1}/f.bin` }],
  }));
  const payload = "x".repeat(15000);
  // every fetch answers when the test says, and part 2's download is held until the test
  // lets it go, so the steps below happen in this order whatever the machine's speed
  const answer = {}, asked = [];
  const fetchFn = (url) => {
    const k = Number(url.split("/")[5]);
    asked.push(k);
    return new Promise((res) => { answer[k] = res; });
  };
  const ok = (k) => answer[k](new Response(payload, { status: 200, headers: { "content-length": "15000" } }));
  const dead = (k) => answer[k](new Response("", { status: 403 }));
  let letPart2Go;
  const part2Held = new Promise((res) => { letPart2Go = res; });
  const names = [];
  let fetched = 0, packed = 0;
  const building = build(five, {
    file: "d.json",
    partLimit: 20000,
    concurrency: 3,
    wait: 0, gap: 0,
    fetchFn,
    onProgress: ({ phase, done }) => { if (phase === "fetch") fetched = done; else packed = done; },
    onPart: async (p) => {
      names.push(p.name);
      if (p.index === 2) await part2Held;
    },
  });
  // the build's own steps run on promise callbacks; this waits them out, never a clock
  const until = async (cond, what) => {
    for (let i = 0; i < 1000 && !cond(); i++) await new Promise((res) => setImmediate(res));
    assert.ok(cond(), `never got to: ${what}`);
  };
  await until(() => asked.length === 3, "three workers fetching");
  ok(1);
  await until(() => asked.includes(4), "file 1 packed, its worker on to file 4");
  ok(2);   // file 2 doesn't fit beside file 1: part 2 seals, and its download is held
  await until(() => names.length === 2, "part 2 handed over");
  dead(3); // the dead link skips the packing path, so its worker goes straight to the gate
  // the count and the gate come in one step, so once file 3 is counted its worker is parked
  await until(() => fetched === 2, "file 3 counted");
  assert.deepEqual(asked, [1, 2, 3, 4], "parked at the gate with file 5 still unclaimed");
  ok(4);   // file 4 seals file 2's part behind part 2's held download
  await until(() => packed === 3, "file 4 packed");
  letPart2Go();
  await until(() => asked.length === 5, "file 5 claimed once the gate opens");
  ok(5);
  const r = await building;
  assert.equal(r.saved, 4);
  assert.deepEqual(r.failed.map((rec) => [rec.filename, rec.error]), [["f3.bin", "link expired or gone (HTTP 403)"]]);
  assert.deepEqual(names, r.parts.map((p) => p.name));
  assert.equal(r.leftBehind, 0);
});

test("streamed build records a duplicate zip entry name on that record instead of rejecting the build", async () => {
  const dup = exp();
  dup.messages = [
    { id: "10", datetime: "2021-01-01T10:00:00.000Z", attachments: [{ filename: "same.png", url: `${CDN}/10/same.png` }] },
    { id: "10", datetime: "2021-01-01T10:00:00.000Z", attachments: [{ filename: "same.png", url: `${CDN}/10/same.png` }] },
  ];
  const blobs = [];
  const r = await build(dup, {
    file: "d.json",
    fetchFn: fakeFetch({ [`${CDN}/10/same.png`]: "PNGDATA" }),
    wait: 0, gap: 0,
    onPart: async (p) => { blobs.push(p.blob); },
  });
  assert.equal(r.saved, 1);
  assert.equal(r.failed.length, 1);
  const bad = r.records.filter((rec) => (rec.error || "").startsWith("couldn't be added to the zip:"));
  assert.equal(bad.length, 1);
  const lastPart = (await unzip([{ blob: blobs[blobs.length - 1] }]))[0];
  assert.deepEqual(Object.keys(lastPart), ["discord-attachments.json"]);
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

test("the page renders Discord's markdown subset while keeping code and edge cases literal", () => {
  const d = exp();
  d.messages = [
    {
      id: "20", datetime: "2021-01-01T10:00:00.000Z", author: "Alice", author_id: "1",
      text: "a **bold** *star* _under_ __line__ ~~strike~~ ***both*** ||<secret> *ok*|| snake_case_name **unclosed `*not italic*`",
      attachments: [], embeds: [],
    },
    {
      id: "21", datetime: "2021-01-01T10:01:00.000Z", author: "Bob", author_id: "2",
      text: [
        "# Head 1",
        "## Head 2",
        "### Head 3",
        "-# tiny note",
        "> quoted **bold**",
        "> second line",
        "- item a",
        "  - nested b",
        "1. first",
        "  1. sub first",
        ">>> rest of",
        "the message",
      ].join("\n"),
      attachments: [], embeds: [],
    },
  ];
  const html = render(d, [], { timeZone: "UTC" });
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>star</em>") && html.includes("<em>under</em>"));
  assert.ok(html.includes("<u>line</u>") && html.includes("<s>strike</s>"));
  assert.ok(html.includes("<strong><em>both</em></strong>"));
  assert.ok(html.includes('<span class="spoiler" onclick="this.classList.add(\'open\')">&lt;secret&gt; <em>ok</em></span>'));
  assert.ok(html.includes("snake_case_name **unclosed <code>*not italic*</code>"));
  assert.ok(html.includes('<h3 class="md-h1">Head 1</h3>'));
  assert.ok(html.includes('<h4 class="md-h2">Head 2</h4>'));
  assert.ok(html.includes('<h5 class="md-h3">Head 3</h5>'));
  assert.ok(html.includes('<div class="md-sub">tiny note</div>'));
  assert.ok(html.includes('<blockquote class="md-quote">quoted <strong>bold</strong><br>second line</blockquote>'));
  assert.ok(html.includes("<ul><li>item a<ul><li>nested b</li></ul></li></ul>"));
  assert.ok(html.includes("<ol><li>first<ol><li>sub first</li></ol></li></ol>"));
  assert.ok(html.includes('<blockquote class="md-quote">rest of<br>the message</blockquote>'));
  assert.ok(![...html.matchAll(/\ssrc="([^"]+)"/g)].some(([, s]) => /^https?:/.test(s)));
});

test("review follow-ups: sentinels, unclosed fences, bold links, CRLF, list type switch", () => {
  const d = exp();
  const one = (text) => {
    d.messages = [{ id: "30", datetime: "2021-01-01T10:00:00.000Z", author: "A", author_id: "1", text, attachments: [], embeds: [] }];
    return render(d, [], { timeZone: "UTC" });
  };
  // U+0001/U+0002 are internal placeholders; a message's own ones are stripped, never restored
  const sent = one("a \x01 42 \x02 b");
  assert.ok(sent.includes("a  42  b") && !sent.includes("undefined"));
  // an unclosed fence is closed, its tail stays code
  const unclosed = one("```js\nlet a = 1;\n# not a heading");
  assert.ok(unclosed.includes("# not a heading</pre>") && !unclosed.includes('<h3 class="md-h1">'));
  // bold around a link: the closers are trimmed off the URL and pair with the opener
  const boldLink = one("**see https://example.com/x**");
  assert.ok(boldLink.includes('<strong>see <a href="https://example.com/x">https://example.com/x</a></strong>'));
  // CRLF line endings break lines like LF ones
  assert.ok(one("# Head\r\nnext").includes('<h3 class="md-h1">Head</h3>'));
  // a ul switching to an ol at the same level makes sibling lists, not nesting
  assert.ok(one("- a\n1. b").includes("<ul><li>a</li></ul><ol><li>b</li></ol>"));
});

test("ordered list start numbers, backslash escapes, backtick-bounded URLs, single-line fences and escaped note counts", () => {
  const d = exp();
  const one = (text) => {
    d.messages = [{ id: "30", datetime: "2021-01-01T10:00:00.000Z", author: "A", author_id: "1", text, attachments: [], embeds: [] }];
    return render(d, [], { timeZone: "UTC" });
  };
  assert.ok(one("1998. what a year").includes('<div class="text"><ol start="1998"><li>what a year</li></ol></div>'));
  assert.ok(one("3. three\n4. four").includes('<div class="text"><ol start="3"><li>three</li><li>four</li></ol></div>'));
  assert.ok(one("1. a").includes('<div class="text"><ol><li>a</li></ol></div>'));
  assert.ok(one("0. a").includes('<div class="text"><ol start="0"><li>a</li></ol></div>'));
  assert.ok(one("- a\n  2. b").includes("<ul><li>a<ol start=\"2\"><li>b</li></ol></li></ul>"));
  assert.ok(one("- a\n2. b").includes("<ul><li>a</li></ul><ol start=\"2\"><li>b</li></ol>"));
  assert.ok(one("\\*x\\*").includes('<div class="text">*x*</div>'));
  assert.ok(one("\\_x\\_").includes('<div class="text">_x_</div>'));
  assert.ok(one("\\||s\\||").includes('<div class="text">||s||</div>'));
  assert.ok(one("\\\\").includes('<div class="text">\\</div>'));
  assert.ok(one("C:\\Users").includes('<div class="text">C:\\Users</div>'));
  assert.ok(one("`\\*`").includes('<div class="text"><code>\\*</code></div>'));
  assert.ok(one("see https://x.com/a`b`").includes('<div class="text">see <a href="https://x.com/a">https://x.com/a</a><code>b</code></div>'));
  assert.ok(one("```hello\n```").includes('<div class="text"><pre>hello\n</pre></div>'));
  assert.ok(one("```hello\nworld```").includes('<div class="text"><pre>world</pre></div>'));
  const notesExp = exp();
  notesExp.hidden_groups = { not_opened: "<b>1</b>" };
  notesExp.forwards_without_snapshot = "<script>2</script>";
  const notesHtml = render(notesExp, [], { timeZone: "UTC" });
  assert.ok(notesHtml.includes("&lt;b&gt;1&lt;/b&gt; group(s)") && !notesHtml.includes("<b>1</b>"));
  assert.ok(notesHtml.includes("&lt;script&gt;2&lt;/script&gt; forwarded") && !notesHtml.includes("<script>2</script>"));
});

test("attachments are fetched two at a time by default, each worker resting between files", async () => {
  const six = exp();
  six.messages = Array.from({ length: 6 }, (_, k) => ({
    id: String(k + 1), datetime: `2021-01-01T10:0${k}:00.000Z`,
    attachments: [{ filename: `f${k + 1}.bin`, url: `${CDN}/${k + 1}/f.bin` }],
  }));
  let inFlight = 0, most = 0;
  const starts = [];
  const fetchFn = async () => {
    starts.push(Date.now());
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response("data", { status: 200 });
  };
  const rests = [];
  const r = await build(six, { file: "d.json", fetchFn, wait: 0, gap: () => { rests.push(1); return 40; } });
  assert.equal(r.failed.length, 0);
  assert.equal(most, 2);
  // a rest before every file but each worker's first: 6 files, 2 workers
  assert.equal(rests.length, 4);
  // with the rests, the six requests span at least two rests per worker
  assert.ok(starts.at(-1) - starts[0] >= 2 * 40 - 5, `requests spread over ${starts.at(-1) - starts[0]} ms`);
});

test("the default rest between files is 0.5-1 s", () => {
  for (let i = 0; i < 200; i++) {
    const ms = restBetweenFiles();
    assert.ok(ms >= 500 && ms < 1000, String(ms));
  }
});

test("with no gap given, a worker rests at least half a second between files", async () => {
  const two = exp();
  two.messages = [1, 2].map((k) => ({ id: String(k), datetime: `2021-01-01T10:0${k}:00.000Z`,
    attachments: [{ filename: `f${k}.bin`, url: `${CDN}/${k}/f.bin` }] }));
  const starts = [];
  const fetchFn = async () => { starts.push(Date.now()); return new Response("data", { status: 200 }); };
  const r = await build(two, { file: "d.json", fetchFn, wait: 0, concurrency: 1 });
  assert.equal(r.failed.length, 0);
  assert.ok(starts[1] - starts[0] >= 490, `second file started ${starts[1] - starts[0]} ms after the first`);
});

test("a worker that rests past the last file stops there: an odd count with two workers", async () => {
  const three = exp();
  three.messages = [1, 2, 3].map((k) => ({ id: String(k), datetime: `2021-01-01T10:0${k}:00.000Z`,
    attachments: [{ filename: `f${k}.bin`, url: `${CDN}/${k}/f.bin` }] }));
  let calls = 0;
  const fetchFn = async () => { calls++; return new Response("data", { status: 200 }); };
  const r = await build(three, { file: "d.json", fetchFn, wait: 0, gap: 20 });
  assert.equal(r.failed.length, 0);
  assert.equal(calls, 3);
});

test("a stop landing during a worker's rest ends it: it wakes, sees the stop, fetches nothing more", async () => {
  const big = "x".repeat(40000);
  const four = exp();
  four.messages = [1, 2, 3, 4].map((k) => ({ id: String(k), datetime: `2021-01-01T10:0${k - 1}:00.000Z`,
    attachments: [{ filename: `f${k}.bin`, url: `${CDN}/${k}/f.bin` }] }));
  const fetched = [];
  const fetchFn = async (url) => {
    fetched.push(url.split("?")[0]);
    return new Response(big, { status: 200, headers: { "content-length": String(Buffer.byteLength(big)) } });
  };
  // both workers fetch in parallel; the second add is what seals part 2 (around the
  // first file), and its hand-off returns false. By then the other worker is inside its
  // post-add rest, so the stop lands mid-rest: it must wake, see the stop, and claim
  // nothing more. Its own file sits in the discarded half-filled part, so only the file
  // inside the handed part counts as saved.
  // The stop checks live in three places (the worker's while condition, the post-rest
  // break, the streamed-gate break), so this pins the invariant — no claim once the stop
  // has landed — not any one line: killing all three reddens it, each alone stays green.
  const handed = [];
  const r = await build(four, { file: "d.json", fetchFn, wait: 0, gap: 250, partLimit: 60000, concurrency: 2,
    onPart: async (p) => { handed.push(p.index); return p.index !== 2; } });
  assert.deepEqual(handed, [1, 2, 3], "text, the part whose hand-off stopped the save, then the manifest");
  assert.deepEqual(fetched.slice().sort(), [`${CDN}/1/f.bin`, `${CDN}/2/f.bin`],
    "only the first two files were fetched; the resting worker claimed no more");
  // which of the two fetched files sits in part 2 follows the add race; either way that
  // part's hand-off said false, so nothing counts as saved (as in the onPart-false test)
  assert.equal(r.saved, 0);
  assert.equal(r.failed.length, 4);
  assert.equal(r.leftBehind, 3);
  assert.equal(r.records.filter((m) => m.failedPart === 2).length, 1,
    "the file inside the refused part is named by part, retryable there");
  for (const name of ["f3.bin", "f4.bin"]) {
    assert.equal(r.records.find((m) => m.filename === name).error, "not saved — the save stopped early");
    assert.equal(r.records.find((m) => m.filename === name).failedPart, undefined, `${name} is in no part`);
  }
});

test("a stop landing while a worker parks at the streamed gate ends it: it claims nothing more", async () => {
  const big = "x".repeat(40000);
  const four = exp();
  four.messages = [1, 2, 3, 4].map((k) => ({ id: String(k), datetime: `2021-01-01T10:0${k - 1}:00.000Z`,
    attachments: [{ filename: `f${k}.bin`, url: `${CDN}/${k}/f.bin` }] }));
  const fetched = [];
  let releaseFirst, releasePart2;
  const firstHeld = new Promise((r) => { releaseFirst = r; });
  const part2Held = new Promise((r) => { releasePart2 = r; });
  let reachedPart2;
  const reached = new Promise((r) => { reachedPart2 = r; });
  const fetchFn = async (url) => {
    const u = url.split("?")[0];
    fetched.push(u);
    if (u === `${CDN}/1/f.bin`) await firstHeld;   // worker 1 parks in this fetch the whole time
    return new Response(big, { status: 200, headers: { "content-length": String(Buffer.byteLength(big)) } });
  };
  // gap 0 as a function, exercising that branch: no rests anywhere. Worker 1 parks in its
  // gated f1 fetch; worker 2 claims f2, whose add fills part 2, then claims f3, whose add
  // seals part 2 — and parks inside the held hand-off at the streamed gate. Releasing it
  // lands the stop while worker 2 sits in drain(); only then f1 is released, too late to
  // be added. Neither worker may claim f4. (The same three-layer note as the rest test;
  // with gap 0 the rest break never fires, so here the while and gate breaks enforce.)
  const handed = [];
  const building = build(four, { file: "d.json", fetchFn, wait: 0, gap: () => 0, partLimit: 60000, concurrency: 2,
    onPart: async (p) => {
      handed.push(p.index);
      if (p.index === 2) { reachedPart2(); await part2Held; return false; }
      return true;
    } });
  await reached;          // worker 2 is parked inside the held hand-off
  releasePart2();         // the hand-off says false: the stop lands while it is parked
  await new Promise((r) => setTimeout(r, 0));   // let the stop flush before f1 resolves
  releaseFirst();
  const r = await building;
  assert.deepEqual(handed, [1, 2, 3], "text, the refused part, then the manifest");
  assert.deepEqual(fetched.slice().sort(), [`${CDN}/1/f.bin`, `${CDN}/2/f.bin`, `${CDN}/3/f.bin`],
    "f4 was never claimed, least of all by the worker parked at the gate");
  assert.equal(r.saved, 0);
  assert.equal(r.failed.length, 4);
  assert.equal(r.leftBehind, 3);
  assert.equal(r.records.find((m) => m.filename === "f2.bin").failedPart, 2,
    "part 2 held f2 alone, and its refusal names it");
  for (const name of ["f1.bin", "f3.bin", "f4.bin"]) {
    assert.equal(r.records.find((m) => m.filename === name).error, "not saved — the save stopped early");
    assert.equal(r.records.find((m) => m.filename === name).failedPart, undefined, `${name} is in no part`);
  }
});
