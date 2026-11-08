// src/lib/paste.js: the strip every paste box shares (known map, rename list, chat list).
// The parsers' own tests cover each box's shapes; these pin the cut itself.
import { test } from "node:test";
import assert from "node:assert/strict";

const { assignedJson } = await import("../src/lib/paste.js");

const SCRIPT = "(async () => {\n  const x = window.X || {};\n  console.log(x);\n})();\n";

test("the bare JSON, the line, and the line plus script all give the JSON text", () => {
  assert.equal(assignedJson('{"a":"1"}', "X"), '{"a":"1"}');
  assert.equal(assignedJson('window.X = {"a":"1"};', "X"), '{"a":"1"}');
  assert.equal(assignedJson('window.X = {"a":"1"}', "X"), '{"a":"1"}');
  assert.equal(assignedJson(`window.X = {"a":"1"};\n${SCRIPT}`, "X"), '{"a":"1"}');
  assert.equal(assignedJson(`  window.X = {"a":"1"}; \t\r\n${SCRIPT}`, "X"), '{"a":"1"}');
});

test("a `;` inside a JSON string never cuts: only a `;` that ends a line does", () => {
  const json = '{"a":"b;","c":"d; e"}';
  assert.equal(assignedJson(`window.X = ${json};\n${SCRIPT}`, "X"), json);
});

test("pretty-printed JSON in the line form keeps its lines up to the closing `;`", () => {
  const json = '{\n  "a": "1;",\n  "b": "2"\n}';
  assert.deepEqual(JSON.parse(assignedJson(`window.X = ${json};\n${SCRIPT}`, "X")), { a: "1;", b: "2" });
});

test("a line with no `;` and a script below can't be cut: the result is not JSON, so the caller refuses it", () => {
  const t = assignedJson(`window.X = {"a":"1"}\n${SCRIPT}`, "X");
  assert.throws(() => JSON.parse(t));
});

test("a same-line tail isn't cut either: the cut is at a line end only", () => {
  assert.throws(() => JSON.parse(assignedJson('window.X = {"a":"1"}; var q = 1;\n', "X")));
});

test("the name is literal: a dot in it matches only a dot", () => {
  assert.equal(assignedJson('window.AxB = {"a":"1"};', "A.B"), 'window.AxB = {"a":"1"}');
  assert.equal(assignedJson('window.A.B = {"a":"1"};', "A.B"), '{"a":"1"}');
});
