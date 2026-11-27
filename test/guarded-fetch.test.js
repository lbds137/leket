// guardedFetch (TASK-40): the CLI's image fetch refuses a name whose DNS answer is a local
// or private-network address, before connecting; a public answer is fetched as fetch()
// would, redirects unfollowed. DNS is stood in for, and the server is a local https one
// with a throwaway certificate, so nothing here leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { brotliCompressSync, createDeflate, createGzip, deflateRawSync, deflateSync, gzipSync } from "node:zlib";

import { guardedFetch, LEKET_UA, makeLookup } from "../src/lib/guarded-fetch.js";
import { fetchImageData } from "../src/modules/reddit/prepare.js";
import { postPage } from "./fixtures/reddit.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const tmp = () => mkdtempSync(join(tmpdir(), "leket-guard-"));

// a resolver answering every name with `answers`, as dns.lookup(name, {all: true}) does
const answering = (...answers) => (name, opts, cb) => cb(null, answers);
const lookupOf = (resolve, all) => new Promise((res) => makeLookup(resolve)("img.example", { all }, (...args) => res(args)));

test("lookup: a private answer (v4, v6, v4-mapped, or one of several) is refused; public answers pass", async () => {
  for (const a of [
    { address: "127.0.0.1", family: 4 }, { address: "10.1.2.3", family: 4 }, { address: "192.168.0.9", family: 4 },
    { address: "::1", family: 6 }, { address: "fd00::1", family: 6 }, { address: "::ffff:127.0.0.1", family: 6 },
  ]) {
    const [err] = await lookupOf(answering(a), true);
    assert.equal(err && err.code, "EPRIVATEADDR", a.address);
    assert.match(err.message, new RegExp(`img\\.example resolves to a local or private-network address \\(${a.address.replace(/\./g, "\\.")}\\)`));
  }
  const pub4 = { address: "151.101.1.140", family: 4 }, pub6 = { address: "2a04:4e42::396", family: 6 };
  const [mixedErr] = await lookupOf(answering(pub4, { address: "10.0.0.1", family: 4 }), true);
  assert.equal(mixedErr.code, "EPRIVATEADDR", "one private answer among public ones refuses the name");
  assert.deepEqual(await lookupOf(answering(pub4, pub6), true), [null, [pub4, pub6]]);
  assert.deepEqual(await lookupOf(answering(pub6, pub4), false), [null, pub6.address, 6]);
  const nx = Object.assign(new Error("getaddrinfo ENOTFOUND img.example"), { code: "ENOTFOUND" });
  assert.deepEqual(await lookupOf((n, o, cb) => cb(nx), true), [nx]);
  // an empty answer list is "not found", not a crash
  const [empty] = await lookupOf(answering(), false);
  assert.equal(empty.code, "ENOTFOUND");
});

test("guardedFetch: a private IP literal is refused by itself (net.connect skips the lookup for one)", async () => {
  for (const url of ["https://127.0.0.1/a.png", "https://[::1]/a.png", "https://10.0.0.5:8443/a.png"]) {
    await assert.rejects(guardedFetch(url), (e) => e.code === "EPRIVATEADDR" && /is a local or private-network address/.test(e.message), url);
  }
});

