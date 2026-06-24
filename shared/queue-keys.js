// Canonical Redis key grammar. A stray colon in a queue name would
// corrupt parseStreamKey's anchor, so inline construction is a drift
// risk — every tier imports from here.

/**
 * @typedef {{ ns: string, queue: string }} QueueKeyParts
 */

/** @param {string} ns @param {string} queue @returns {string} */
export function queueStreamKey(ns, queue)   { return `queue:${ns}:${queue}:s`; }
/** @param {string} ns @param {string} queue @returns {string} */
export function queueDelayedKey(ns, queue)  { return `queue-delayed:${ns}:${queue}`; }
/** @param {string} ns @param {string} queue @returns {string} */
export function queueDlqKey(ns, queue)      { return `queue:${ns}:${queue}:dlq`; }
/** @param {string} ns @param {string} queue @returns {string} */
export function queueOrphanedKey(ns, queue) { return `queue-orphaned:${ns}:${queue}`; }
/** @param {string} ns @param {string} queue @returns {string} */
export function queueConsumerKey(ns, queue) { return `queue-consumer:${ns}:${queue}`; }

export const QUEUE_CONSUMER_INDEX_KEY = "queue:index:consumers";
export const QUEUE_STREAM_INDEX_KEY = "queue:index:streams";
/** @lintignore kept as the JS mirror of Rust queue discovery indexes. */
export const QUEUE_DELAYED_INDEX_KEY = "queue:index:delayed";

// Partial key for SCAN MATCH; sharing the grammar matters even here.
/** @param {string} ns @returns {string} */
export function queueConsumerScanPrefix(ns) { return `queue-consumer:${ns}:`; }

/**
 * @lintignore kept as the JS mirror of Rust queue key parsers.
 * @param {string} key
 * @returns {QueueKeyParts | null}
 */
export function parseStreamKey(key) {
  const m = key.match(/^queue:([^:]+):(.+):s$/);
  return m ? { ns: m[1], queue: m[2] } : null;
}

/**
 * @lintignore kept as the JS mirror of Rust queue key parsers.
 * @param {string} key
 * @returns {QueueKeyParts | null}
 */
export function parseDelayedKey(key) {
  const m = key.match(/^queue-delayed:([^:]+):(.+)$/);
  return m ? { ns: m[1], queue: m[2] } : null;
}

/**
 * @lintignore kept as the JS mirror of Rust queue key parsers.
 * @param {string} key
 * @returns {QueueKeyParts | null}
 */
export function parseConsumerKey(key) {
  const parts = key.split(":");
  if (parts.length < 3 || parts[0] !== "queue-consumer") return null;
  const ns = parts[1];
  const queue = parts.slice(2).join(":");
  if (!ns || !queue) return null;
  return { ns, queue };
}
