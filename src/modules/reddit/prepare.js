// The reddit save's prepare half, and the only code the offscreen document runs: one
// fetch of the post's .json with the browser's own login riding along, validated, made
// into a blob. chrome.runtime is the only extension API an offscreen document gets, so
// this file must never reach for the downloads API — a test pins that — and the worker
// downloads the blob it returns (same extension origin). The document stays open until
// the worker asks it to revoke a settled blob; closing it could kill a download still
// reading one. The console script dev-docs/browser/reddit-json.js is the spec, as-is;
// its old.reddit advice stays advice in the error text — never an auto-retry.
import { POST_PATHNAME } from "../registry.js";

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
  // same origin the tab is on (www or old), so the same logged-in session answers
  let r;
  try {
    r = await doFetch(`${here.origin}/comments/${id[1]}.json?raw_json=1&limit=500`, { credentials: "include" });
  } catch (e) {
    throw new Error(`Couldn't reach reddit to fetch this post's JSON — check the connection, then click Save again. (${(e && e.message) || e})`);
  }
  if (!r.ok) throw new Error(`reddit answered ${r.status}; try again from old.reddit.com/comments/${id[1]}`);
  const text = await r.text();
  try {
    JSON.parse(text);
  } catch {
    // a 200 that isn't json is a login wall or a block page; saving it under the CLI's
    // name would only move the confusion to reddit-export. (The script saves blind;
    // this guard is for the popup flow, which has no console to see it fail in.)
    throw new Error(`reddit answered with a page, not this post's JSON — try again from old.reddit.com/comments/${id[1]}`);
  }
  return {
    url: URL.createObjectURL(new Blob([text], { type: "application/json" })),
    name: `reddit-${id[1]}.json`,
  };
}
