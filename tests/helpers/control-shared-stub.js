// `controlSharedStubUrl(extraSource)` appends a test-specific `state`/exports
// tail so each test wires its own redis fakes without re-declaring the base
// helpers.

import { moduleDataUrl } from "./load-shared-module.js";

const CONTROL_SHARED_BASE = `
export function jsonResponse(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extraHeaders } });
}
function sanitizeJsonErrorDetails(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "error" || key === "message" || key === "reason") continue;
    if (entry !== undefined) {
      Object.defineProperty(out, key, {
        value: entry,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
export function jsonError(status, error, message, details = {}, extraHeaders = {}) {
  const body = { error };
  if (message) body.message = message;
  const sanitized = sanitizeJsonErrorDetails(details);
  const safeDetails = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized : {};
  return jsonResponse(status, { ...safeDetails, ...body }, extraHeaders);
}
export async function readJsonBody(request, { requireObject = false, allowEmpty = false, maxBytes = 1024 * 1024 } = {}) {
  let body;
  try {
    const declared = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { response: jsonError(413, "request_body_too_large", "Body must be at most " + maxBytes + " bytes") };
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return { response: jsonError(413, "request_body_too_large", "Body must be at most " + maxBytes + " bytes") };
    }
    if (text === "") {
      if (!allowEmpty) {
        return { response: jsonError(400, "invalid_json", "Body must be valid JSON") };
      }
      body = {};
    } else {
      body = JSON.parse(text);
    }
  } catch {
    return { response: jsonError(400, "invalid_json", "Body must be valid JSON") };
  }
  if (requireObject && (!body || typeof body !== "object" || Array.isArray(body))) {
    return { response: jsonError(400, "invalid_json_object", "Body must be a JSON object") };
  }
  return { body };
}
export class ControlAbort extends Error {
  constructor(status, code, details = {}) {
    super(details?.message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export function codedErrorResponse(err, fallbackCode = "internal_error", extraDetails = {}) {
  const record = err && typeof err === "object" && !Array.isArray(err) ? err : {};
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details
    : {};
  const status = typeof record.status === "number" ? record.status : 500;
  const code = typeof record.code === "string" && record.code ? record.code : fallbackCode;
  const recordMessage = typeof record.message === "string" && record.message ? record.message : undefined;
  const message = err instanceof ControlAbort
    ? (typeof err.details.message === "string" && err.details.message) || err.message || code
    : recordMessage || (typeof details.message === "string" && details.message) || code;
  return jsonError(
    status,
    code,
    message,
    { ...details, ...extraDetails },
  );
}
export function controlAbortResponse(err, extraDetails = {}) {
  return codedErrorResponse(err, err.code, extraDetails);
}
export function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
export function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function prefixedId(prefix, bytes = 16) {
  return prefix + randomHex(bytes);
}
export function stringEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
    else if (value === undefined) out[key] = undefined;
  }
  return out;
}
export function requireControlLog() {
  return state.log;
}
export function requireControlRedis() {
  return state.redis;
}
export function requireControlDataRedis() {
  return state.dataRedis;
}
export function controlTailRedis() {
  return state.dataRedis || state.redis;
}
export function getControlS3() {
  return state.s3;
}
export function getControlR2() {
  return state.r2;
}
export function getControlWorkflows() {
  return state.workflows;
}
export function controlInternalJsonHeaders() {
  const token = state.env?.WDL_INTERNAL_AUTH_TOKEN;
  return token
    ? { "content-type": "application/json", "x-wdl-internal-auth": token }
    : { "content-type": "application/json" };
}
function isWatchError(err) {
  return err instanceof Error && (
    err.name === "WatchError"
    || err.constructor?.name === "WatchError"
  );
}
export async function runOptimistic(redis, { attempts = 5, onExhausted, onWatchError, shouldRetryResult }, fn) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await redis.session((session) => fn(session, attempt));
      if (shouldRetryResult?.(result, attempt)) continue;
      return result;
    } catch (err) {
      if (isWatchError(err)) {
        onWatchError?.(err, attempt);
        continue;
      }
      throw err;
    }
  }
  return await onExhausted();
}
export async function recordCleanupIntentOrWarn({
  cleanupIntent,
  cleanupTaskId,
  warningMessage,
  logEvent,
  logFields,
  log,
}) {
  const warnings = [];
  let queueHintStatus = cleanupTaskId ? "queued" : "none";
  if (cleanupIntent) {
    try {
      await recordS3CleanupIntent(cleanupIntent);
    } catch (err) {
      queueHintStatus = "failed";
      warnings.push({ code: "cleanup_queue_failed", message: warningMessage });
      log("warn", logEvent, {
        ...logFields,
        task_id: cleanupTaskId,
        error_message: errMessage(err),
      });
    }
  }
  return { queueHintStatus, warnings };
}
`;

export function controlSharedStubUrl(extraSource = "") {
  const cleanupStub = /\brecordS3CleanupIntent\b/.test(extraSource)
    ? ""
    : "\nexport async function recordS3CleanupIntent(_cleanupIntent) {}\n";
  return moduleDataUrl(`${CONTROL_SHARED_BASE}\n${extraSource}${cleanupStub}`);
}
