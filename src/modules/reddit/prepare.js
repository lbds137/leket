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

export async function fetchImage({ n, u, ext }, { fetch: doFetch = fetch } = {}) {
  const unreachable = (e) => new Error(`couldn't reach it (${(e && e.message) || e})`);
  let r;
  try {
    r = await doFetch(u, { credentials: "omit", signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw unreachable(e);
  }
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
