// From an export to the zip: fetch the attachments (an extension page may, with the host
// permissions in manifest.json), then write the JSON, the readable page and the manifest,
// then the files. Kept apart from the page so the tests can run it under node.
import { ZipWriter, crc32 } from "./zip.js";
import { FOLDER, MANIFEST, attachmentList, fetchable } from "./files.js";
import { render } from "./render.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One file as a Blob with its crc32, read piece by piece. A download that sends nothing for
// `idle` ms is dropped and tried again (a stalled connection never ends by itself); an
// expired or deleted link (403, 404) is not tried again. Discord's CDN answers 503/504 for
// stretches at a time, so the retries back off: wait, 2×wait, 3×wait…
export async function fetchFile(url, { fetchFn = fetch, tries = 5, wait = 3000, idle = 60000 } = {}) {
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
      if (i + 1 < tries) await sleep(wait * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: last };
}

// From an export to the zip(s). Two ways, chosen by whether an `onPart` is given:
//
// Without one (small saves), everything is fetched into memory, then packed as it always
// was — JSON, page, manifest, files — and every part comes back as a Blob in the result.
// The page is rendered after the fetches, so it marks the attachments that failed.
//
// With one (a save too big to hold twice, per needsParts), the JSON and the page are
// sealed into their own small first part and downloaded before any attachment is fetched —
// the text survives whatever happens to the rest. Rendered that early, the page cannot
// mark failures; the manifest part lists them. Each fetched file is packed as it arrives,
// workers pause while a hand-off is in flight, and a sealed part is handed to onPart
// ({blob, name, index}), whose download finishes before more is fetched — so the memory
// is bounded: a downloading part, the part being filled, and whatever the few fetches
// already in flight add when they land. onPart
// returning false stops the save: the part still being filled is discarded, nothing more
// is fetched or downloaded, and everything that didn't land in a downloaded part is
// listed as unsaved in the manifest. The manifest still gets its own small part at the
// end, in both cases. Parts are named <base>-partN.zip: the total isn't known until the
// last one seals.
export async function build(exp, { file, attachments = true, timeZone = "UTC", partLimit, fetchFn, wait, idle,
  concurrency = 3, onProgress = () => {}, onPart } = {}) {
  const records = attachments ? attachmentList(exp) : [];
  const stream = !!onPart && records.length > 0;
  const STOP_ERROR = "not saved — the save stopped early";
  // the writer hands sealed parts to the queue; the drain passes them on one at a time
  let zip = new ZipWriter({ ...(partLimit ? { partLimit } : {}),
    ...(stream ? {
      onPart: (blob, n) => { sealedParts.push({ blob, n, idx: sinceSeal }); sinceSeal = []; },
    } : {}) });
  const enc = new TextEncoder();
  const base = file.replace(/\.json$/, "");
  const handedOff = [];
  // parts sealed while the fetches run wait here; the drain hands each one over and lets
  // only one drain run at a time, so part N's download finishes before part N+1 fills
  const sealedParts = [];
  // which records went into the part being filled, and which sit in parts already
  // downloaded (everything else is unsaved when the save stops early)
  let sinceSeal = [];
  const sealedSet = new Set();
  let stopped = false;
  let draining = null;
  // hands every sealed part over, one drain at a time; a caller arriving mid-drain waits
  // for it, which also covers anything sealed since it started. onPart false stops it —
  // parts queued behind the failed one are dropped there, and only the tail's forced
  // drain (the manifest) goes out after a stop.
  const drain = async (force = false) => {
    while (draining) await draining;
    if (!force && (stopped || !sealedParts.length)) return;
    draining = (async () => {
      try {
        while (sealedParts.length && (!stopped || force)) {
          const item = sealedParts.shift();
          // numbered by hand-off order, not seal order: a stop discards some sealed parts,
          // and the save's parts must not have gaps in their names
          const index = handedOff.length + 1;
          const entry = { blob: item.blob, index, name: `${base}-part${index}.zip` };
          handedOff.push(entry);
          const ok = await onPart(entry);
          // the part is the callback's while it runs; dropped after, so a streamed save
          // never holds on to the parts it has already handed off
          entry.blob = null;
          if (ok === false) {
            stopped = true;
            sealedParts.length = 0;
          } else for (const i of item.idx) sealedSet.add(i);
        }
      } finally {
        draining = null;
      }
    })();
    await draining;
  };

  let next = 0, done = 0, failed = 0, packed = 0;
  const got = stream ? null : new Array(records.length);
  const worker = async () => {
    while (next < records.length && !stopped) {
      // streamed: before fetching more, wait until every part already sealed has been
      // handed off, so a slow download can't pile 2 GiB parts up in memory
      if (!got) {
        while ((draining || sealedParts.length) && !stopped) await drain();
        if (stopped) break;
      }
      const i = next++;
      const r = records[i];
      const res = fetchable(r.url) ? await fetchFile(r.url, { fetchFn, wait, idle }) : { error: "not a Discord attachment link" };
      if (stopped && !got) {
        // the save stopped while this was being fetched: it never reaches a part
        if (!res.error) { r.error = STOP_ERROR; failed++; }
        else r.error = res.error;
      } else if (res.error) {
        r.error = res.error;
        failed++;
      } else if (got) {
        got[i] = res;
      } else {
        // each file goes in as the Blob it was fetched into, not a copy
        zip.add(`${FOLDER}/${r.file}`, res.blob, res.crc);
        sinceSeal.push(i);
        packed++;
        onProgress({ phase: "zip", done: packed, total: records.length });
        await drain();
      }
      onProgress({ phase: "fetch", done: ++done, total: records.length, failed });
    }
  };

  if (stream) {
    // the readable part stands alone, and is out of the way before the first fetch;
    // rendered this early it cannot mark failures — the manifest part lists them
    zip.add(file, enc.encode(JSON.stringify(exp, null, 1)));
    zip.add("index.html", enc.encode(render(exp, records, { timeZone, streamed: true })));
    zip.close();
    await drain();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));

  // the manifest is written once the fetches are over: which files failed is only known
  // then. Streamed it gets its own small part (the attachment part is sealed first, unless
  // nothing was fetched), so it survives a big part failing; otherwise it lands between
  // the page and the files, as it always has. A stopped save discards the part still
  // being filled and anything already queued behind the failed one — no more multi-GB
  // downloads — but still writes the manifest out.
  if (stopped) {
    zip.discard();
    sealedParts.length = 0;
    for (let i = 0; i < records.length; i++) {
      if (!records[i].error && !sealedSet.has(i)) { records[i].error = STOP_ERROR; failed++; }
    }
  } else if (stream && packed > 0) zip.close();
  if (!stream) {
    zip.add(file, enc.encode(JSON.stringify(exp, null, 1)));
    zip.add("index.html", enc.encode(render(exp, records, { timeZone })));
  }
  if (records.length) {
    const manifest = records.map(({ message_id, filename, file: f, forwarded, error }) =>
      ({ message_id, filename, file: f, ...(forwarded !== undefined ? { forwarded } : {}), ...(error ? { error } : {}) }));
    zip.add(MANIFEST, enc.encode(JSON.stringify(manifest, null, 1)));
  }
  if (got) {
    for (let i = 0; i < records.length; i++) {
      if (!got[i]) continue;
      zip.add(`${FOLDER}/${records[i].file}`, got[i].blob, got[i].crc);
      got[i] = null;
      onProgress({ phase: "zip", done: i + 1, total: records.length });
    }
  }
  const parts = zip.parts();
  await drain(stopped);   // after a stop, only the manifest part is left to hand over
  if (stream) return { parts: handedOff.map(({ name, index }) => ({ name, index })), records,
    saved: records.length - failed, failed: records.filter((r) => r.error) };
  const named = parts.map((blob, i) => ({ blob, name: parts.length === 1 ? `${base}.zip` : `${base}-part${i + 1}-of-${parts.length}.zip` }));
  return { parts: named, records, saved: records.length - failed, failed: records.filter((r) => r.error) };
}
