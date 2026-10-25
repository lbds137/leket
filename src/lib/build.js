// From an export to the zip: fetch the attachments (an extension page may, with the host
// permissions in manifest.json), then write the JSON, the readable page and the manifest,
// then the files. Kept apart from the page so the tests can run it under node.
import { ZipWriter, crc32 } from "./zip.js";
import { FOLDER, MANIFEST, attachmentList, fetchable } from "./files.js";
import { render } from "./render.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One file as a Blob with its crc32, read piece by piece. A download that sends nothing for
// `idle` ms is dropped and tried again (a stalled connection never ends by itself); an
// expired or deleted link (403, 404) is not tried again.
export async function fetchFile(url, { fetchFn = fetch, tries = 4, wait = 3000, idle = 60000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const stop = new AbortController();
    let timer;
    const quiet = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stop.abort(new Error(`nothing received for ${idle / 1000} s`)), idle);
    };
    try {
      quiet();
      const resp = await fetchFn(url, { credentials: "omit", signal: stop.signal });
      if (!resp.ok) {
        // let the connection go now rather than at garbage collection
        resp.body?.cancel().catch(() => {});
        if (resp.status === 403 || resp.status === 404) return { error: `link expired or gone (HTTP ${resp.status})` };
        throw new Error(`HTTP ${resp.status}`);
      }
      const pieces = [];
      let crc = 0, size = 0;
      const reader = resp.body.getReader();
      for (;;) {
        quiet();
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32(value, crc);
        size += value.length;
        pieces.push(value);
      }
      // a compressed response's length is the compressed size, not the file's
      const expected = resp.headers.get("content-encoding") ? 0 : Number(resp.headers.get("content-length") || 0);
      if (expected && size !== expected) throw new Error(`got ${size} of ${expected} bytes`);
      return { blob: new Blob(pieces), crc };
    } catch (e) {
      last = (stop.signal.aborted && stop.signal.reason && stop.signal.reason.message) || (e && e.message) || String(e);
      if (i + 1 < tries) await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: last };
}

export async function build(exp, { file, attachments = true, timeZone = "UTC", partLimit, fetchFn, wait, idle,
  concurrency = 3, onProgress = () => {} } = {}) {
  const records = attachments ? attachmentList(exp) : [];
  const got = new Array(records.length);
  let next = 0, done = 0, failed = 0;
  const worker = async () => {
    while (next < records.length) {
      const i = next++;
      const r = records[i];
      const res = fetchable(r.url) ? await fetchFile(r.url, { fetchFn, wait, idle }) : { error: "not a Discord attachment link" };
      if (res.error) {
        r.error = res.error;
        failed++;
      } else got[i] = res;
      onProgress({ phase: "fetch", done: ++done, total: records.length, failed });
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
  // each file goes in as the Blob it was fetched into, not a copy
  for (let i = 0; i < records.length; i++) {
    if (!got[i]) continue;
    zip.add(`${FOLDER}/${records[i].file}`, got[i].blob, got[i].crc);
    got[i] = null;
    onProgress({ phase: "zip", done: i + 1, total: records.length });
  }
  const parts = zip.parts();
  const base = file.replace(/\.json$/, "");
  const named = parts.map((blob, i) => ({ blob, name: parts.length === 1 ? `${base}.zip` : `${base}-part${i + 1}-of-${parts.length}.zip` }));
  return { parts: named, records, saved: records.length - failed, failed: records.filter((r) => r.error) };
}
