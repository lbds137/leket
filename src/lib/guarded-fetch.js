// The CLI's image fetch: a GET over node:https whose DNS lookup refuses a local or
// private-network answer before any connection is made. isPrivateHost can only read the
// name; a public name can still resolve to 127.0.0.1 or 10.x, and the extension can't see
// that (TASK-40). Node can: the lookup hook vets the very addresses the socket would use,
// so there is no gap between the check and the connect. Node only: the extension never
// imports this. Redirects are never followed (https.request doesn't), as fetchImageData
// asks; the answer is a WHATWG Response, so fetchImageData reads it like fetch's.
import dns from "node:dns";
import { request } from "node:https";
import { PassThrough, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";

import { isPrivateHost } from "../modules/reddit/prepare.js";

// a lookup(hostname, options, callback) for net.connect that fails when any answer is
// private: a name that mixes public and private answers is refused outright, so a
// fallback between them (happy eyeballs) can't reach the private one. `resolve` is
// dns.lookup, read when called (a test preload can stand in for DNS).
export function makeLookup(resolve = (...a) => dns.lookup(...a)) {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, answers) => {
      if (err) return callback(err);
      if (!answers || !answers.length) {
        return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
      }
      const bad = answers.find((a) => isPrivateHost(a.family === 6 ? `[${a.address}]` : a.address));
      if (bad) {
        const e = new Error(`not fetched: ${hostname} resolves to a local or private-network address (${bad.address})`);
        e.code = "EPRIVATEADDR";
        return callback(e);
      }
      if (options && options.all) return callback(null, answers);
      callback(null, answers[0].address, answers[0].family);
    });
  };
}

const NO_BODY = new Set([204, 205, 304]);

// who is asking, sent on every request (reddit's JSON fetch too): some image hosts
// (Wikimedia, for one) answer a request that has no User-Agent with 403
export const LEKET_UA = "leket (personal archiving; https://github.com/lbds137/leket)";

// https.request decodes nothing, so the request asks for the bytes as they are; a server
// that compresses anyway is decoded here, as fetch would, and an encoding with no decoder
// is refused rather than saved as a picture that won't open
const DECODERS = { gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress };

// Servers send either zlib-wrapped (0x78) or raw deflate for Content-Encoding: deflate;
// hold the first chunk to sniff which decoder to pipe through
function inflate(res) {
  const out = new PassThrough();
  let z;
  res.once("data", (chunk) => {
    z = (chunk[0] === 0x78 ? createInflate : createInflateRaw)();
    z.on("error", (e) => out.destroy(e));
    out.on("close", () => z.destroy());
    z.pipe(out);
    z.write(chunk);
    res.pipe(z);
  });
  res.once("end", () => { if (!z) out.end(); });
  return out;
}

// fetch(url, { signal, headers }) for one https GET; credentials and redirect options
// are accepted and need nothing (no cookies here, no redirect is ever followed). `lookup`
// and `ca` are for tests: a stand-in DNS answer, and a test server's own certificate.
export function guardedFetch(url, { signal, headers = {}, lookup = makeLookup(), ca } = {}) {
  return new Promise((resolve, reject) => {
    // net.connect skips the lookup for an IP literal, so a literal is judged here
    const host = new URL(url).hostname;
    if (isPrivateHost(host)) {
      return reject(Object.assign(new Error(`not fetched: ${host} is a local or private-network address`), { code: "EPRIVATEADDR" }));
    }
    const sent = { "user-agent": LEKET_UA, accept: "*/*", "accept-encoding": "identity", ...Object.fromEntries(new Headers(headers)) };
    const req = request(url, { method: "GET", headers: sent, signal, lookup, ...(ca ? { ca } : {}) }, (res) => {
      try {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x);
        let body = null;
        if (NO_BODY.has(res.statusCode)) res.resume();
        else {
          const coding = String(res.headers["content-encoding"] || "identity").trim().toLowerCase();
          if (coding === "identity") body = Readable.toWeb(res);
          // own keys only: "constructor" is no decoder
          else if (Object.hasOwn(DECODERS, coding)) {
            const decoded = coding === "deflate" ? inflate(res) : res.pipe(DECODERS[coding]());
            // a reset upstream fails the read, but as a fresh error, so the corrupt-body
            // tag below can't stamp a network failure as the decoder's own; a reader that
            // stops early (cancel) closes the connection too, not only the decoder
            res.on("error", (e) => decoded.destroy(Object.assign(new Error(e.message), { via: "upstream", cause: e })));
            decoded.on("close", () => { if (!res.complete) res.destroy(); });
            decoded.on("error", (e) => { if (!e.via) { e.code = "EDECODE"; e.coding = coding; } });
            body = Readable.toWeb(decoded);
            // the headers now describe the decoded bytes
            h.delete("content-encoding");
            h.delete("content-length");
          } else {
            res.destroy();
            return reject(Object.assign(new Error(`not fetched: the server sent it encoded as ${coding}`), { code: "EENCODING" }));
          }
        }
        resolve(new Response(body, { status: res.statusCode, headers: h }));
      } catch (e) {
        res.destroy();
        reject(e);
      }
    });
    req.on("error", reject);
    req.end();
  });
}
