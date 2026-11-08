// The claude-chat module's pure halves, ported from the console script
// dev-docs/browser/claude-chat-outputs.js — the script is the spec. Everything runs
// against an injected fetch stand-in: no test may open a socket, and the script's
// proven shapes (the wiggle endpoints' URLs, the text/base64 split, the
// error-plus-partial-files chat entry) are pinned here one by one.
import { test } from "node:test";
import assert from "node:assert/strict";

// a red line under every test, like claude-sessions.test.js: an un-injected fetch is a bug
globalThis.fetch = async () => { throw new Error("no network in tests: inject a fetch stand-in"); };

const { parseChats, isText, asText, toBase64, readOrgPath, absolutizeOrgPath, collectChats, outputsName }
  = await import("../src/modules/claude-chat/outputs.js");

const CHAT = "1234e567-89ab-4cde-8f01-234556789abc";
// the probe's capture is relative (the regex starts at /api/), exactly as the script
// builds it; the page absolutizes it against the tab's origin before any fetch
const ORG_PATH = "/api/organizations/aaaa1111-2222-4333-8444-555555555555/";
const ORG = "https://claude.ai" + ORG_PATH;

// a stand-in fetch keyed by full URL (the wiggle calls are distinguished by their
// query, not just pathname), remembering every call. A route answers with
// { status?, json?, blob? }; no status means 200 OK.
const wiggleFetch = (routes) => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const route = routes[url];
    if (!route) throw new Error(`no stand-in for ${url}`);
    const out = await route();
    return {
      ok: (out.status ?? 200) >= 200 && (out.status ?? 200) < 300,
      status: out.status ?? 200,
      json: async () => out.json,
      blob: async () => out.blob,
    };
  };
  return { calls, fetch };
};

// --- parseChats: the paste guard, mirroring parseRenames

test("parseChats takes the bare JSON array of triples", () => {
  const list = parseChats(`[["${CHAT}","chat one","deck"],["${CHAT}","chat two","deck"]]`);
  assert.deepEqual(list, [[CHAT, "chat one", "deck"], [CHAT, "chat two", "deck"]]);
});

test("parseChats takes the whole pasted window.CLAUDE_OUTPUT_CHATS line", () => {
  const line = `window.CLAUDE_OUTPUT_CHATS = [["${CHAT}","chat one","deck"]];`;
  assert.deepEqual(parseChats(line), [[CHAT, "chat one", "deck"]]);
  // and without the trailing semicolon
  assert.deepEqual(parseChats(line.slice(0, -1)), [[CHAT, "chat one", "deck"]]);
});

test("parseChats takes the whole generated file pasted as-is: the line, then the script", () => {
  // the shape dev-docs/browser/claude-chat-outputs.js's header names: the list line,
  // then the script, whose own `;` line ends and OUTPUT_CHATS mention must not leak in
  const script = "(async () => {\n  const chats = window.CLAUDE_OUTPUT_CHATS || [];\n  console.log(chats.length);\n})();\n";
  const file = `window.CLAUDE_OUTPUT_CHATS = [["${CHAT}","chat one","deck"]];\n${script}`;
  assert.deepEqual(parseChats(file), [[CHAT, "chat one", "deck"]]);
  assert.deepEqual(parseChats(file.replace(/\n/g, "\r\n")), [[CHAT, "chat one", "deck"]]);
});

test("parseChats refuses junk with a message that says what to paste", () => {
  for (const junk of ["not json at all", '{"a":1}']) {
    assert.throws(() => parseChats(junk), /window\.CLAUDE_OUTPUT_CHATS|bare JSON array/, junk);
  }
});

test("parseChats refuses a list that isn't [chat, name, source] triples", () => {
  // pairs — the rename list's shape — must not pass: a name pasted into the chat
  // slot would die at the id guard anyway, but the shape error is the honest one
  for (const bad of ['[["id","title"]]', '["a string"]', '{"chat":"x"}']) {
    assert.throws(() => parseChats(bad), /triple|CLAUDE_OUTPUT_CHATS/, bad);
  }
});