test("guardedFetch: a private answer fails before any connection", async () => {
  let connected = 0;
  const server = createServer((req, res) => { connected++; res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `https://img.example:${server.address().port}/a.png`;
    await assert.rejects(guardedFetch(url, { lookup: makeLookup(answering({ address: "127.0.0.1", family: 4 })) }),
      (e) => e.code === "EPRIVATEADDR");
    assert.equal(connected, 0);
  } finally {
    server.close();
  }
});

// a self-signed certificate for img.example, made fresh for the run
function certificate() {
  const dir = tmp();
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=img.example",
    "-addext", "subjectAltName=DNS:img.example", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { encoding: "utf8" });
  assert.equal(r.status, 0, `openssl is needed for this test: ${r.stderr || r.error}`);
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

test("guardedFetch: a public answer is fetched as a Response; a redirect and a 204 come back unfollowed", async () => {
  const tls = certificate();
  const server = createServer(tls, (req, res) => {
    if (req.url === "/a.png") { res.writeHead(200, { "content-type": "image/png", "set-cookie": ["a=1", "b=2"] }); res.end(Buffer.from([1, 2, 3])); }
    else if (req.url === "/moved") { res.writeHead(302, { location: "https://elsewhere.example/x" }); res.end("moved"); }
    else { res.writeHead(204); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // the stand-in DNS sends img.example to this server, past the guard: the guard is the
  // test above; this one pins what a fetched answer looks like
  const direct = (name, opts, cb) => (opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
  const base = `https://img.example:${server.address().port}`;
  try {
    const r = await guardedFetch(`${base}/a.png`, { lookup: direct, ca: tls.cert });
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([1, 2, 3]));
    const moved = await guardedFetch(`${base}/moved`, { lookup: direct, ca: tls.cert });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get("location"), "https://elsewhere.example/x");
    await moved.body.cancel();
    const empty = await guardedFetch(`${base}/none`, { lookup: direct, ca: tls.cert });
    assert.equal(empty.status, 204);
    assert.equal(empty.body, null);
  } finally {
    server.close();
  }
});

test("guardedFetch: it says who it is and asks for the bytes as they are; a compressed answer is decoded, an unknown encoding refused", async () => {
  const tls = certificate();
  let asked;
  const server = createServer(tls, (req, res) => {
    asked = req.headers;
    if (req.url === "/gz.png") {
      const gz = gzipSync(Buffer.from([4, 5, 6]));
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip", "content-length": String(gz.length) });
      res.end(gz);
    }
    // an encoding named like an Object.prototype property
    else if (req.url === "/proto.png") { res.writeHead(200, { "content-type": "image/png", "content-encoding": "constructor" }); res.end("??"); }
    else if (req.url === "/br.png") { res.writeHead(200, { "content-type": "image/png", "content-encoding": "br" }); res.end(brotliCompressSync(Buffer.from([7, 8]))); }
    else if (req.url === "/deflate.png") { res.writeHead(200, { "content-type": "image/png", "content-encoding": "deflate" }); res.end(deflateSync(Buffer.from([9, 10]))); }
    else if (req.url === "/deflate-w9.png") {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "deflate" });
      const z = createDeflate({ windowBits: 9 });
      z.pipe(res);
      z.end("small window");
    }
    else if (req.url === "/deflate-1b.png") {
      const z = deflateSync(Buffer.from("one byte first"));
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "deflate" });
      res.write(z.subarray(0, 1));
      setTimeout(() => res.end(z.subarray(1)), 15);
    }
    else if (req.url === "/deflate-raw.png") { res.writeHead(200, { "content-type": "image/png", "content-encoding": "deflate" }); res.end(deflateRawSync(Buffer.from([11, 12]))); }
    else if (req.url === "/corrupt-gz.png") { res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" }); res.end(Buffer.from("not gzipped at all")); }
    else if (req.url === "/corrupt-deflate.png") { res.writeHead(200, { "content-type": "image/png", "content-encoding": "deflate" }); res.end(Buffer.from("not deflated at all")); }
    else if (req.url === "/trunc-gz.png") {
      // a connection cut before the body completes: the response errors, the body never finishes
      const gz = gzipSync(Buffer.from([13, 14]));
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip", "content-length": String(gz.length + 20) });
      res.write(gz.subarray(0, gz.length - 2));
      setTimeout(() => res.destroy(), 25);
    }
    else if (req.url === "/trunc-deflate.png") {
      const def = deflateSync(Buffer.from([13, 14]));
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "deflate", "content-length": String(def.length + 20) });
      res.write(def.subarray(0, def.length - 2));
      setTimeout(() => res.destroy(), 25);
    }
    else if (req.url === "/zz.png") { res.writeHead(200, { "content-type": "image/png", "content-encoding": "zz" }); res.end("??"); }
    else { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from([1])); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const direct = (name, opts, cb) => (opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
  const base = `https://img.example:${server.address().port}`;
  try {
    await (await guardedFetch(`${base}/a.png`, { lookup: direct, ca: tls.cert })).arrayBuffer();
    // some hosts answer a request with no User-Agent with 403
    assert.equal(asked["user-agent"], LEKET_UA);
    assert.equal(asked["accept-encoding"], "identity");
    assert.equal(asked.accept, "*/*");
    // Headers instances and arrays of pairs reach the request
    await (await guardedFetch(`${base}/a.png`, { lookup: direct, ca: tls.cert, headers: new Headers({ "x-custom": "from-headers" }) })).arrayBuffer();
    assert.equal(asked["x-custom"], "from-headers");
    await (await guardedFetch(`${base}/a.png`, { lookup: direct, ca: tls.cert, headers: [["x-pair", "from-pairs"]] })).arrayBuffer();
    assert.equal(asked["x-pair"], "from-pairs");
    const gz = await guardedFetch(`${base}/gz.png`, { lookup: direct, ca: tls.cert });
    assert.deepEqual(new Uint8Array(await gz.arrayBuffer()), new Uint8Array([4, 5, 6]));
    assert.equal(gz.headers.get("content-encoding"), null, "the headers describe the decoded bytes");
    assert.equal(gz.headers.get("content-length"), null, "the compressed length isn't the decoded one");
    await assert.rejects(guardedFetch(`${base}/proto.png`, { lookup: direct, ca: tls.cert }),
      (e) => e.code === "EENCODING" && /encoded as constructor/.test(e.message));
    const br = await guardedFetch(`${base}/br.png`, { lookup: direct, ca: tls.cert });
    assert.deepEqual(new Uint8Array(await br.arrayBuffer()), new Uint8Array([7, 8]));
    const def = await guardedFetch(`${base}/deflate.png`, { lookup: direct, ca: tls.cert });
    assert.deepEqual(new Uint8Array(await def.arrayBuffer()), new Uint8Array([9, 10]));
    const defW9 = await guardedFetch(`${base}/deflate-w9.png`, { lookup: direct, ca: tls.cert });
    assert.equal(await defW9.text(), "small window");
    const def1b = await guardedFetch(`${base}/deflate-1b.png`, { lookup: direct, ca: tls.cert });
    assert.equal(await def1b.text(), "one byte first");
    const defRaw = await guardedFetch(`${base}/deflate-raw.png`, { lookup: direct, ca: tls.cert });
    assert.deepEqual(new Uint8Array(await defRaw.arrayBuffer()), new Uint8Array([11, 12]));
    const badGz = await guardedFetch(`${base}/corrupt-gz.png`, { lookup: direct, ca: tls.cert });
    await assert.rejects(badGz.arrayBuffer(), (e) => e.code === "EDECODE" && e.coding === "gzip");
    const badDef = await guardedFetch(`${base}/corrupt-deflate.png`, { lookup: direct, ca: tls.cert });
    await assert.rejects(badDef.arrayBuffer(), (e) => e.code === "EDECODE" && e.coding === "deflate");
    // a cut connection is not a corrupt body: the wrapped upstream error carries no EDECODE tag
    const trunc = await guardedFetch(`${base}/trunc-gz.png`, { lookup: direct, ca: tls.cert });
    await assert.rejects(trunc.arrayBuffer(), (e) => e.code === "ECONNRESET" && !/corrupt/.test(e.message));
    const truncDef = await guardedFetch(`${base}/trunc-deflate.png`, { lookup: direct, ca: tls.cert });
    await assert.rejects(truncDef.arrayBuffer(), (e) => e.code === "ECONNRESET" && !/corrupt/.test(e.message));
    await assert.rejects(guardedFetch(`${base}/zz.png`, { lookup: direct, ca: tls.cert }),
      (e) => e.code === "EENCODING" && /not fetched: the server sent it encoded as zz/.test(e.message));
    // fetchImageData passes that refusal on as its own reason, not "couldn't reach it"
    const viaImage = (url, opts) => guardedFetch(url, { ...opts, lookup: direct, ca: tls.cert });
    await assert.rejects(fetchImageData({ n: 1, u: `${base}/zz.png`, ext: "" }, { fetch: viaImage }),
      { message: "not fetched: the server sent it encoded as zz" });
    await assert.rejects(fetchImageData({ n: 1, u: `${base}/corrupt-gz.png`, ext: "" }, { fetch: viaImage }),
      (e) => /^couldn't read it \(the server sent it encoded as gzip, but the body is corrupt: .+\)$/.test(e.message));
    await assert.rejects(fetchImageData({ n: 1, u: `${base}/corrupt-deflate.png`, ext: "" }, { fetch: viaImage }),
      (e) => /^couldn't read it \(the server sent it encoded as deflate, but the body is corrupt: .+\)$/.test(e.message));
  } finally {
    server.close();
  }
});

test("guardedFetch: cancelling a compressed answer mid-read closes the connection, as cancelling a plain one does", async () => {
  const tls = certificate();
  for (const [coding, makeStream] of [["gzip", createGzip], ["deflate", createDeflate]]) {
    let socketClosed;
    const closed = new Promise((r) => { socketClosed = r; });
    const server = createServer(tls, (req, res) => {
      req.socket.on("close", socketClosed);
      res.writeHead(200, { "content-type": "image/png", "content-encoding": coding });
      const z = makeStream();
      z.pipe(res);
      // an answer that never ends on its own: only the client closing it stops it
      const tick = setInterval(() => z.write(randomBytes(65536)), 10);
      res.on("close", () => clearInterval(tick));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const direct = (name, opts, cb) => (opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
    try {
      const r = await guardedFetch(`https://img.example:${server.address().port}/img.png`, { lookup: direct, ca: tls.cert });
      const reader = r.body.getReader();
      await reader.read();
      await reader.cancel();
      const late = new Promise((res) => setTimeout(() => res("still open"), 5000).unref());
      assert.equal(await Promise.race([closed.then(() => "closed"), late]), "closed", coding);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
});

test("guardedFetch: a compressed answer that stalls fails the read when the signal aborts, as a plain one does, and preserves upstream error name and code", async () => {
  const tls = certificate();
  const deflateHead = deflateSync(Buffer.from("stalled")).subarray(0, 2);
  const server = createServer(tls, (req, res) => {
    if (req.url === "/deflate.png") {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "deflate" });
      res.write(deflateHead);
    } else if (req.url === "/abort-err.png") {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" });
      res.write(Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]));
      setTimeout(() => res.destroy(), 25);
    } else {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" });
      // a gzip header and then nothing: the download stalls
      res.write(Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const direct = (name, opts, cb) => (opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
  const origDestroy = IncomingMessage.prototype.destroy;
  try {
    for (const path of ["/gz.png", "/deflate.png"]) {
      const r = await guardedFetch(`https://img.example:${server.address().port}${path}`,
        { lookup: direct, ca: tls.cert, signal: AbortSignal.timeout(300) });
      const late = new Promise((res) => setTimeout(() => res("hung"), 5000).unref());
      const read = r.arrayBuffer().then(() => "read", () => "failed");
      assert.equal(await Promise.race([read, late]), "failed", path);
    }
    IncomingMessage.prototype.destroy = function (err) {
      if (err) { err.name = "AbortError"; err.code = "ABORT_ERR"; }
      return origDestroy.call(this, err);
    };
    const r = await guardedFetch(`https://img.example:${server.address().port}/abort-err.png`,
      { lookup: direct, ca: tls.cert });
    await assert.rejects(r.arrayBuffer(), (e) => e.name === "AbortError" && e.code === "ABORT_ERR");
  } finally {
    IncomingMessage.prototype.destroy = origDestroy;
    server.closeAllConnections();
    server.close();
  }
});

test("CLI: leket reddit refuses an image whose name resolves to a private address (the default image fetch is guarded)", () => {
  const dir = tmp();
  const src = join(dir, "reddit-abc123.json");
  writeFileSync(src, JSON.stringify(postPage({ post_hint: "image", url: "https://img.example/a.png", is_self: false })));
  // a preload standing in for DNS: every name resolves to 127.0.0.1
  const preload = join(dir, "dns.mjs");
  writeFileSync(preload, `import dns from "node:dns";
dns.lookup = (name, opts, cb) => { if (typeof opts === "function") { cb = opts; opts = {}; }
  const a = { address: "127.0.0.1", family: 4 };
  process.nextTick(() => (opts && opts.all ? cb(null, [a]) : cb(null, a.address, a.family))); };
`);
  const r = spawnSync(process.execPath, ["--import", preload, BIN, "reddit", "--from-json", src, "--out", dir], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /couldn't save image 1 \(not fetched: img\.example resolves to a local or private-network address \(127\.0\.0\.1\)\); the \.md links https:\/\/img\.example\/a\.png/);
});
