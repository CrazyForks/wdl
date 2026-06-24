import { test } from "node:test";
import assert from "node:assert/strict";
import {
  delay,
  deployAndPromote,
  gatewayFetch,
  runtimeInternalGet,
  waitUntil,
  setupIntegrationSuite,
} from "./helpers/index.js";
import { parseCounters } from "./helpers/prometheus.js";

setupIntegrationSuite();

const ABORT_KEY = `wdl_loader_evictions_total{outcome="aborted",service="user-runtime"}`;

test("no-D1/R2 worker with function default is exposed as fetch handler", async () => {
  await deployAndPromote("runtime-fn-default", "app", {
    code: `
      export default function(request) {
        return new Response("fn:" + new URL(request.url).pathname);
      }
    `,
  });

  const response = await gatewayFetch("runtime-fn-default", "/app/hello");

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "fn:/hello");
});

test("promoting a new version triggers user-runtime to abort the previous loaded sibling", async () => {
  // user-runtime counters are process-local singletons across the suite;
  // assert deltas, not absolutes.
  const before = parseCounters(runtimeInternalGet("/_metrics"));
  const baseline = before.get(ABORT_KEY) ?? 0;

  // v1 load: gateway-routed fetch causes runtime to cold-load worker.
  await deployAndPromote("evict-rt", "victim", {
    code: "export default { fetch() { return new Response('v1'); } };",
  });
  const r1 = await gatewayFetch("evict-rt", "/victim");
  assert.equal(r1.status, 200);
  assert.equal(await r1.text(), "v1");

  // v2 promote: gateway invalidates routes:<ns>, next fetch cold-loads v2
  // and (in the runtime's `LOADER.get` factory wrap) schedules eviction of
  // already-loaded sibling versions of the same <ns>:<name>.
  await deployAndPromote("evict-rt", "victim", {
    code: "export default { fetch() { return new Response('v2'); } };",
  });
  const r2 = await gatewayFetch("evict-rt", "/victim");
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), "v2");

  // Eviction is fire-and-forget (ctx.waitUntil) — let drain finish before
  // scraping. abortIsolate's cache eviction itself is immediate per workerd
  // semantics, so the counter increments as soon as the abort RPC rejects
  // with `internal error; reference = ...`.
  await waitUntil(
    "user-runtime records the v1 sibling abort",
    () => {
      const after = parseCounters(runtimeInternalGet("/_metrics"));
      const observed = after.get(ABORT_KEY) ?? 0;
      return observed - baseline >= 1;
    },
    { timeoutMs: 10_000, intervalMs: 250 },
  );

  // Verify the increment is exactly 1: only one historical sibling existed
  // (v1), so we should not double-evict or chain into other namespaces.
  const after = parseCounters(runtimeInternalGet("/_metrics"));
  assert.equal((after.get(ABORT_KEY) ?? 0) - baseline, 1, "exactly one v1 abort");
});

test("a second cache hit on the new version does not re-trigger eviction (idempotent on cache miss only)", async () => {
  const before = parseCounters(runtimeInternalGet("/_metrics"));
  const baseline = before.get(ABORT_KEY) ?? 0;

  await deployAndPromote("evict-idem", "app", {
    code: "export default { fetch() { return new Response('v1'); } };",
  });
  await gatewayFetch("evict-idem", "/app");

  await deployAndPromote("evict-idem", "app", {
    code: "export default { fetch() { return new Response('v2'); } };",
  });
  await gatewayFetch("evict-idem", "/app");

  await waitUntil(
    "first eviction counted",
    () => {
      const after = parseCounters(runtimeInternalGet("/_metrics"));
      return ((after.get(ABORT_KEY) ?? 0) - baseline) >= 1;
    },
    { timeoutMs: 10_000, intervalMs: 250 },
  );
  const afterFirst = parseCounters(runtimeInternalGet("/_metrics"));
  const firstDelta = (afterFirst.get(ABORT_KEY) ?? 0) - baseline;

  // More v2 traffic — every subsequent gateway request hits the warm
  // workerLoader cache, factory does not run, so no further eviction
  // should be scheduled. Only cache miss is the trigger.
  for (let i = 0; i < 5; i++) {
    await gatewayFetch("evict-idem", "/app");
  }
  // Give any in-flight waitUntil a chance to settle before snapshotting.
  await delay(500);
  const afterSecond = parseCounters(runtimeInternalGet("/_metrics"));
  const secondDelta = (afterSecond.get(ABORT_KEY) ?? 0) - baseline;
  assert.equal(secondDelta, firstDelta, "no additional aborts on cache hits");
});

test("siblings in unrelated namespaces are not touched by an eviction trigger", async () => {
  const before = parseCounters(runtimeInternalGet("/_metrics"));
  const baseline = before.get(ABORT_KEY) ?? 0;

  // Pre-load two unrelated worker versions in different ns. They must
  // survive when evict-cross's later promote triggers eviction.
  await deployAndPromote("evict-cross-other-a", "app", {
    code: "export default { fetch() { return new Response('a'); } };",
  });
  await gatewayFetch("evict-cross-other-a", "/app");

  await deployAndPromote("evict-cross-other-b", "app", {
    code: "export default { fetch() { return new Response('b'); } };",
  });
  await gatewayFetch("evict-cross-other-b", "/app");

  await deployAndPromote("evict-cross", "app", {
    code: "export default { fetch() { return new Response('v1'); } };",
  });
  await gatewayFetch("evict-cross", "/app");

  await deployAndPromote("evict-cross", "app", {
    code: "export default { fetch() { return new Response('v2'); } };",
  });
  await gatewayFetch("evict-cross", "/app");

  await waitUntil(
    "evict-cross v1 abort recorded",
    () => {
      const after = parseCounters(runtimeInternalGet("/_metrics"));
      return ((after.get(ABORT_KEY) ?? 0) - baseline) >= 1;
    },
    { timeoutMs: 10_000, intervalMs: 250 },
  );

  // Other namespaces still serve traffic — their isolates were not aborted.
  const a = await gatewayFetch("evict-cross-other-a", "/app");
  assert.equal(a.status, 200);
  assert.equal(await a.text(), "a");
  const b = await gatewayFetch("evict-cross-other-b", "/app");
  assert.equal(b.status, 200);
  assert.equal(await b.text(), "b");

  // Total aborts attributable to this test should be exactly 1 (the
  // evict-cross v1). The unrelated ns isolates must not show up.
  const after = parseCounters(runtimeInternalGet("/_metrics"));
  assert.equal((after.get(ABORT_KEY) ?? 0) - baseline, 1);
});