test("parseChats refuses an empty list", () => {
  assert.throws(() => parseChats("[]"), /empty/);
  assert.throws(() => parseChats("window.CLAUDE_OUTPUT_CHATS = [];"), /empty/);
});

test("parseChats rejects a chat id that isn't uuid-shaped, naming it", () => {
  // a chat id goes straight into the conversation URL, so anything that isn't a
  // uuid — a path traversal, a stray paste, an injection — is refused here,
  // before any fetch
  for (const bad of ["x/../../api/foo", "drop table; --", "short-uuid"]) {
    assert.throws(() => parseChats(`[["${bad}", "name", "source"]]`),
      (e) => e.message.includes(bad) && /chat id|hex/.test(e.message),
      `the id ${JSON.stringify(bad)} had to be refused, named in the error`);
  }
});

test("parseChats rejects ids that aren't canonical 8-4-4-4-12 uuids, naming them", () => {
  // 36 dashes pass a loose hex-and-dash count but are no id; dashes in the wrong
  // places (9-3-4-4-12) pin the 8-4-4-4-12 shape itself, and a truncated uuid is
  // a bad paste. All refused here, before any fetch, named in the error — while
  // a canonical uuid still passes (the earlier tests pin that).
  for (const bad of ["-".repeat(36), "aaaa11111-111-4111-8111-111111111111", CHAT.slice(0, 35)]) {
    assert.throws(() => parseChats(`[["${bad}", "name", "source"]]`),
      (e) => e.message.includes(bad) && /chat id|hex/.test(e.message),
      `the id ${JSON.stringify(bad)} had to be refused, named in the error`);
  }
});

test("parseChats stores name and source as-is, unchecked", () => {
  // the script passes them through and Deck's generator emits strings; a null
  // source survives into the entry
  const list = parseChats(`[["${CHAT}","a name",null]]`);
  assert.deepEqual(list, [[CHAT, "a name", null]]);
});

// --- isText: the script's predicate, exact

test("isText hits by content type", () => {
  for (const [path, type] of [
    ["/x/report", "text/markdown"],
    ["/x/data", "application/json"],
    ["/x/table", "text/csv"],
    ["/x/feed", "application/xml"],
    ["/x/app", "application/javascript"],
    ["/x/config", "application/yaml"],
  ]) {
    assert.equal(isText(path, type), true, `${type} is text`);
  }
});

test("isText hits by extension, case-insensitive, and wins over a binary type", () => {
  for (const ext of ["json", "md", "txt", "csv", "tsv", "yaml", "yml", "html", "xml", "js", "py", "sh"]) {
    assert.equal(isText(`/x/file.${ext}`, ""), true, `.${ext} is text`);
    assert.equal(isText(`/x/file.${ext.toUpperCase()}`, ""), true, `.${ext.toUpperCase()} is text`);
  }
  assert.equal(isText("/x/photo.JSON", "image/png"), true, "the extension decides over a binary type");
  assert.equal(isText("/x/script.Py", "application/octet-stream"), true);
});

test("isText misses on binary types and binary extensions", () => {
  for (const [path, type] of [
    ["/x/photo", "image/png"],
    ["/x/blob", "application/octet-stream"],
    ["/x/photo.png", ""],
  ]) {
    assert.equal(isText(path, type), false, `${path} (${type}) is not text`);
  }
  assert.equal(isText("/x/photo.png", undefined), false, "no type at all, binary extension");
});

