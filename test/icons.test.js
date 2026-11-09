// icons/: every PNG the manifest names is a PNG of the size it's listed at. The PNGs
// are drawn from icons/source/*.svg by hand; this catches a misnamed or wrong-size export,
// not a drift from the SVG (that would need a rasterizer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sizeOf = (path) => {
  const b = readFileSync(new URL(path, root));
  assert.ok(b.subarray(0, 8).equals(PNG), `${path} is a PNG`);
  assert.equal(b.toString("latin1", 12, 16), "IHDR", `${path} starts with its IHDR`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test("each icon the manifest lists is a square PNG of its listed size", () => {
  for (const icons of [manifest.icons, manifest.action.default_icon]) {
    assert.ok(Object.keys(icons).length > 0);
    for (const [size, path] of Object.entries(icons)) {
      assert.deepEqual(sizeOf(path), [Number(size), Number(size)], path);
    }
  }
});
