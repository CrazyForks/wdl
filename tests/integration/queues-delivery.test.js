// Queue delivery core: producer send → Redis stream → scheduler consume
// loop → runtime /_queued → consumer worker queue() handler → ack.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertStatus,
  composeScale,
  delay,
  gatewayWorkerId,
  runtimeInternalPost,
  uniqueNs,
  waitUntil,
  withServiceStopped,
  responseJson,
  queueConsumerKey,
  QUEUE_CONSUMER_INDEX_KEY,
  queueStreamKey,
  queueStreamMessageFields,
} from "./helpers/index.js";
import {
  redisHSet,
  redisSRem,
  redisXAdd,
  redisXInfoGroups,
  redisXLen,
  redisXPendingCount,
} from "./helpers/redis.js";
import {
  DELIVERY_SET_RECORDER,
  QUEUE_MEMORY_CONSUMER,
  deployConsumer,
  deployQueueConsumerWorker,
  deployQueueProducer,
  setupQueueIntegrationSuite,
} from "./helpers/queue-scenarios.js";

setupQueueIntegrationSuite();

test("producer send() → consumer queue() end-to-end via scheduler", async () => {
  const ns = uniqueNs("q");

  const consumerVersion = await deployConsumer(ns, QUEUE_MEMORY_CONSUMER, [
    { queue: "orders", maxBatchSize: 10, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);

  const producerVersion = await deployQueueProducer(ns, "orders");

  const sendRes = runtimeInternalPost("/", {
    "x-worker-id": gatewayWorkerId(ns, "producer", producerVersion),
    "content-type": "application/json",
  }, { hello: "world" });
  assertStatus(sendRes, 200, "producer send");

  // Scheduler reconciles every QUEUE_RECONCILE_MS + BLOCK_MS worst case.
  const consumerWorkerId = gatewayWorkerId(ns, "consumer", consumerVersion);
  await waitUntil("queue message delivered", async () => {
    const res = runtimeInternalPost("/", {
      "x-worker-id": consumerWorkerId,
    }, "");
    if (res.status !== 200) return false;
    const keys = responseJson(res);
    return Array.isArray(keys) && keys.length > 0;
  }, { timeoutMs: 30_000, intervalMs: 1_000 });

  const keys = responseJson(runtimeInternalPost("/", {
    "x-worker-id": consumerWorkerId,
  }, ""));
  assert.ok(keys.length >= 1, `Expected at least 1 message, got ${keys.length}`);

  const firstMsg = responseJson(runtimeInternalPost(`/?key=${keys[0]}`, {
    "x-worker-id": consumerWorkerId,
  }, ""));
  assert.deepEqual(firstMsg.body, { hello: "world" });
  assert.equal(firstMsg.queue, "orders");
  assert.equal(firstMsg.attempts, 1);
});

test("scheduler replicas: queue consumer group delivers each message once under two replicas", async () => {
  const ns = uniqueNs("qreplica");
  const queueName = "orders";
  const bodies = Array.from({ length: 12 }, (_, i) => `body-${i}`);

  await withServiceStopped("scheduler", async () => {
    const consumerVersion = await deployConsumer(ns, DELIVERY_SET_RECORDER, [
      { queue: queueName, maxBatchSize: 3, maxBatchTimeoutMs: 2000, maxRetries: 3 },
    ]);

    const producerVersion = await deployQueueProducer(ns, queueName);

    const sendRes = runtimeInternalPost("/", {
      "x-worker-id": gatewayWorkerId(ns, "producer", producerVersion),
      "content-type": "application/json",
    }, bodies);
    assertStatus(sendRes, 200, "producer send");

    composeScale("scheduler", 2);

    const consumerWorkerId = gatewayWorkerId(ns, "consumer", consumerVersion);
    await waitUntil("all messages delivered once by scheduler replicas", async () => {
      const res = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
      if (res.status !== 200) return false;
      const snap = responseJson(res);
      return snap.deliveries.length === bodies.length;
    }, { timeoutMs: 30_000, intervalMs: 500 });

    await delay(2_000);
    const finalRes = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
    assertStatus(finalRes, 200, "consumer final fetch");
    const snap = responseJson(finalRes);
    assert.equal(snap.deliveries.length, bodies.length, finalRes.body);
    assert.deepEqual([...new Set(snap.bodies)].toSorted(), bodies.toSorted());
    const streamKey = queueStreamKey(ns, queueName);
    assert.equal(redisXLen(streamKey, { db: 1 }), 0);
    assert.equal(redisXPendingCount(streamKey, "wdl-scheduler", { db: 1 }), 0);
  });
});

test("queue dispatch rereads authoritative consumer hash before delivery", async () => {
  const ns = uniqueNs("qfresh");
  const queueName = "freshq";
  const streamKey = queueStreamKey(ns, queueName);
  const consumerKey = queueConsumerKey(ns, queueName);

  const v1 = await deployConsumer(ns, DELIVERY_SET_RECORDER, [
    { queue: queueName, maxBatchSize: 1, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);
  const v1WorkerId = gatewayWorkerId(ns, "consumer", v1);
  await waitUntil("consumer group created for initial version", async () => {
    const out = redisXInfoGroups(streamKey, { db: 1 });
    return !out.includes("missing") && out.includes("wdl-scheduler");
  }, { timeoutMs: 10_000, intervalMs: 500 });

  redisXAdd(
    streamKey,
    queueStreamMessageFields({ id: "before-promote", body: "before-promote", contentType: "text", firstSeenMs: 1 }),
    { db: 1 }
  );
  await waitUntil("initial version delivered first message", async () => {
    const res = runtimeInternalPost("/", { "x-worker-id": v1WorkerId }, "");
    if (res.status !== 200) return false;
    const snap = responseJson(res);
    return snap.bodies.includes("before-promote");
  }, { timeoutMs: 30_000, intervalMs: 500 });
  const v1SnapBeforePromote = responseJson(runtimeInternalPost("/", { "x-worker-id": v1WorkerId }, ""));
  assert.deepEqual(v1SnapBeforePromote.bodies, ["before-promote"]);

  const v2 = await deployQueueConsumerWorker(ns, "consumer-v2", DELIVERY_SET_RECORDER, []);
  const v2WorkerId = gatewayWorkerId(ns, "consumer-v2", v2);
  redisSRem(QUEUE_CONSUMER_INDEX_KEY, consumerKey);
  redisHSet(consumerKey, {
    worker: "consumer-v2",
    version: v2,
    max_batch_size: "1",
    max_batch_timeout_ms: "2000",
    max_retries: "3",
    retry_delay_secs: "0",
  });
  redisXAdd(
    streamKey,
    queueStreamMessageFields({ id: "after-promote", body: "after-promote", contentType: "text", firstSeenMs: 2 }),
    { db: 1 }
  );

  let deliveredToStaleVersion = false;
  await waitUntil("authoritative consumer hash used for next message", async () => {
    const v1Res = runtimeInternalPost("/", { "x-worker-id": v1WorkerId }, "");
    if (v1Res.status === 200 && responseJson(v1Res).bodies.includes("after-promote")) {
      deliveredToStaleVersion = true;
      return true;
    }
    const v2Res = runtimeInternalPost("/", { "x-worker-id": v2WorkerId }, "");
    if (v2Res.status !== 200) return false;
    return responseJson(v2Res).bodies.includes("after-promote");
  }, { timeoutMs: 30_000, intervalMs: 500 });
  assert.equal(deliveredToStaleVersion, false);
});