// the dev-docs script's 26-case check, mirrored: the Office types carry "xml" inside
// their names and must never take the text path
test("isText is anchored to the media type: Office files are binary, +json/+xml and parameters are text", () => {
  for (const [path, type, want] of [
    ["/o/a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
    ["/o/a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false],
    ["/o/a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", false],
    ["/o/a.odt", "application/vnd.oasis.opendocument.text", false],
    ["/o/a.png", "image/png", false],
    ["/o/a.svg", "image/svg+xml", true],
    ["/o/a.json", "application/json", true],
    ["/o/a.txt", "text/plain", true],
    ["/o/a.xml", "application/xml", true],
    ["/o/a.yaml", "application/x-yaml", true],
    ["/o/a.js", "text/javascript", true],
    ["/o/a.js", "application/javascript", true],
    ["/o/a.ld", "application/ld+json", true],
    ["/o/a.md", "application/octet-stream", true],
    ["/o/a.bin", "", false],
    ["/o/a", "TEXT/PLAIN", true],
    ["/o/a", "application/x-javascript", true],
    ["/o/a", "application/x-ndjson", true],
    ["/o/a", "application/json ; charset=utf-8", true],
    ["/o/a", "application/vnd.ms-excel", false],
    ["/o/a", "application/xml-dtd", false],
    ["/o/a", "application/jsonl", true],
    ["/o/a", "application/json5", true],
    ["/o/a", "application/x-jsonlines", true],
    ["/o/a.jsonl", "application/octet-stream", true],
    ["/o/a", "application/jsonx", false],
  ]) {
    assert.equal(isText(path, type), want, `${path} (${type || "no type"})`);
  }
});

test("asText is UTF-8 or null: a leading BOM is stripped, invalid bytes refuse", async () => {
  assert.equal(await asText(new Blob(["héllo"])), "héllo");
  assert.equal(await asText(new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x61])])), "a");
  assert.equal(await asText(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe])])), null);
});

test("a BOM'd .json output lands as text a reader can JSON.parse", async () => {
  const body = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"slug":"x"}')]);
  const files = [{ path: "/mnt/user-data/outputs/card.json", size: body.length, content_type: "application/json", body }];
  const fetch = async (url) => {
    if (url.includes("list-files")) return { ok: true, json: async () => ({ files_metadata: files }) };
    return { ok: true, blob: async () => new Blob([files[0].body]) };
  };
  const done = await collectChats([[CHAT, "n", null]], { fetch, orgPath: "https://claude.ai/api/organizations/x/" });
  assert.deepEqual(JSON.parse(done.results[0].files[0].text), { slug: "x" });
  assert.ok(!("base64" in done.results[0].files[0]));
});

test("a docx output rides as base64, byte-exact; a text label over invalid UTF-8 falls back to base64", async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80, 0x00]);
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in Latin-1: not UTF-8
  const files = [
    { path: "/mnt/user-data/outputs/r.docx", size: zip.length, content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: zip },
    { path: "/mnt/user-data/outputs/t.csv", size: latin1.length, content_type: "text/csv", body: latin1 },
  ];
  const fetch = async (url) => {
    if (url.includes("list-files")) return { ok: true, json: async () => ({ files_metadata: files }) };
    const f = files.find((x) => url.endsWith(encodeURIComponent(x.path)));
    return { ok: true, blob: async () => new Blob([f.body]) };
  };
  const done = await collectChats([[CHAT, "n", null]], { fetch, orgPath: "https://claude.ai/api/organizations/x/" });
  const [docx, csv] = done.results[0].files;
  assert.equal(docx.text, undefined);
  assert.deepEqual([...Buffer.from(docx.base64, "base64")], [...zip]);
  assert.equal(csv.text, undefined);
  assert.deepEqual([...Buffer.from(csv.base64, "base64")], [...latin1]);
});

// --- toBase64: the script's chunked base64, exact

test("toBase64 encodes short text", async () => {
  assert.equal(await toBase64(new Blob(["hello"])), "aGVsbG8=");
});

