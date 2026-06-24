// WDL Workflows pause/resume due-index paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_CODE,
  deployAndPromote,
  gatewayFetch,
  redisSIsMember,
  redisZScore,
  readIntegrationJson,
  setupIntegrationSuite,
  uniqueNs,
  waitUntil,
  workflowReadyShard,
  workflowReadyToken,
  workerMeta,
} from "./helpers/workflows-scenarios.js";

setupIntegrationSuite();

test("workflow pause fences a due sleeping step until resume", async () => {
  const ns = uniqueNs("wfpause-due");
  const version = await deployAndPromote(ns, "shop", {
    code: WORKER_CODE,
    vars: { LABEL: "runtime-ok" },
    workflows: [
      { name: "orders", binding: "ORDERS", className: "OrderWorkflow" },
    ],
  });
  const meta = workerMeta(ns, "shop", version);
  const workflowKey = meta.workflows[0].workflowKey;
  const instanceId = "pause-due-1";
  const token = workflowReadyToken(ns, workflowKey, instanceId);
  const shard = workflowReadyShard(ns, workflowKey, instanceId);
  const dueKey = `wf:due:${shard}`;
  const readyKey = `wf:ready:${shard}`;

  const created = await gatewayFetch(ns, `/shop/create?id=${instanceId}&sleepMs=8000`);
  await readIntegrationJson(created, 200, "workflow response");
  await waitUntil("workflow reaches sleep waiting state before pause", async () => {
    const status = await gatewayFetch(ns, `/shop/steps?id=${instanceId}`);
    const body = await readIntegrationJson(status, 200, "workflow response");
    return body.status === "waiting" &&
      body.steps.entries.some((/** @type {any} */ entry) => entry.name === "settle" && entry.status === "waiting");
  }, { timeoutMs: 60000, intervalMs: 250 });
  await waitUntil("sleep due token exists before pause", () =>
    redisZScore(dueKey, token, { db: 2 }) !== null,
  { timeoutMs: 5000, intervalMs: 100 });

  const paused = await gatewayFetch(ns, `/shop/pause?id=${instanceId}`);
  assert.equal((await readIntegrationJson(paused, 200, "workflow response")).status, "paused");
  assert.equal(redisZScore(dueKey, token, { db: 2 }), null);
  assert.equal(redisSIsMember(readyKey, token, { db: 2 }), false);

  const stillPaused = await gatewayFetch(ns, `/shop/steps?id=${instanceId}`);
  const stillPausedBody = await readIntegrationJson(stillPaused, 200, "workflow response");
  assert.equal(stillPausedBody.status, "paused");
  assert.deepEqual(stillPausedBody.steps.entries.map((/** @type {any} */ entry) => ({
    ordinal: entry.ordinal,
    name: entry.name,
    status: entry.status,
    attempt: entry.attempt,
  })), [
    { ordinal: 0, name: "settle", status: "waiting", attempt: 1 },
  ]);

  const resumed = await gatewayFetch(ns, `/shop/resume?id=${instanceId}`);
  assert.equal((await readIntegrationJson(resumed, 200, "workflow response")).status, "queued");
  await waitUntil("resume replay restores future sleep due token", async () => {
    const status = await gatewayFetch(ns, `/shop/steps?id=${instanceId}`);
    const body = await readIntegrationJson(status, 200, "workflow response");
    return body.status === "waiting" &&
      redisSIsMember(readyKey, token, { db: 2 }) === false &&
      redisZScore(dueKey, token, { db: 2 }) !== null;
  }, { timeoutMs: 10000, intervalMs: 100 });

  /** @type {any} */
  let completedBody;
  await waitUntil("paused due workflow completes after resume", async () => {
    const status = await gatewayFetch(ns, `/shop/steps?id=${instanceId}`);
    completedBody = await readIntegrationJson(status, 200, "workflow response");
    return completedBody.status === "completed";
  }, { timeoutMs: 60000, intervalMs: 250 });
  assert.deepEqual(completedBody.output, {
    slept: true,
    instanceId,
    fromEnv: "runtime-ok",
  });
  assert.equal(completedBody.steps.entries.length, 2);
});

