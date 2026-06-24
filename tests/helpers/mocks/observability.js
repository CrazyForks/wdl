// Tests that drive logger or metrics spies inline their own variant — the
// spy shape is per-test.

import { moduleDataUrl } from "../load-shared-module.js";

const OBSERVABILITY_NOOP_SOURCE = String.raw`
export class MetricsRegistry {
  increment() {}
  observe() {}
  setGauge() {}
}
export function createLogger() {
  return function log() {};
}
export function createLogLevelBinder() {
  return function bindLogLevel() {};
}
export function formatError(err) {
  if (!err) return { error_message: "Unknown error" };
  if (err instanceof Error) {
    const out = { error_name: err.name, error_message: err.message };
    if (typeof /** @type {any} */ (err).code === "string") {
      out.error_code = /** @type {any} */ (err).code;
    } else if (typeof /** @type {any} */ (err).reason === "string") {
      out.error_code = /** @type {any} */ (err).reason;
    }
    return out;
  }
  return { error_message: String(err) };
}
export function recordRedisCommand() {}
export function recordRequestComplete() {}
export function ensureRequestId(headersLike) {
  if (!headersLike) return generateRequestId();
  const raw = typeof headersLike.get === "function"
    ? headersLike.get("x-request-id")
    : headersLike["x-request-id"];
  return sanitizeRequestId(raw) || generateRequestId();
}
export function sanitizeRequestId(raw) {
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string") return null;
  const first = raw.split(",")[0].trim();
  if (!first || first.length > 128) return null;
  if ([...first].some((ch) => ch.trim() === "" || ch === '"' || ch === "\\")) return null;
  for (let i = 0; i < first.length; i++) {
    const code = first.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return null;
  }
  return first;
}
export function generateRequestId() {
  return "rid";
}
export function logStructured() {}
export function setLogLevel() {}
`;

export const OBSERVABILITY_NOOP_URL = moduleDataUrl(OBSERVABILITY_NOOP_SOURCE);
