import { WorkerEntrypoint } from "cloudflare:workers";
import {
  buildQueueEnvelope,
  normalizeQueueDelaySeconds,
  QUEUE_CONTENT_TYPES,
} from "runtime-lib";
import { recordBindingOperation } from "runtime-metrics";
import {
  proxyEndpoint as buildProxyEndpoint,
  proxyFetch,
  requireRedisProxyBaseUrl,
  serviceNameFromEnv,
} from "runtime-bindings-proxy";

const MAX_QUEUE_MESSAGE_BYTES = 128_000;
const MAX_QUEUE_BATCH_MESSAGES = 100;
const MAX_QUEUE_BATCH_BYTES = 256_000;

/**
 * @typedef {{ ns: string, id: string, deliveryDelaySeconds?: unknown }} QueueProps
 * @typedef {{ REDIS_PROXY_URL?: unknown, SERVICE_NAME?: string, WDL_INTERNAL_AUTH_TOKEN?: unknown }} QueueEnv
 * @typedef {{ ctx: { props: QueueProps }, env: QueueEnv }} QueueBinding
 * @typedef {{ entry: Record<string, string>, visibleAt: number }} QueueSendAction
 * @typedef {{ contentType?: string, delaySeconds?: unknown }} QueueSendOptions
 * @typedef {{ body?: unknown, contentType?: string, delaySeconds?: unknown }} QueueBatchMessage
 */

/** @param {QueueProducer} queue @returns {QueueBinding} */
function queueBinding(queue) {
  return /** @type {QueueBinding} */ (/** @type {unknown} */ (queue));
}

function emptyQueueMetrics() {
  return {
    backlogCount: 0,
    backlogBytes: 0,
  };
}

function queueSendResponse() {
  return {
    metadata: {
      metrics: emptyQueueMetrics(),
    },
  };
}

/**
 * @param {string} prefix
 * @param {number} byteLength
 */
function checkMessageSize(prefix, byteLength) {
  if (byteLength > MAX_QUEUE_MESSAGE_BYTES) {
    throw new Error(
      `${prefix}: message body exceeds ${MAX_QUEUE_MESSAGE_BYTES} byte limit`
    );
  }
}

/**
 * @param {QueueProducer} queue
 * @returns {string}
 */
function serviceName(queue) {
  return serviceNameFromEnv(queueBinding(queue).env);
}

/**
 * @param {unknown} body
 * @param {string} contentType
 * @param {number} now
 * @param {string} [errorPrefix]
 */
function buildEntry(body, contentType, now, errorPrefix = "queue send") {
  const built = buildQueueEnvelope(body, contentType, now);
  checkMessageSize(errorPrefix, built.byteLength);
  return built;
}

/**
 * @param {QueueProducer} queue
 * @returns {number}
 */
function defaultDelaySeconds(queue) {
  return normalizeQueueDelaySeconds(
    queueBinding(queue).ctx.props.deliveryDelaySeconds,
    0,
    "deliveryDelaySeconds"
  );
}

/**
 * @param {QueueProducer} queue
 * @returns {string}
 */
function proxyUrl(queue) {
  return requireRedisProxyBaseUrl(queueBinding(queue).env, "Queue binding");
}

/**
 * @param {QueueProducer} queue
 * @param {string} path
 * @returns {URL}
 */
function proxyEndpoint(queue, path) {
  const { ns, id } = queueBinding(queue).ctx.props;
  return buildProxyEndpoint(proxyUrl(queue), path, { ns, id });
}

/**
 * @param {QueueProducer} queue
 * @param {QueueSendAction[]} actions
 */
async function sendActions(queue, actions) {
  await proxyFetch(proxyEndpoint(queue, "/queue/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(actions),
  }, {
    env: queueBinding(queue).env,
    failurePrefix: "Queue proxy send",
  });
}

export class QueueProducer extends WorkerEntrypoint {
  /**
   * @param {unknown} body
   * @param {QueueSendOptions} [opts]
   */
  async send(body, opts = {}) {
    return recordBindingOperation(serviceName(this), "queue", "send", async () => {
      const contentType = opts.contentType || QUEUE_CONTENT_TYPES.JSON;
      if (contentType === QUEUE_CONTENT_TYPES.V8) {
        throw new Error(
          "queue send: v8 contentType not supported - use json, text, or bytes"
        );
      }
      const now = Date.now();
      const built = buildEntry(body, contentType, now);
      const delaySecs = normalizeQueueDelaySeconds(
        opts.delaySeconds,
        defaultDelaySeconds(this)
      );
      await sendActions(this, [{
        entry: built.entry,
        visibleAt: delaySecs > 0 ? now + delaySecs * 1000 : 0,
      }]);
      return queueSendResponse();
    });
  }

  /**
   * @param {unknown[]} messages
   * @param {QueueSendOptions} [opts]
   */
  async sendBatch(messages, opts = {}) {
    return recordBindingOperation(serviceName(this), "queue", "sendBatch", async () => {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("queue sendBatch: messages must be a non-empty array");
      }
      if (messages.length > MAX_QUEUE_BATCH_MESSAGES) {
        throw new Error(
          `queue sendBatch: batch exceeds ${MAX_QUEUE_BATCH_MESSAGES} message limit`
        );
      }
      const batchContentType = opts.contentType || QUEUE_CONTENT_TYPES.JSON;
      const batchDelaySeconds = normalizeQueueDelaySeconds(
        opts.delaySeconds,
        defaultDelaySeconds(this)
      );
      const now = Date.now();
      const actions = [];
      let totalBytes = 0;
      for (const msg of messages) {
        const isWrapper = msg !== null && (typeof msg === "object" || typeof msg === "function");
        const batchMessage = /** @type {QueueBatchMessage} */ (isWrapper ? msg : {});
        const body = isWrapper && Object.hasOwn(batchMessage, "body") ? batchMessage.body : msg;
        const ct = isWrapper && batchMessage.contentType ? batchMessage.contentType : batchContentType;
        if (ct === QUEUE_CONTENT_TYPES.V8) {
          throw new Error(
            "queue sendBatch: v8 contentType not supported - use json, text, or bytes"
          );
        }
        const built = buildEntry(body, ct, now, "queue sendBatch");
        totalBytes += built.byteLength;
        if (totalBytes > MAX_QUEUE_BATCH_BYTES) {
          throw new Error(
            `queue sendBatch: batch body exceeds ${MAX_QUEUE_BATCH_BYTES} byte limit`
          );
        }
        const delaySecs = normalizeQueueDelaySeconds(isWrapper ? batchMessage.delaySeconds : undefined, batchDelaySeconds);
        actions.push({
          entry: built.entry,
          visibleAt: delaySecs > 0 ? now + delaySecs * 1000 : 0,
        });
      }
      await sendActions(this, actions);
      return queueSendResponse();
    });
  }

  async metrics() {
    return recordBindingOperation(serviceName(this), "queue", "metrics", async () => {
      return emptyQueueMetrics();
    });
  }
}