test("toBase64 is correct exactly at the 0x8000 chunk boundary, and one past it", async () => {
  // the fromCharCode spread chunks at 0x8000: one byte more or less must both work,
  // no RangeError, both round-tripping through atob byte-for-byte
  for (const n of [0x8000, 0x8001]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = i % 256;
    const b64 = await toBase64(new Blob([bytes]));
    const back = atob(b64);
    assert.equal(back.length, n, `round-trip length for ${n} bytes`);
    for (let i = 0; i < n; i++) assert.equal(back.charCodeAt(i), i % 256, `byte ${i} of ${n}`);
  }
});

test("toBase64 survives every byte value 0x00–0xFF", async () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const back = atob(await toBase64(new Blob([bytes])));
  for (let i = 0; i < 256; i++) assert.equal(back.charCodeAt(i), i, `byte 0x${i.toString(16)}`);
});

// --- readOrgPath: the injectable probe (self-contained — chrome.scripting
// serializes its source, so it imports nothing and closes over nothing)

test("readOrgPath returns the first org prefix on the resource timeline", () => {
  const original = performance.getEntriesByType;
  performance.getEntriesByType = (type) => type === "resource" ? [
    { name: `${ORG}conversations/${CHAT}/wiggle/list-files?prefix=` },
    { name: "https://claude.ai/index.js" },
  ] : [];
  let got;
  try {
    got = readOrgPath();
  } finally {
    performance.getEntriesByType = original;
  }
  assert.equal(got, ORG_PATH, "the relative org prefix, capture included, is the probe's answer");
});

test("readOrgPath returns null when no resource entry carries an org id", () => {
  const original = performance.getEntriesByType;
  performance.getEntriesByType = () => [
    { name: "https://claude.ai/index.js" },
    { name: "https://claude.ai/api/other" },
  ];
  let got;
  try {
    got = readOrgPath();
  } finally {
    performance.getEntriesByType = original;
  }
  assert.equal(got, null);
});

test("readOrgPath takes the first of several org prefixes", () => {
  const original = performance.getEntriesByType;
  performance.getEntriesByType = () => [
    { name: "https://claude.ai/api/organizations/bbbb2222-2222-4333-8444-555555555555/x" },
    { name: `${ORG}y` },
  ];
  let got;
  try {
    got = readOrgPath();
  } finally {
    performance.getEntriesByType = original;
  }
  assert.equal(got, "/api/organizations/bbbb2222-2222-4333-8444-555555555555/");
});

test("absolutizeOrgPath puts the tab's origin in front of the probe's relative capture", () => {
  // the probe's capture is correct only on the claude.ai tab, where the script ran;
  // the page fetches from the extension page, where a relative /api/... would
  // resolve against chrome-extension:// — the origin goes back in front of it
  assert.equal(absolutizeOrgPath(`https://claude.ai/chat/${CHAT}`, ORG_PATH), ORG);
});

// --- collectChats: the ported loop

const listing = (files) => ({ json: { files_metadata: files } });
const md = (text) => ({ blob: new Blob([text], { type: "text/markdown" }) });
const bin = (bytes) => ({ blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }) });

test("collectChats downloads one chat's text and binary files as text and base64", async () => {
  const listUrl = `${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`;
  const { calls, fetch } = wiggleFetch({
    [listUrl]: () => listing([
      { path: "/mnt/user-data/outputs/report.md", size: 5, created_at: "2026-01-01T00:00:00Z", content_type: "text/markdown" },
      { path: "/mnt/user-data/outputs/img.png", size: 3, created_at: "2026-01-01T00:00:00Z", content_type: "image/png" },
    ]),
    [`${ORG}conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Freport.md`]: () => md("hello"),
    [`${ORG}conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fimg.png`]: () => bin([1, 2, 3]),
  });
  const done = await collectChats([[CHAT, "chat one", "deck"]], { fetch, orgPath: ORG });
  assert.equal(done.failed, 0);
  assert.equal(done.fileCount, 2);
  const [entry] = done.results;
  assert.deepEqual([entry.chat, entry.name, entry.source], [CHAT, "chat one", "deck"]);
  assert.deepEqual(entry.files, [
    { path: "/mnt/user-data/outputs/report.md", size: 5, created_at: "2026-01-01T00:00:00Z", content_type: "text/markdown", text: "hello" },
    { path: "/mnt/user-data/outputs/img.png", size: 3, created_at: "2026-01-01T00:00:00Z", content_type: "image/png", base64: "AQID" },
  ], "text lands inline, the binary as base64, each with its meta");
  assert.equal(calls.length, 3, "one listing, one download per file");
  assert.equal(calls[0].url, listUrl, "the listing carries the empty prefix");
  assert.equal(calls[0].opts.credentials, "include", "the login rides along");
  assert.equal(calls[1].url, `${ORG}conversations/${CHAT}/wiggle/download-file?path=${encodeURIComponent("/mnt/user-data/outputs/report.md")}`,
    "the download path is encodeURIComponent'd");
});

