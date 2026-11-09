// The reddit save's prepare half, and the only code the offscreen document runs: one
// fetch of the post's .json with the browser's own login riding along, validated,
// rendered to Markdown (md.js) and made into two blobs — the json and its .md.
// chrome.runtime is the only extension API an offscreen document gets, so
// this file must never reach for the downloads API — a test pins that — and the worker
// downloads the blob it returns (same extension origin). The document stays open until
// the worker asks it to revoke a settled blob; closing it could kill a download still
// reading one. The console script dev-docs/browser/reddit-json.js is the spec, as-is;
// its old.reddit advice stays advice in the error text — never an auto-retry.
import { POST_PATHNAME } from "../registry.js";
import { render, notFetched, postOf, images, imageFileName } from "./md.js";

const MAX_IMAGE_BYTES = 50 * 1048576;

export async function preparePostJson(tabUrl, { fetch: doFetch = fetch } = {}) {
  const here = new URL(tabUrl);
  // the pathname pattern alone would accept any host: pin the two the manifest covers,
  // so a lookalike page can't draw a credentialed fetch to its own origin
  if (!/^(www|old)\.reddit\.com$/.test(here.hostname)) {
    throw new Error("Not a reddit post page — open the post on www.reddit.com or old.reddit.com and click again.");
  }
  const id = here.pathname.match(POST_PATHNAME);
  if (!id) throw new Error("Not a post page: open the post itself (its address has /comments/ in it).");
  // the script fetches a relative path from the post's own page; the port fetches the
  // same origin the tab is on (www or old), so the same logged-in session answers.
  // A timeout, so a stalled reddit says "unreachable" instead of parking the popup.
  const unreachable = (e) => new Error(`Couldn't reach reddit to fetch this post's JSON — check the connection, then click Save again. (${(e && e.message) || e})`);
  let r;
  try {
    r = await doFetch(`${here.origin}/comments/${id[1]}.json?raw_json=1&limit=500`, { credentials: "include", signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw unreachable(e);
  }
  if (!r.ok) throw new Error(`reddit answered ${r.status}; try again from old.reddit.com/comments/${id[1]}`);
  let text;
  try {
    text = await r.text();
  } catch (e) {
    throw unreachable(e);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // a 200 that isn't json is a login wall or a block page; saving it under the CLI's
    // name would only move the confusion to reddit-export. (The script saves blind;
    // this guard is for the popup flow, which has no console to see it fail in.)
    throw new Error(`reddit answered with a page, not this post's JSON — try again from old.reddit.com/comments/${id[1]}`);
  }
  // the .md is rendered here, before anything downloads: a 200 that parses but isn't a
  // post page used to land as junk json — now the save refuses with the CLI-voiced
  // wrapper (md.js's own message inside), so Chrome never writes a file that can't be read
  // the count is taken inside the try too: an odd shape (children not a list) is the
  // same not-this-post's-data refusal, not a bare TypeError
  let mdText, nf, imgs;
  try {
    nf = notFetched(data);
    mdText = render(data, {}, "", nf);
    imgs = images(postOf(data)).filter(([, u]) => u).map(([n, u, , ext]) => ({ n, u, ext }));
  } catch (e) {
    throw new Error(`reddit answered with something that isn't this post's data — try again from old.reddit.com/comments/${id[1]} (${e && e.message || e})`);
  }
  return {
    id: id[1],
    data,
    images: imgs,
    url: URL.createObjectURL(new Blob([text], { type: "application/json" })),
    name: `reddit-${id[1]}.json`,
    mdUrl: URL.createObjectURL(new Blob([mdText], { type: "text/markdown" })),
    mdName: `reddit-${id[1]}.md`,
    notFetched: nf,
  };
}

export function isPrivateHost(hostname) {
  const h = hostname.replace(/\.+$/, "");
  if (h.startsWith("[")) {
    // public only in global unicast (2000::/3), minus 6to4 (2002::/16) and Teredo
    // (2001:0::/32), which carry an IPv4 address that could be a private one
    const [g0, g1] = h.slice(1, -1).split(":").map((g) => (g === "" ? 0 : parseInt(g, 16)));
    return !(g0 >= 0x2000 && g0 < 0x4000) || g0 === 0x2002 || (g0 === 0x2001 && g1 === 0);
  }
  const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b, c] = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3])];
    return a === 0
      || a === 10
      || (a === 100 && b >= 64 && b <= 127)
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  return !h.includes(".") || /(^|\.)(localhost|localdomain)$|\.(local|internal|home\.arpa|lan)$/.test(h);
}

export async function fetchImage({ n, u, ext }, { fetch: doFetch = fetch } = {}) {
  // The post author picks the image URL: a GET to a non-https or private host leaks the
  // saver's IP and pokes their network even though CORS hides the reply. Known limit: a
  // public name that resolves by DNS to a private address is not caught (an extension
  // can't resolve names before fetching). Redirects are not followed: the next hop could be
  // any scheme or host, and fetch can't show it before sending the request, so an image
  // behind a redirect keeps its remote link.
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error("not fetched: not a valid address");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("not fetched: only https images are fetched");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("not fetched: a local or private-network address");
  }
  const unreachable = (e) => new Error(`couldn't reach it (${(e && e.message) || e})`);
  let r;
  try {
    r = await doFetch(u, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw unreachable(e);
  }
  if (r.type === "opaqueredirect") throw new Error("not fetched: it redirects to another address");
  // a refused response's unread body is cancelled, so its connection closes now rather
  // than at the timeout
  const refuse = (why) => {
    if (r.body && typeof r.body.cancel === "function") r.body.cancel().catch(() => {});
    return new Error(why);
  };
  if (!r.ok) throw refuse(`the server answered ${r.status}`);
  const rawType = (r.headers && typeof r.headers.get === "function" && r.headers.get("content-type")) || "";
  const ctype = rawType.split(";")[0].trim().toLowerCase();
  if (!ctype.startsWith("image/")) {
    throw refuse(`the server sent ${ctype || "no content type"}, not an image`);
  }
  const cl = Number(r.headers && typeof r.headers.get === "function" && r.headers.get("content-length"));
  if (cl > MAX_IMAGE_BYTES) throw refuse("over 50 MB");
  if (!r.body) throw new Error("the server sent no image data");
  const chunks = [];
  let total = 0;
  const reader = r.body.getReader();
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (e) {
      throw unreachable(e);
    }
    const { done, value } = step;
    if (done) break;
    total += value.byteLength ?? value.length;
    if (total > MAX_IMAGE_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error("over 50 MB");
    }
    chunks.push(value);
  }
  return {
    url: URL.createObjectURL(new Blob(chunks, { type: ctype })),
    name: imageFileName(n, ctype, ext, u),
  };
}
