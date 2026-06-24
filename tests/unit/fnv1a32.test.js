import assert from "node:assert/strict";
import { test } from "node:test";

import { fnv1a32CodeUnits, fnv1a32Utf8 } from "../../shared/fnv1a32.js";

test("fnv1a32 helpers preserve ASCII compatibility", () => {
  assert.equal(fnv1a32Utf8("tenant-a:main"), fnv1a32CodeUnits("tenant-a:main"));
  assert.equal(fnv1a32Utf8("room-a"), 2391048956);
});

test("fnv1a32 helpers expose encoding-specific behavior for non-ASCII inputs", () => {
  assert.notEqual(fnv1a32Utf8("房间"), fnv1a32CodeUnits("房间"));
});
