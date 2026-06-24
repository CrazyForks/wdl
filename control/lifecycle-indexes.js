import {
  d1DatabaseReferrersKey,
  encodeReferrerMember,
  referrersKey,
  workerVersionsKey,
  workersIndexKey,
} from "control-lib";
import { QUEUE_CONSUMER_INDEX_KEY, queueConsumerKey } from "shared-queue-keys";

export const CRON_WORKER_INDEX_KEY = "cron:index:workers";

/**
 * @typedef {import("shared-redis").RedisMulti} RedisMulti
 * @typedef {{ ns: string, worker: string, version: string, binding: string }} CallerReferrer
 * @typedef {{ targetNs: string, targetWorker: string, targetVersion: string, binding: string }} OutgoingRef
 * @typedef {{ binding: string, databaseId?: string, resolvedDatabaseId?: string }} D1Ref
 * @typedef {{ id: string, gen: number, slot: number }} CronIndexEntry
 * @typedef {{ queue: string, maxBatchSize: number, maxBatchTimeoutMs: number, maxRetries: number, retryDelaySeconds?: number, deadLetterQueue?: string }} QueueConsumer
 */

/** @param {CallerReferrer} referrer */
function callerReferrerMember({ ns, worker, version, binding }) {
  return encodeReferrerMember({
    callerNs: ns,
    callerWorker: worker,
    callerVersion: version,
    binding,
  });
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker */
export function stageWorkerVisible(multi, ns, worker) {
  multi.sAdd(workersIndexKey(ns), worker);
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker */
export function stageWorkerHidden(multi, ns, worker) {
  multi.sRem(workersIndexKey(ns), worker);
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker @param {string} version @param {number} versionNumber */
export function stageWorkerVersionIndexUpsert(multi, ns, worker, version, versionNumber) {
  stageWorkerVisible(multi, ns, worker);
  multi.zAdd(workerVersionsKey(ns, worker), versionNumber, version);
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker @param {string} version */
export function stageWorkerVersionIndexRemove(multi, ns, worker, version) {
  multi.zRem(workerVersionsKey(ns, worker), version);
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker */
export function stageWorkerVersionIndexDelete(multi, ns, worker) {
  multi.del(workerVersionsKey(ns, worker));
}

/** @param {string} ns @param {string} worker */
export function cronWorkerKey(ns, worker) {
  return `crons:${ns}:${worker}`;
}

/** @param {number} slotMs */
export function cronSlotKey(slotMs) {
  return `cron-slot:${slotMs}`;
}

/** @param {string} ns @param {string} worker @param {string} cronId @param {number} gen */
export function cronRefMember(ns, worker, cronId, gen) {
  return `${ns}:${worker}:${cronId}:${gen}`;
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker @param {CronIndexEntry} entry */
export function stageCronSlotRef(multi, ns, worker, entry) {
  const key = cronSlotKey(entry.slot);
  multi.sAdd(key, cronRefMember(ns, worker, entry.id, entry.gen));
  // Bound orphan refs (a crashed advance_ref leaves a member behind);
  // tick ignores slots >60s old, so 10min past slot wall-time is safe.
  multi.expireAt(key, Math.floor(entry.slot / 1000) + 600);
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker */
export function stageCronWorkerIndexed(multi, ns, worker) {
  multi.sAdd(CRON_WORKER_INDEX_KEY, cronWorkerKey(ns, worker));
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker */
export function stageCronWorkerRemoved(multi, ns, worker) {
  multi.sRem(CRON_WORKER_INDEX_KEY, cronWorkerKey(ns, worker));
}

/** @param {RedisMulti} multi @param {{ ns: string, worker: string, version: string, refs: OutgoingRef[] }} args */
export function stageOutgoingReferrerAdds(multi, { ns, worker, version, refs }) {
  for (const ref of refs) {
    multi.sAdd(
      referrersKey(ref.targetNs, ref.targetWorker, ref.targetVersion),
      callerReferrerMember({ ns, worker, version, binding: ref.binding })
    );
  }
}

/** @param {RedisMulti} multi @param {{ ns: string, worker: string, version: string, refs: OutgoingRef[] }} args */
export function stageOutgoingReferrerRemovals(multi, { ns, worker, version, refs }) {
  for (const ref of refs) {
    multi.sRem(
      referrersKey(ref.targetNs, ref.targetWorker, ref.targetVersion),
      callerReferrerMember({ ns, worker, version, binding: ref.binding })
    );
  }
}

/**
 * @param {RedisMulti} multi
 * @param {object} args
 * @param {string} args.ns
 * @param {string} args.worker
 * @param {string} args.version
 * @param {D1Ref[]} args.refs
 * @param {(ref: D1Ref) => string} args.databaseIdFor Caller-side D1 id accessor. Deploy paths
 * use `ref.resolvedDatabaseId` immediately after alias resolution; delete/version
 * read paths use `ref.databaseId` from frozen bundle metadata.
 */
export function stageD1ReferrerAdds(multi, { ns, worker, version, refs, databaseIdFor }) {
  for (const ref of refs) {
    multi.sAdd(
      d1DatabaseReferrersKey(ns, databaseIdFor(ref)),
      callerReferrerMember({ ns, worker, version, binding: ref.binding })
    );
  }
}

/**
 * @param {RedisMulti} multi
 * @param {object} args
 * @param {string} args.ns
 * @param {string} args.worker
 * @param {string} args.version
 * @param {D1Ref[]} args.refs
 * @param {(ref: D1Ref) => string} args.databaseIdFor Caller-side D1 id accessor. Deploy paths
 * use `ref.resolvedDatabaseId` immediately after alias resolution; delete/version
 * read paths use `ref.databaseId` from frozen bundle metadata.
 */
export function stageD1ReferrerRemovals(multi, { ns, worker, version, refs, databaseIdFor }) {
  for (const ref of refs) {
    multi.sRem(
      d1DatabaseReferrersKey(ns, databaseIdFor(ref)),
      callerReferrerMember({ ns, worker, version, binding: ref.binding })
    );
  }
}

/**
 * @param {string} worker
 * @param {string} version
 * @param {QueueConsumer} consumer
 * @returns {{ worker: string, version: string, max_batch_size: string, max_batch_timeout_ms: string, max_retries: string, dead_letter_queue?: string, retry_delay_secs?: string }}
 */
function queueConsumerFields(worker, version, consumer) {
  /** @type {{ worker: string, version: string, max_batch_size: string, max_batch_timeout_ms: string, max_retries: string, dead_letter_queue?: string, retry_delay_secs?: string }} */
  const fields = {
    worker,
    version,
    max_batch_size: String(consumer.maxBatchSize),
    max_batch_timeout_ms: String(consumer.maxBatchTimeoutMs),
    max_retries: String(consumer.maxRetries),
  };
  if (consumer.deadLetterQueue) fields.dead_letter_queue = consumer.deadLetterQueue;
  if (consumer.retryDelaySeconds != null) {
    fields.retry_delay_secs = String(consumer.retryDelaySeconds);
  }
  return fields;
}

/** @param {RedisMulti} multi @param {string} ns @param {string} worker @param {string} version @param {QueueConsumer} consumer */
export function stageQueueConsumerProjection(multi, ns, worker, version, consumer) {
  const key = queueConsumerKey(ns, consumer.queue);
  multi.del(key);
  multi.hSet(key, queueConsumerFields(worker, version, consumer));
  multi.sAdd(QUEUE_CONSUMER_INDEX_KEY, key);
}

/** @param {RedisMulti} multi @param {string} ns @param {string} queue */
export function stageQueueConsumerRemoval(multi, ns, queue) {
  stageQueueConsumerKeyRemoval(multi, queueConsumerKey(ns, queue));
}

/** @param {RedisMulti} multi @param {string} key */
export function stageQueueConsumerKeyRemoval(multi, key) {
  multi.del(key);
  multi.sRem(QUEUE_CONSUMER_INDEX_KEY, key);
}
