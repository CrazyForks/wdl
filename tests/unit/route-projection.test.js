import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PATTERN_PROJECTION_VERSION,
  decodePatternProjection,
  encodePatternProjection,
} from "../../shared/route-projection.js";

test("pattern projection encodes compact v2 slot values", () => {
  const encoded = encodePatternProjection({
    ns: "demo",
    worker: "api",
    version: "v7",
    kind: "prefix",
    value: "/api/",
  });
  assert.equal(encoded, `${PATTERN_PROJECTION_VERSION}\tdemo\tapi\tv7\tprefix\t/api/`);
  assert.deepEqual(decodePatternProjection(encoded), {
    ns: "demo",
    worker: "api",
    version: "v7",
    kind: "prefix",
    value: "/api/",
  });
});

test("pattern projection rejects malformed values", () => {
  assert.equal(decodePatternProjection(""), null);
  assert.equal(decodePatternProjection("v1\tdemo\tapi\tv7\tprefix\t/api/"), null);
  assert.equal(decodePatternProjection("v2\tdemo\tapi\tv7\tbad\t/api/"), null);
  assert.equal(decodePatternProjection("v2\tdemo\tapi\tv7\tprefix"), null);
  assert.throws(
    () => encodePatternProjection({
      ns: "demo",
      worker: "api",
      version: "v7",
      kind: "prefix",
      value: "/bad\tpath",
    }),
    /invalid pattern projection value/
  );
});