test("collectChats skips anything outside /mnt/user-data/outputs/", async () => {
  const { calls, fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => listing([
      { path: "/mnt/user-data/uploads/notes.txt", size: 4, content_type: "text/plain" },
      { path: "/mnt/user-data/outputs/kept.txt", size: 4, content_type: "text/plain" },
    ]),
    [`${ORG}conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fkept.txt`]: () => md("keep"),
  });
  const done = await collectChats([[CHAT, "n", "s"]], { fetch, orgPath: ORG });
  assert.equal(done.fileCount, 1);
  assert.deepEqual(done.results[0].files.map((f) => f.path), ["/mnt/user-data/outputs/kept.txt"]);
  assert.equal(calls.length, 2, "the uploads file was listed but never downloaded");
});

test("collectChats records a size_mismatch when the blob is shorter than the meta said", async () => {
  const { fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => listing([
      { path: "/mnt/user-data/outputs/truncated.md", size: 500, content_type: "text/markdown" },
    ]),
    [`${ORG}conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Ftruncated.md`]: () => md("hi"),
  });
  const done = await collectChats([[CHAT, "n", "s"]], { fetch, orgPath: ORG });
  assert.equal(done.results[0].files[0].size_mismatch, 2, "the blob's real size is recorded");
  assert.equal(done.failed, 0, "a size mismatch is recorded, not failed");
});

test("a failing list-files puts the ported error on entry.error, and later chats still run", async () => {
  const other = "bbbb2222-2222-4333-8444-555555555555";
  const { fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => ({ status: 500 }),
    [`${ORG}conversations/${other}/wiggle/list-files?prefix=`]: () => listing([
      { path: "/mnt/user-data/outputs/ok.md", size: 2, content_type: "text/markdown" },
    ]),
    [`${ORG}conversations/${other}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fok.md`]: () => md("ok"),
  });
  const done = await collectChats([[CHAT, "n", "s"], [other, "n2", "s2"]], { fetch, orgPath: ORG });
  assert.equal(done.failed, 1, "only the errored chat counts as failed");
  assert.deepEqual(done.results[0].files, [], "nothing arrived for the dead chat");
  assert.equal(done.results[0].error, "500 list-files?prefix=",
    "the script's exact get-message: status plus the part after /wiggle/");
  assert.equal(done.results[1].error, undefined, "the later chat ran anyway");
  assert.equal(done.results[1].files[0].text, "ok");
});

test("a listing with no files_metadata puts the shape error on entry.error, and later chats still run", async () => {
  const other = "bbbb2222-2222-4333-8444-555555555555";
  const { fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => ({ json: {} }),
    [`${ORG}conversations/${other}/wiggle/list-files?prefix=`]: () => listing([
      { path: "/mnt/user-data/outputs/ok.md", size: 2, content_type: "text/markdown" },
    ]),
    [`${ORG}conversations/${other}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fok.md`]: () => md("ok"),
  });
  const done = await collectChats([[CHAT, "n", "s"], [other, "n2", "s2"]], { fetch, orgPath: ORG });
  assert.equal(done.failed, 1, "the malformed listing counts as failed");
  assert.deepEqual(done.results[0].files, [], "nothing arrived for the dead chat");
  assert.equal(done.results[0].error, "list-files: no files_metadata (the API shape changed)",
    "a silent zero-file chat and an API-shape drift must not look the same");
  assert.equal(done.results[1].error, undefined, "the later chat ran anyway");
  assert.equal(done.results[1].files[0].text, "ok");
});

