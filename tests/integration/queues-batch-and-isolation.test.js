import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertStatus,
  delay,
  gatewayWorkerId,
  runtimeInternalPost,
  uniqueNs,
  waitUntil,
  responseJson,
  queueStreamKey,
} from "./helpers/index.js";
import {
  BATCH_SIZE_RECORDER,
  BLOCKING_BATCH_RECORDER,
  FAST_QUEUE_CONSUMER,
  HANG_QUEUE_CONSUMER,
  deployConsumer,
  deployQueueConsumerWorker,
  deployQueueProducer,
  queuePendingCount,
  sendQueueMessage,
  setupQueueIntegrationSuite,
} from "./helpers/queue-scenarios.js";

setupQueueIntegrationSuite();

test("maxBatchSize caps runtime dispatch size for multi-message producer sends", async () => {
  const ns = uniqueNs("qcap");
  const consumerVersion = await deployConsumer(ns, BATCH_SIZE_RECORDER, [
    { queue: "cap", maxBatchSize: 2, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);

  const producerVersion = await deployQueueProducer(ns, "cap");

  // sendBatch of 5 lands as 5 XADDs in one request; scheduler must still
  // preserve the declared consumer batch cap.
  const sendRes = sendQueueMessage(ns, "producer", producerVersion, ["m1", "m2", "m3", "m4", "m5"]);
  assertStatus(sendRes, 200, "batch cap producer send");

  const consumerWorkerId = gatewayWorkerId(ns, "consumer", consumerVersion);
  await waitUntil("all 5 messages delivered", async () => {
    const res = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
    if (res.status !== 200) return false;
    const snap = responseJson(res);
    return snap.total === 5;
  }, { timeoutMs: 30_000, intervalMs: 500 });

  const finalRes = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
  const snapshot = responseJson(finalRes);
  assert.ok(
    snapshot.sizes.every((/** @type {number} */ n) => n <= 2),
    `every dispatched batch must be ≤ maxBatchSize=2, got ${JSON.stringify(snapshot.sizes)}`
  );
  assert.ok(
    snapshot.sizes.length >= 3,
    `5 messages at batch cap 2 must dispatch in ≥3 calls, got ${snapshot.sizes.length}: ${JSON.stringify(snapshot.sizes)}`
  );
});

test("fault injection: blocked queue dispatch keeps PEL within maxBatchSize", async () => {
  const ns = uniqueNs("qpelcap");
  const queueName = "cap";
  const bodies = ["m1", "m2", "m3", "m4", "m5"];
  const streamKey = queueStreamKey(ns, queueName);

  const consumerVersion = await deployConsumer(ns, BLOCKING_BATCH_RECORDER, [
    { queue: queueName, maxBatchSize: 2, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);

  const producerVersion = await deployQueueProducer(ns, queueName);

  const sendRes = sendQueueMessage(ns, "producer", producerVersion, bodies);
  assertStatus(sendRes, 200, "PEL cap producer send");

  await waitUntil("blocked dispatch owns its first PEL batch", async () => {
    return queuePendingCount(streamKey) > 0;
  }, { timeoutMs: 15_000, intervalMs: 250 });

  const firstPending = queuePendingCount(streamKey);
  assert.ok(
    firstPending > 0 && firstPending <= 2,
    `blocked dispatch must leave at most maxBatchSize=2 messages pending, got ${firstPending}`
  );

  await delay(1_000);
  const stillPending = queuePendingCount(streamKey);
  assert.ok(
    stillPending > 0 && stillPending <= 2,
    `scheduler must not prefetch beyond maxBatchSize while handler is blocked, got ${stillPending}`
  );

  const consumerWorkerId = gatewayWorkerId(ns, "consumer", consumerVersion);
  await waitUntil("all 5 blocked messages eventually delivered", async () => {
    const res = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
    if (res.status !== 200) return false;
    const snap = responseJson(res);
    return snap.total === bodies.length;
  }, { timeoutMs: 45_000, intervalMs: 500 });

  const finalRes = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
  const snapshot = responseJson(finalRes);
  assert.ok(
    snapshot.sizes.every((/** @type {number} */ n) => n <= 2),
    `every dispatched batch must be ≤ maxBatchSize=2, got ${JSON.stringify(snapshot.sizes)}`
  );
  assert.ok(
    snapshot.sizes.length >= 3,
    `5 blocked messages at batch cap 2 must dispatch in ≥3 calls, got ${snapshot.sizes.length}: ${JSON.stringify(snapshot.sizes)}`
  );
  assert.equal(queuePendingCount(streamKey), 0, "PEL must drain after blocked batches ack");
});

test("one queue's hung handler does not block other queues (HoL isolation)", async () => {
  const ns = uniqueNs("qhol");

  await deployQueueConsumerWorker(ns, "hang", HANG_QUEUE_CONSUMER, [
    { queue: "slow", maxBatchSize: 1, maxBatchTimeoutMs: 2000, maxRetries: 0 },
  ]);

  const fastVersion = await deployQueueConsumerWorker(ns, "fast", FAST_QUEUE_CONSUMER, [
    { queue: "fastq", maxBatchSize: 1, maxBatchTimeoutMs: 2000, maxRetries: 0 },
  ]);

  const slowProdVer = await deployQueueProducer(ns, "slow", "slow-prod");
  const fastProdVer = await deployQueueProducer(ns, "fastq", "fast-prod");

  // Seed slow first so XREADGROUP likely returns it alongside fastq in
  // the same poll; serial dispatch would then wait on slow's timeout.
  sendQueueMessage(ns, "slow-prod", slowProdVer, { hang: true });
  sendQueueMessage(ns, "fast-prod", fastProdVer, { fast: true });

  const fastConsumerId = gatewayWorkerId(ns, "fast", fastVersion);
  await waitUntil("fastq delivered while slow still hanging", async () => {
    const res = runtimeInternalPost("/", { "x-worker-id": fastConsumerId }, "");
    if (res.status !== 200) return false;
    const snap = responseJson(res);
    return snap.total >= 1;
  }, { timeoutMs: 25_000, intervalMs: 1_000 });
});