test("workflow pause restores retry-delay due index before resume completes", async () => {
  const ns = uniqueNs("wfpause-retry");
  const version = await deployAndPromote(ns, "shop", {
    code: WORKER_CODE,
    vars: { LABEL: "runtime-ok" },
    workflows: [
      { name: "orders", binding: "ORDERS", className: "OrderWorkflow" },
    ],
  });
  const meta = workerMeta(ns, "shop", version);
  const workflowKey = meta.workflows[0].workflowKey;
  const instanceId = "pause-retry-1";
  const token = workflowReadyToken(ns, workflowKey, instanceId);
  const shard = workflowReadyShard(ns, workflowKey, instanceId);
  const dueKey = `wf:due:${shard}`;
  const readyKey = `wf:ready:${shard}`;

  const created = await gatewayFetch(ns, `/shop/create?id=${instanceId}&retry=1&retryDelayMs=8000`);
  await readIntegrationJson(created, 200, "workflow response");
  await waitUntil("workflow reaches retry-delay waiting state before pause", async () => {
    const status = await gatewayFetch(ns, `/shop/steps?id=${instanceId}`);
    const body = await readIntegrationJson(status, 200, "workflow response");
    return body.status === "waiting" &&
      body.steps.entries.some((/** @type {any} */ entry) =>
        entry.name === "flaky" &&
        entry.status === "waiting" &&
        entry.attempt === 1
      );
  }, { timeoutMs: 60000, intervalMs: 250 });
  await waitUntil("retry due token exists before pause", () =>
    redisZScore(dueKey, token, { db: 2 }) !== null,
  { timeoutMs: 5000, intervalMs: 100 });

  const paused = await gatewayFetch(ns, `/shop/pause?id=${instanceId}`);
  assert.equal((await readIntegrationJson(paused, 200, "workflow response")).status, "paused");
  assert.equal(redisZScore(dueKey, token, { db: 2 }), null);
  assert.equal(redisSIsMember(readyKey, token, { db: 2 }), false);

  const resumed = await gatewayFetch(ns, `/shop/resume?id=${instanceId}`);
  assert.equal((await readIntegrationJson(resumed, 200, "workflow response")).status, "queued");
  await waitUntil("resume replay restores future retry due token", async () => {
    const status = await gatewayFetch(ns, `/shop/steps?id=${instanceId}`);
    const body = await readIntegrationJson(status, 200, "workflow response");
    return body.status === "waiting" &&
      body.steps.entries.some((/** @type {any} */ entry) =>
        entry.name === "flaky" &&
        entry.status === "waiting" &&
        entry.attempt === 1
      ) &&
      redisSIsMember(readyKey, token, { db: 2 }) === false &&
      redisZScore(dueKey, token, { db: 2 }) !== null;
  }, { timeoutMs: 10000, intervalMs: 100 });

  /** @type {any} */
  let completedBody;
  await waitUntil("paused retry-delay workflow completes after restored due", async () => {
    const status = await gatewayFetch(ns, `/shop/steps?id=${instanceId}`);
    completedBody = await readIntegrationJson(status, 200, "workflow response");
    return completedBody.status === "completed";
  }, { timeoutMs: 60000, intervalMs: 250 });
  assert.deepEqual(completedBody.output, { attempt: 2, fromEnv: "runtime-ok" });
  assert.deepEqual(completedBody.steps.entries.map((/** @type {any} */ entry) => ({
    ordinal: entry.ordinal,
    name: entry.name,
    status: entry.status,
    attempt: entry.attempt,
  })), [
    { ordinal: 0, name: "flaky", status: "completed", attempt: 2 },
  ]);
});