test("a listing whose files_metadata isn't an array is refused the same way", async () => {
  const { fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => ({ json: { files_metadata: "not a list" } }),
  });
  const done = await collectChats([[CHAT, "n", "s"]], { fetch, orgPath: ORG });
  assert.equal(done.failed, 1);
  assert.equal(done.results[0].error, "list-files: no files_metadata (the API shape changed)");
  assert.deepEqual(done.results[0].files, []);
});

test("a null listing is refused the same way", async () => {
  // list-files answering the JSON null would TypeError on property access; the
  // guard's optional chain routes it to the shape message instead
  const { fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => ({ json: null }),
  });
  const done = await collectChats([[CHAT, "n", "s"]], { fetch, orgPath: ORG });
  assert.equal(done.failed, 1);
  assert.equal(done.results[0].error, "list-files: no files_metadata (the API shape changed)");
  assert.deepEqual(done.results[0].files, []);
});

test("a failure mid-download keeps the files fetched before it, alongside the error", async () => {
  const { fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => listing([
      { path: "/mnt/user-data/outputs/good.md", size: 4, content_type: "text/markdown" },
      { path: "/mnt/user-data/outputs/dead.png", size: 3, content_type: "image/png" },
    ]),
    [`${ORG}conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fgood.md`]: () => md("good"),
    [`${ORG}conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fdead.png`]: () => ({ status: 500 }),
  });
  const done = await collectChats([[CHAT, "n", "s"]], { fetch, orgPath: ORG });
  const entry = done.results[0];
  assert.equal(entry.error, "500 download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fdead.png");
  assert.deepEqual(entry.files.map((f) => f.path), ["/mnt/user-data/outputs/good.md"],
    "partial files and the error coexist — script behavior");
  assert.equal(done.failed, 1);
  assert.equal(done.fileCount, 1, "only the file that fully arrived counts");
});

test("onProgress fires after each chat with (done, total, fileCount)", async () => {
  const other = "bbbb2222-2222-4333-8444-555555555555";
  const { fetch } = wiggleFetch({
    [`${ORG}conversations/${CHAT}/wiggle/list-files?prefix=`]: () => listing([
      { path: "/mnt/user-data/outputs/a.md", size: 1, content_type: "text/markdown" },
    ]),
    [`${ORG}conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fa.md`]: () => md("a"),
    [`${ORG}conversations/${other}/wiggle/list-files?prefix=`]: () => ({ status: 500 }),
  });
  const seen = [];
  const done = await collectChats([[CHAT, "n", "s"], [other, "n2", "s2"]], {
    fetch, orgPath: ORG, onProgress: (d, t, n) => seen.push([d, t, n]),
  });
  assert.deepEqual(seen, [[1, 2, 1], [2, 2, 1]],
    "per chat: the count of finished chats, the total, and the running file count");
  assert.equal(done.failed, 1);
});

// --- outputsName: the UTC date slice, the script's behavior

test("outputsName slices the UTC date, not the local one", () => {
  // 2026-11-04 22:50 in -05:00 is already 2026-11-05 UTC — the name carries the UTC day
  assert.equal(outputsName(new Date("2026-11-04T22:50:00-05:00")), "claude-chat-outputs-2026-11-05.json");
  assert.equal(outputsName(new Date("2026-11-04T12:00:00Z")), "claude-chat-outputs-2026-11-04.json");
});
