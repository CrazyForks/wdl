// 101 upgrades can't be re-wrapped with the original body: workerd
// rejects a body on 101 (http.c++:1136-1149) and Response.clone() rejects
// WS handshakes (http.c++:1269). Rebuild with a null body + the hijacked
// WebSocket so the upgrade flows through and x-request-id still lands on
// the 101 headers.
/**
 * @param {Response & { webSocket?: WebSocket | null }} response
 * @param {string} requestId
 * @returns {Response}
 */
export function echoResponseWithRequestId(response, requestId) {
  if (response.status === 101) {
    const rebuilt = new Response(null, {
      status: 101,
      headers: response.headers,
      webSocket: response.webSocket,
    });
    rebuilt.headers.set("x-request-id", requestId);
    return rebuilt;
  }
  const echoed = new Response(response.body, response);
  echoed.headers.set("x-request-id", requestId);
  return echoed;
}

/**
 * @param {Response} response
 * @returns {Promise<void>}
 */
export async function discardResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only; the caller's status/error path owns behavior.
  }
}

/**
 * @param {number} status
 * @param {unknown} data
 * @param {HeadersInit} [extraHeaders]
 * @returns {Response}
 */
export function jsonResponse(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/**
 * @param {unknown} data
 * @param {ResponseInit} [init]
 * @returns {Response}
 */
export function jsonInitResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function sanitizeJsonErrorDetails(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
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

/**
 * @param {string} error
 * @param {string | null | undefined} message
 * @param {Record<string, unknown>} [details]
 * @param {{ omitEmptyMessage?: boolean }} [options]
 * @returns {Record<string, unknown>}
 */
export function jsonErrorBody(error, message, details = {}, { omitEmptyMessage = true } = {}) {
  /** @type {Record<string, unknown>} */
  const body = { error };
  if (message) {
    body.message = message;
  } else if (!omitEmptyMessage && message !== undefined) {
    body.message = message;
  }
  const sanitized = sanitizeJsonErrorDetails(details);
  const safeDetails = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : {};
  return { ...safeDetails, ...body };
}

/**
 * @param {number} status
 * @param {string} error
 * @param {string | null | undefined} message
 * @param {Record<string, unknown>} [details]
 * @param {HeadersInit} [extraHeaders]
 * @returns {Response}
 */
export function jsonError(status, error, message, details = {}, extraHeaders = {}) {
  return jsonResponse(status, jsonErrorBody(error, message, details), extraHeaders);
}

/**
 * @param {(data: unknown, init?: ResponseInit) => Response} jsonFn
 * @param {number} status
 * @param {string} error
 * @param {string | null | undefined} message
 * @param {Record<string, unknown>} [details]
 * @returns {Response}
 */
export function jsonErrorWith(jsonFn, status, error, message, details = {}) {
  return jsonFn(jsonErrorBody(error, message, details, { omitEmptyMessage: false }), { status });
}

/**
 * @param {number} status
 * @param {string} error
 * @param {string} message
 * @param {string} requestId
 * @param {HeadersInit} [extraHeaders]
 * @returns {Response}
 */
export function internalErrorResponse(status, error, message, requestId, extraHeaders = {}) {
  return jsonError(status, error, message, { request_id: requestId }, extraHeaders);
}

/**
 * @param {{ renderPrometheus(): string }} metrics
 * @returns {Response}
 */
export function prometheusResponse(metrics) {
  return new Response(metrics.renderPrometheus(), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
