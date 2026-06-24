import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateAssetsToken,
  assetsPrefixFor,
  ASSETS_TOKEN_RE,
} from "../../shared/assets-token.js";

test("generateAssetsToken: 28-hex string, time-sortable prefix", () => {
  const t0 = generateAssetsToken(0x010000000000); // 1-TB ms mark
  assert.match(t0, ASSETS_TOKEN_RE);
  assert.equal(t0.length, 28);
  // Leading 12 hex = ms timestamp. Monotonic ms should stay time-ordered.
  const a = generateAssetsToken(1_700_000_000_000);
  const b = generateAssetsToken(1_700_000_000_001);
  assert.ok(a < b, `expected ${a} < ${b}`);
});

test("generateAssetsToken: random tail differs for same timestamp", () => {
  const now = 1_700_000_000_000;
  const a = generateAssetsToken(now);
  const b = generateAssetsToken(now);
  assert.equal(a.slice(0, 12), b.slice(0, 12));
  assert.notEqual(a, b, "random tail must differ");
});

test("generateAssetsToken: rejects bad timestamps", () => {
  assert.throws(() => generateAssetsToken(-1), /bad timestamp/);
  assert.throws(() => generateAssetsToken(1.5), /bad timestamp/);
  assert.throws(() => generateAssetsToken(2 ** 48 + 1), /exceeds 48 bits/);
});

test("assetsPrefixFor: composes canonical prefix with trailing slash", () => {
  const token = "0".repeat(12) + "a".repeat(16);
  assert.equal(
    assetsPrefixFor("demo", "api", token),
    `assets/demo/api/${token}/`
  );
});

test("assetsPrefixFor: rejects malformed inputs", () => {
  const token = "0".repeat(12) + "a".repeat(16);
  assert.throws(() => assetsPrefixFor("", "api", token), /ns required/);
  assert.throws(() => assetsPrefixFor("demo", "", token), /worker required/);
  assert.throws(() => assetsPrefixFor("demo", "api", "nope"), /bad token/);
  assert.throws(() => assetsPrefixFor("demo", "api", "A".repeat(28)), /bad token/);
});
