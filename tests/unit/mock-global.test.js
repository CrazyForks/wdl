import { test } from "node:test";
import assert from "node:assert/strict";

import { installMockProperty, withMockedProperty } from "../helpers/mock-global.js";

test("installMockProperty removes properties that did not originally exist", () => {
  /** @type {Record<string, unknown>} */
  const target = {};
  const restore = installMockProperty(target, "missing", "mocked");

  assert.equal(target.missing, "mocked");
  restore();

  assert.equal(Object.hasOwn(target, "missing"), false);
});

test("installMockProperty detects out-of-order restores instead of leaking mocks", () => {
  const target = { value: "original" };
  const restoreA = installMockProperty(target, "value", "mock-a");
  const restoreB = installMockProperty(target, "value", "mock-b");

  assert.throws(() => restoreA(), /out of order/);
  assert.equal(target.value, "mock-b");

  restoreB();
  assert.equal(target.value, "mock-a");

  restoreA();
  assert.equal(target.value, "original");
});

test("withMockedProperty restores after callback failures", async () => {
  const target = { value: "original" };

  await assert.rejects(
    () => withMockedProperty(target, "value", "mocked", async () => {
      assert.equal(target.value, "mocked");
      throw new Error("boom");
    }),
    /boom/
  );

  assert.equal(target.value, "original");
});
