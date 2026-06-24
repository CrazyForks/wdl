import { MetricsRegistry } from "shared-observability";

export const metrics = new MetricsRegistry();

/**
 * @template T
 * @param {string} service
 * @param {string} binding
 * @param {string} operation
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function recordBindingOperation(service, binding, operation, fn) {
  const labels = { service, binding, operation };
  const startedAt = Date.now();
  try {
    const result = await fn();
    metrics.increment("binding_operations", { ...labels, outcome: "ok" });
    metrics.observe("binding_operation_duration_ms", labels, Date.now() - startedAt);
    return result;
  } catch (err) {
    metrics.increment("binding_operations", { ...labels, outcome: "error" });
    metrics.observe("binding_operation_duration_ms", labels, Date.now() - startedAt);
    throw err;
  }
}
