import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertStatus,
  composeScale,
  delay,
  deployAndPromote,
  gatewayWorkerId,
  runtimeInternalPost,
  uniqueNs,
  waitUntil,
  withServiceStopped,
  responseJson,
  queueDelayedKey,
  queueDlqKey,
  queueStreamKey,
} from "./helpers/index.js";
import { redisXLen, redisXPendingCount, redisZCard } from "./helpers/redis.js";
import {
  ALWAYS_THROWS_QUEUE_CONSUMER,
  ATTEMPT_RECORDER_THROWS_QUEUE_CONSUMER,
  DELIVERY_SET_RECORDER,
  QUEUE_MEMORY_CONSUMER,
  RETRY_ONCE_QUEUE_CONSUMER,
  deployConsumer,
  deployQueueProducer,
  readConsumerKeys,
  readConsumerMessage,
  sendQueueMessage,
  setupQueueIntegrationSuite,
} from "./helpers/queue-scenarios.js";

setupQueueIntegrationSuite();

test("handler throw → implicit retryAll → default retry delay → second attempt delivered", async () => {
  const ns = uniqueNs("q");

  const consumerVersion = await deployConsumer(ns, RETRY_ONCE_QUEUE_CONSUMER, [
    { queue: "retryq", maxBatchSize: 1, maxBatchTimeoutMs: 2000, maxRetries: 3, retryDelaySeconds: 2 },
  ]);

  const producerVersion = await deployQueueProducer(ns, "retryq");

  sendQueueMessage(ns, "producer", producerVersion, { retry_me: true });

  await waitUntil("implicit retry moved to delayed ZSET", async () => {
    return redisZCard(queueDelayedKey(ns, "retryq"), { db: 1 }) !== 0;
  }, { timeoutMs: 20_000, intervalMs: 1_000 });

  await waitUntil("retried message delivered", async () => {
    return readConsumerKeys(ns, consumerVersion).length > 0;
  }, { timeoutMs: 45_000, intervalMs: 1_000 });

  const keys = readConsumerKeys(ns, consumerVersion);
  assert.ok(keys.length >= 1);

  const msg = readConsumerMessage(ns, consumerVersion, keys[0]);
  assert.deepEqual(msg.body, { retry_me: true });
  assert.ok(msg.attempts >= 2, `Expected attempts >= 2, got ${msg.attempts}`);
});

test("maxRetries caps implicit retry — bad message goes to DLQ, not looped forever", async () => {
  const ns = uniqueNs("q");

  await deployConsumer(ns, ALWAYS_THROWS_QUEUE_CONSUMER, [
    { queue: "capq", maxBatchSize: 1, maxBatchTimeoutMs: 2000, maxRetries: 2 },
  ]);

  const producerVersion = await deployQueueProducer(ns, "capq");

  sendQueueMessage(ns, "producer", producerVersion, { poison: true });

  await waitUntil("message moved to DLQ", async () => {
    return redisXLen(queueDlqKey(ns, "capq"), { db: 1 }) !== 0;
  }, { timeoutMs: 30_000, intervalMs: 1_000 });

  const streamLen = redisXLen(queueStreamKey(ns, "capq"), { db: 1 });
  assert.equal(streamLen, 0, `Main stream should be empty, got XLEN=${streamLen}`);

  const dlqLen = redisXLen(queueDlqKey(ns, "capq"), { db: 1 });
  assert.equal(dlqLen, 1, `DLQ should have 1 entry, got ${dlqLen}`);
});

test("maxRetries=N means handler sees the message N+1 times before DLQ", async () => {
  const ns = uniqueNs("q");

  const consumerVersion = await deployConsumer(ns, ATTEMPT_RECORDER_THROWS_QUEUE_CONSUMER, [
    { queue: "retry-count-q", maxBatchSize: 1, maxBatchTimeoutMs: 2000, maxRetries: 2 },
  ]);

  const producerVersion = await deployQueueProducer(ns, "retry-count-q");

  sendQueueMessage(ns, "producer", producerVersion, { count_me: true });

  // Wait for DLQ — by then the handler has seen every attempt.
  await waitUntil("message reached DLQ", async () => {
    return redisXLen(queueDlqKey(ns, "retry-count-q"), { db: 1 }) !== 0;
  }, { timeoutMs: 30_000, intervalMs: 1_000 });

  const seen = responseJson(runtimeInternalPost("/", {
    "x-worker-id": gatewayWorkerId(ns, "consumer", consumerVersion),
  }, ""));
  assert.deepEqual(seen, [1, 2, 3],
    `maxRetries=2 should yield attempts [1,2,3] (1 initial + 2 retries), got ${JSON.stringify(seen)}`);
});

