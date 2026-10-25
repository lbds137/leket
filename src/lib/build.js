// From an export to the zip: fetch the attachments (an extension page may, with the host
// permissions in manifest.json), then write the JSON, the readable page and the manifest,
// then the files. Kept apart from the page so the tests can run it under node.
import { ZipWriter } from "./zip.js";
import { FOLDER, MANIFEST, attachmentList, fetchable } from "./files.js";
import { render } from "./render.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one file's bytes as a Blob; an expired or deleted link (403, 404) is not tried again
export async function fetchFile(url, { fetchFn = fetch, tries = 4, wait = 3000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetchFn(url, { credentials: "omit" });
      if (resp.status === 403 || resp.status === 404) return { error: `link expired or gone (HTTP ${resp.status})` };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const expected = Number(resp.headers.get("content-length") || 0);
      const blob = await resp.blob();
      if (expected && blob.size !== expected) throw new Error(`got ${blob.size} of ${expected} bytes`);
      return { blob };
    } catch (e) {
      last = (e && e.message) || String(e);
      if (i + 1 < tries) await sleep(wait);
    }
  }
  return { error: last };
}

export async function build(exp, { file, attachments = true, timeZone = "UTC", partLimit, fetchFn, wait,
  concurrency = 3, onProgress = () => {} } = {}) {
  const records = attachments ? attachmentList(exp) : [];
  const blobs = new Array(records.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < records.length) {
      const i = next++;
      const r = records[i];
      const got = fetchable(r.url) ? await fetchFile(r.url, { fetchFn, wait }) : { error: "not a Discord attachment link" };
      if (got.error) r.error = got.error;
      else blobs[i] = got.blob;
      onProgress({ phase: "fetch", done: ++done, total: records.length, failed: records.filter((x) => x.error).length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));

  const zip = new ZipWriter(partLimit ? { partLimit } : {});
  const enc = new TextEncoder();
  zip.add(file, enc.encode(JSON.stringify(exp, null, 1)));
  zip.add("index.html", enc.encode(render(exp, records, { timeZone })));
  if (records.length) {
    const manifest = records.map(({ message_id, filename, file: f, forwarded, error }) =>
      ({ message_id, filename, file: f, ...(forwarded !== undefined ? { forwarded } : {}), ...(error ? { error } : {}) }));
    zip.add(MANIFEST, enc.encode(JSON.stringify(manifest, null, 1)));
  }
  for (let i = 0; i < records.length; i++) {
    if (!blobs[i]) continue;
    zip.add(`${FOLDER}/${records[i].file}`, new Uint8Array(await blobs[i].arrayBuffer()));
    blobs[i] = null;
    onProgress({ phase: "zip", done: i + 1, total: records.length });
  }
  const parts = zip.parts();
  const base = file.replace(/\.json$/, "");
  const named = parts.map((blob, i) => ({ blob, name: parts.length === 1 ? `${base}.zip` : `${base}-part${i + 1}-of-${parts.length}.zip` }));
  return { parts: named, records, saved: records.filter((r) => !r.error).length, failed: records.filter((r) => r.error) };
}
