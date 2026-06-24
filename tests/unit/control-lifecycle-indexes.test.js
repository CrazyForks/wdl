import assert from "node:assert/strict";
import { test } from "node:test";
import { importRepositoryModule } from "../helpers/load-shared-module.js";

const {
  cronRefMember,
  cronSlotKey,
  cronWorkerKey,
  stageCronSlotRef,
  stageCronWorkerIndexed,
  stageCronWorkerRemoved,
  stageD1ReferrerAdds,
  stageD1ReferrerRemovals,
  stageQueueConsumerProjection,
} = await importRepositoryModule("control/lifecycle-indexes.js", [
  [/import \{[\s\S]*?\} from "control-lib";/,
    `const d1DatabaseReferrersKey = (ns, databaseId) => \`d1db:\${ns}:\${databaseId}:referrers\`;
const encodeReferrerMember = ({ callerNs, callerWorker, callerVersion, binding }) =>
  [callerNs, callerWorker, callerVersion, binding].join("\\t");
const referrersKey = (ns, worker, version) => \`referrers:\${ns}:\${worker}:\${version}\`;
const workerVersionsKey = (ns, worker) => \`worker-versions:\${ns}:\${worker}\`;
const workersIndexKey = (ns) => \`workers:\${ns}\`;`],
  [/import \{ QUEUE_CONSUMER_INDEX_KEY, queueConsumerKey \} from "shared-queue-keys";/,
    `const QUEUE_CONSUMER_INDEX_KEY = "queue-consumer-index";
const queueConsumerKey = (ns, queue) => \`queue-consumer:\${ns}:\${queue}\`;`],
]);

function recordMulti() {
  /** @type {unknown[][]} */
  const calls = [];
  const multi = {
    calls,
    /** @param {unknown[]} args */
    del(...args) {
      calls.push(["del", ...args]);
      return this;
    },
    /** @param {unknown[]} args */
    hSet(...args) {
      calls.push(["hSet", ...args]);
      return this;
    },
    /** @param {unknown[]} args */
    expireAt(...args) {
      calls.push(["expireAt", ...args]);
      return this;
    },
    /** @param {unknown[]} args */
    sAdd(...args) {
      calls.push(["sAdd", ...args]);
      return this;
    },
    /** @param {unknown[]} args */
    sRem(...args) {
      calls.push(["sRem", ...args]);
      return this;
    },
  };
  return multi;
}

test("cron worker index helpers maintain non-authoritative discovery members", () => {
  const multi = recordMulti();
  stageCronWorkerIndexed(multi, "tenant", "worker");
  stageCronWorkerRemoved(multi, "tenant", "worker");

  assert.deepEqual(multi.calls, [
    ["sAdd", "cron:index:workers", "crons:tenant:worker"],
    ["sRem", "cron:index:workers", "crons:tenant:worker"],
  ]);
});

test("cron key helpers compose worker, slot, and ref members", () => {
  assert.equal(cronWorkerKey("tenant", "worker"), "crons:tenant:worker");
  assert.equal(cronSlotKey(1_778_856_600_000), "cron-slot:1778856600000");
  assert.equal(cronRefMember("tenant", "worker", "cron-1", 7), "tenant:worker:cron-1:7");
});

test("stageCronSlotRef writes ref and expiry together", () => {
  const multi = recordMulti();
  stageCronSlotRef(multi, "tenant", "worker", {
    id: "cron-1",
    gen: 7,
    slot: 1_778_856_600_000,
  });

  assert.deepEqual(multi.calls, [
    ["sAdd", "cron-slot:1778856600000", "tenant:worker:cron-1:7"],
    ["expireAt", "cron-slot:1778856600000", 1_778_857_200],
  ]);
});

test("stageQueueConsumerProjection writes full optional queue consumer fields", () => {
  const multi = recordMulti();
  stageQueueConsumerProjection(multi, "tenant", "worker", "v3", {
    queue: "jobs",
    maxBatchSize: 10,
    maxBatchTimeoutMs: 250,
    maxRetries: 4,
    deadLetterQueue: "jobs-dlq",
    retryDelaySeconds: 0,
  });

  assert.deepEqual(multi.calls, [
    ["del", "queue-consumer:tenant:jobs"],
    [
      "hSet",
      "queue-consumer:tenant:jobs",
      {
        worker: "worker",
        version: "v3",
        max_batch_size: "10",
        max_batch_timeout_ms: "250",
        max_retries: "4",
        dead_letter_queue: "jobs-dlq",
        retry_delay_secs: "0",
      },
    ],
    ["sAdd", "queue-consumer-index", "queue-consumer:tenant:jobs"],
  ]);
});

test("stageQueueConsumerProjection omits absent optional queue consumer fields", () => {
  const multi = recordMulti();
  stageQueueConsumerProjection(multi, "tenant", "worker", "v3", {
    queue: "jobs",
    maxBatchSize: 10,
    maxBatchTimeoutMs: 250,
    maxRetries: 4,
  });

  assert.deepEqual(multi.calls[1], [
    "hSet",
    "queue-consumer:tenant:jobs",
    {
      worker: "worker",
      version: "v3",
      max_batch_size: "10",
      max_batch_timeout_ms: "250",
      max_retries: "4",
    },
  ]);
});

test("stageQueueConsumerProjection preserves retryDelaySeconds zero without dead letter queue", () => {
  const multi = recordMulti();
  stageQueueConsumerProjection(multi, "tenant", "worker", "v3", {
    queue: "jobs",
    maxBatchSize: 10,
    maxBatchTimeoutMs: 250,
    maxRetries: 4,
    retryDelaySeconds: 0,
  });

  assert.deepEqual(multi.calls[1][2], {
    worker: "worker",
    version: "v3",
    max_batch_size: "10",
    max_batch_timeout_ms: "250",
    max_retries: "4",
    retry_delay_secs: "0",
  });
});

test("stageD1Referrer helpers use caller-provided database id accessor", () => {
  const refs = [
    {
      binding: "DB",
      databaseId: "frozen-db",
      resolvedDatabaseId: "resolved-db",
    },
  ];

  const adds = recordMulti();
  stageD1ReferrerAdds(adds, {
    ns: "tenant",
    worker: "caller",
    version: "v2",
    refs,
    databaseIdFor: (/** @type {any} */ ref) => ref.resolvedDatabaseId,
  });
  assert.deepEqual(adds.calls, [
    ["sAdd", "d1db:tenant:resolved-db:referrers", "tenant\tcaller\tv2\tDB"],
  ]);

  const removals = recordMulti();
  stageD1ReferrerRemovals(removals, {
    ns: "tenant",
    worker: "caller",
    version: "v2",
    refs,
    databaseIdFor: (/** @type {any} */ ref) => ref.databaseId,
  });
  assert.deepEqual(removals.calls, [
    ["sRem", "d1db:tenant:frozen-db:referrers", "tenant\tcaller\tv2\tDB"],
  ]);
});