test("producer delivery_delay default → message appears after delay", async () => {
  const ns = uniqueNs("q");

  const consumerVersion = await deployConsumer(ns, QUEUE_MEMORY_CONSUMER, [
    { queue: "delayq", maxBatchSize: 10, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);

  const DELAY_PRODUCER = `
  export default {
    async fetch(req, env) {
      const body = await req.json();
      if (body.delay === undefined) await env.MY_Q.send(body.msg);
      else await env.MY_Q.send(body.msg, { delaySeconds: body.delay });
      return new Response("ok");
    },
  };`;

  const producerVersion = await deployAndPromote(ns, "producer", {
    code: DELAY_PRODUCER,
    bindings: { MY_Q: { type: "queue", id: "delayq", deliveryDelaySeconds: 3 } },
  });

  const sendRes = sendQueueMessage(ns, "producer", producerVersion, { msg: { delayed: true } });
  assertStatus(sendRes, 200, "delayed producer send");

  // Delayed sends must not touch the main stream until the wall-clock
  // dispatcher promotes them.
  assert.equal(redisXLen(queueStreamKey(ns, "delayq"), { db: 1 }), 0, "Message should not be in main stream immediately");
  assert.equal(redisZCard(queueDelayedKey(ns, "delayq"), { db: 1 }), 1, "Message should be in delayed ZSET");

  await waitUntil("delayed message delivered", async () => {
    return readConsumerKeys(ns, consumerVersion).length > 0;
  }, { timeoutMs: 30_000, intervalMs: 1_000 });

  const keys = readConsumerKeys(ns, consumerVersion);
  assert.ok(keys.length >= 1);
  const msg = readConsumerMessage(ns, consumerVersion, keys[0]);
  assert.deepEqual(msg.body, { delayed: true });
  assert.equal(msg.queue, "delayq");
});

test("scheduler replicas: delayed queue promotion claims each due member once", async () => {
  const ns = uniqueNs("qdelreplica");
  const queueName = "delayq";
  const bodies = Array.from({ length: 8 }, (_, i) => ({ id: `delay-${i}` }));

  const consumerVersion = await deployConsumer(ns, DELIVERY_SET_RECORDER, [
    { queue: queueName, maxBatchSize: 4, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);

  const DELAY_PRODUCER = `
  export default {
    async fetch(req, env) {
      const messages = await req.json();
      for (const msg of messages) {
        await env.MY_Q.send(msg, { delaySeconds: 1 });
      }
      return new Response("ok");
    },
  };`;
  const producerVersion = await deployAndPromote(ns, "producer", {
    code: DELAY_PRODUCER,
    bindings: { MY_Q: { type: "queue", id: queueName } },
  });

  await withServiceStopped("scheduler", async () => {
    const sendRes = sendQueueMessage(ns, "producer", producerVersion, bodies);
    assertStatus(sendRes, 200, "delayed replica producer send");

    await waitUntil("delayed members parked before replica promotion", async () => {
      return redisZCard(queueDelayedKey(ns, queueName), { db: 1 }) === bodies.length;
    }, { timeoutMs: 10_000, intervalMs: 500 });
    await delay(1_300);

    composeScale("scheduler", 2);

    const consumerWorkerId = gatewayWorkerId(ns, "consumer", consumerVersion);
    await waitUntil("all delayed messages promoted exactly once", async () => {
      const res = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
      if (res.status !== 200) return false;
      const snap = responseJson(res);
      return snap.deliveries.length === bodies.length;
    }, { timeoutMs: 30_000, intervalMs: 500 });

    await delay(2_000);
    const finalRes = runtimeInternalPost("/", { "x-worker-id": consumerWorkerId }, "");
    assertStatus(finalRes, 200, "delayed replica final fetch");
    const snap = responseJson(finalRes);
    assert.equal(snap.deliveries.length, bodies.length, finalRes.body);
    assert.deepEqual(
      [...new Set(snap.bodies.map((/** @type {any} */ body) => body.id))].toSorted(),
      bodies.map((body) => body.id).toSorted()
    );
    const streamKey = queueStreamKey(ns, queueName);
    assert.equal(redisZCard(queueDelayedKey(ns, queueName), { db: 1 }), 0);
    assert.equal(redisXLen(streamKey, { db: 1 }), 0);
    assert.equal(redisXPendingCount(streamKey, "wdl-scheduler", { db: 1 }), 0);
  });
});

test("delayed queue wake lets a later near-term message beat an older far-future one", async () => {
  const ns = uniqueNs("q");

  const consumerVersion = await deployConsumer(ns, QUEUE_MEMORY_CONSUMER, [
    { queue: "wakeq", maxBatchSize: 10, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);

  const producerVersion = await deployAndPromote(ns, "producer", {
    code: `
    export default {
      async fetch(req, env) {
        const body = await req.json();
        await env.MY_Q.send(body.msg, { delaySeconds: body.delay });
        return new Response("ok");
      },
    };`,
    bindings: { MY_Q: { type: "queue", id: "wakeq" } },
  });

  const headers = {
    "x-worker-id": gatewayWorkerId(ns, "producer", producerVersion),
    "content-type": "application/json",
  };

  composeScale("scheduler", 2);
  try {
    runtimeInternalPost("/", headers, { msg: { id: "far" }, delay: 60 });
    await waitUntil("far-future delayed message is parked", async () => {
      return redisZCard(queueDelayedKey(ns, "wakeq"), { db: 1 }) === 1;
    }, { timeoutMs: 10_000, intervalMs: 500 });
    await delay(1000);

    runtimeInternalPost("/", headers, { msg: { id: "near" }, delay: 2 });

    await waitUntil("near delayed message delivered before far-future item", async () => {
      const keys = readConsumerKeys(ns, consumerVersion);
      if (!Array.isArray(keys) || keys.length === 0) return false;
      for (const key of keys) {
        const msg = readConsumerMessage(ns, consumerVersion, key);
        if (msg?.body?.id === "near") return true;
      }
      return false;
    }, { timeoutMs: 12_000, intervalMs: 500 });
  } finally {
    composeScale("scheduler", 1);
  }
});

test("retry with delaySeconds routes through delayed ZSET before redelivery", async () => {
  const ns = uniqueNs("q");

  const DELAY_RETRY_CONSUMER = `
  const store = {};
  export default {
    async fetch(req) {
      const url = new URL(req.url);
      const key = url.searchParams.get("key");
      if (key) return Response.json(store[key] ?? null);
      return Response.json(Object.keys(store));
    },
    async queue(batch) {
      for (const msg of batch.messages) {
        if (msg.attempts === 1) {
          msg.retry({ delaySeconds: 2 });
        } else {
          store[msg.id] = { body: msg.body, attempts: msg.attempts };
          msg.ack();
        }
      }
    },
  };`;

  const consumerVersion = await deployConsumer(ns, DELAY_RETRY_CONSUMER, [
    { queue: "dretryq", maxBatchSize: 1, maxBatchTimeoutMs: 2000, maxRetries: 3 },
  ]);

  const producerVersion = await deployQueueProducer(ns, "dretryq");

  sendQueueMessage(ns, "producer", producerVersion, { retry_delayed: true });

  await waitUntil("delayed retry delivered", async () => {
    return readConsumerKeys(ns, consumerVersion).length > 0;
  }, { timeoutMs: 45_000, intervalMs: 1_000 });

  const keys = readConsumerKeys(ns, consumerVersion);
  assert.ok(keys.length >= 1);
  const msg = readConsumerMessage(ns, consumerVersion, keys[0]);
  assert.deepEqual(msg.body, { retry_delayed: true });
  assert.ok(msg.attempts >= 2, `Expected attempts >= 2, got ${msg.attempts}`);
});
