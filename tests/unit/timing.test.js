import { test } from "node:test";
import assert from "node:assert/strict";
import { delay, waitUntil } from "../helpers/timing.js";

test("delay resolves after the requested timeout", async () => {
  const start = Date.now();
  await delay(5);
  assert.ok(Date.now() - start >= 0);
});

test("waitUntil retries until the condition succeeds", async () => {
  let attempts = 0;
  await waitUntil("unit condition", () => {
    attempts += 1;
    return attempts === 2;
  }, { timeoutMs: 100, intervalMs: 1 });
  assert.equal(attempts, 2);
});

test("waitUntil reports the last thrown error on timeout", async () => {
  await assert.rejects(
    () => waitUntil("unit timeout", () => {
      throw new Error("last failure");
    }, { timeoutMs: 5, intervalMs: 1 }),
    /timeout waiting for unit timeout: last failure/
  );
});
