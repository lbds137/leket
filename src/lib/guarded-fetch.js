// The CLI's image fetch: a GET over node:https whose DNS lookup refuses a local or
// private-network answer before any connection is made. isPrivateHost can only read the
// name; a public name can still resolve to 127.0.0.1 or 10.x, and the extension can't see
// that (TASK-40). Node can: the lookup hook vets the very addresses the socket would use,
// so there is no gap between the check and the connect. Node only: the extension never
// imports this. Redirects are never followed (https.request doesn't), as fetchImageData
// asks; the answer is a WHATWG Response, so fetchImageData reads it like fetch's.
import dns from "node:dns";
import { request } from "node:https";
import { Readable } from "node:stream";

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
    const req = request(url, { method: "GET", headers, signal, lookup, ...(ca ? { ca } : {}) }, (res) => {
      try {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x);
        const body = NO_BODY.has(res.statusCode) ? (res.resume(), null) : Readable.toWeb(res);
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
