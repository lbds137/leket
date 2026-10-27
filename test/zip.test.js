// src/lib/zip.js: the zips it writes open in Python's zipfile with every CRC right.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipWriter, crc32 } from "../src/lib/zip.js";

const CHECK = fileURLToPath(new URL("./zipcheck.py", import.meta.url));
const enc = new TextEncoder();

async function read(blobs) {
  const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "zip-"));
  const paths = [];
  for (const [i, b] of blobs.entries()) {
    const p = join(dir, `${i}.zip`);
    writeFileSync(p, Buffer.from(await b.arrayBuffer()));
    paths.push(p);
  }
  const got = JSON.parse(execFileSync("python3", [CHECK, ...paths], { encoding: "utf8" }));
  return paths.map((p) => got[p]);
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("entries come back whole, names in UTF-8", async () => {
  const z = new ZipWriter();
  z.add("a.json", enc.encode('{"x": 1}'));
  z.add("discord-attachments/שלום_תמונה.png", new Uint8Array([0, 255, 1, 2]));
  z.add("empty.txt", new Uint8Array());
  const [files] = await read(z.parts());
  assert.deepEqual(Object.keys(files), ["a.json", "discord-attachments/שלום_תמונה.png", "empty.txt"]);
  assert.equal(files["a.json"], '{"x": 1}');
  assert.equal(files["discord-attachments/שלום_תמונה.png"], "\x00\xff\x01\x02");
  assert.equal(files["empty.txt"], "");
});

test("a new part starts past the limit, and a file bigger than the limit gets a part alone", async () => {
  const z = new ZipWriter({ partLimit: 300 });
  assert.equal(z.add("one", new Uint8Array(100)), 1);
  assert.equal(z.add("two", new Uint8Array(100)), 2);
  assert.equal(z.add("big", new Uint8Array(1000)), 3);
  assert.equal(z.add("three", new Uint8Array(10)), 4);
  const parts = await read(z.parts());
  assert.deepEqual(parts.map((p) => Object.keys(p)), [["one"], ["two"], ["big"], ["three"]]);
});

test("with onPart, every sealed part is handed over the moment it closes, none held back", async () => {
  const parts = [];
  const z = new ZipWriter({ partLimit: 300, onPart: (blob, n) => parts.push({ blob, n }) });
  assert.equal(z.add("one", new Uint8Array(100)), 1);
  assert.equal(z.add("two", new Uint8Array(100)), 2);
  assert.equal(z.add("big", new Uint8Array(1000)), 3);
  assert.equal(z.add("three", new Uint8Array(10)), 4);
  assert.deepEqual(z.parts(), []);
  const files = await read(parts.map((p) => p.blob));
  assert.deepEqual(files.map((p) => Object.keys(p)), [["one"], ["two"], ["big"], ["three"]]);
  assert.deepEqual(parts.map((p) => p.n), [1, 2, 3, 4]);
});

test("with onPart, a single-part writer hands over that one part and nothing else", async () => {
  const parts = [];
  const z = new ZipWriter({ onPart: (blob, n) => parts.push({ blob, n }) });
  z.add("a.json", enc.encode('{"x": 1}'));
  assert.deepEqual(z.parts(), []);
  assert.equal(parts.length, 1);
  const [files] = await read(parts.map((p) => p.blob));
  assert.deepEqual(Object.keys(files), ["a.json"]);
});

test("a Blob goes in with the crc32 worked out piece by piece", async () => {
  const a = enc.encode("hello "), b = enc.encode("world");
  assert.equal(crc32(b, crc32(a)), crc32(enc.encode("hello world")));
  const z = new ZipWriter();
  z.add("hw.txt", new Blob([a, b]), crc32(b, crc32(a)));
  assert.throws(() => z.add("no-crc", new Blob(["x"])), /needs its crc32/);
  const [files] = await read(z.parts());
  assert.equal(files["hw.txt"], "hello world");
});

test("an empty writer still gives one valid zip; a name used twice is refused", async () => {
  const [files] = await read(new ZipWriter().parts());
  assert.deepEqual(files, {});
  const z = new ZipWriter({ partLimit: 50 });
  z.add("x", new Uint8Array(40));
  assert.throws(() => z.add("x", new Uint8Array(40)), /two entries named x/);
});
