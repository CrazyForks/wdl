import { runProbeNode, runProbeNodeAsync } from "./compose.js";
import { withResponseJsonAccessors } from "./http-response.js";
import { parseStdoutJson } from "./json-payload.js";

const INTERNAL_AUTH_HEADER = "x-wdl-internal-auth";
const INTERNAL_AUTH_TOKEN = process.env.WDL_INTERNAL_AUTH_TOKEN || "local-internal-auth-token";

/** @param {unknown} body */
function internalHttpPayload(body) {
  const isBinary = body instanceof Uint8Array || Buffer.isBuffer(body);
  return {
    isBinary,
    payload: body == null || isBinary ? "" : (typeof body === "string" ? body : JSON.stringify(body)),
    bodyB64: isBinary ? Buffer.from(/** @type {Uint8Array | Buffer} */ (body)).toString("base64") : null,
  };
}

/**
 * @param {Record<string, string>} headers
 * @param {boolean} hasBody
 * @param {{ internalAuth?: boolean }} [options]
 */
function internalHttpHeaders(headers, hasBody, options = {}) {
  /** @type {Record<string, string>} */
  const hdrs = { ...headers };
  const shouldAddInternalAuth = options.internalAuth !== false;
  const hasInternalAuth = Object.keys(hdrs).some((key) => key.toLowerCase() === INTERNAL_AUTH_HEADER);
  if (shouldAddInternalAuth && !hasInternalAuth) {
    hdrs[INTERNAL_AUTH_HEADER] = INTERNAL_AUTH_TOKEN;
  }
  if (hasBody && !("content-type" in hdrs) && !("Content-Type" in hdrs)) {
    hdrs["content-type"] = "application/json";
  }
  return hdrs;
}

/**
 * @param {string} host
 * @param {number} port
 * @param {string} pathWithQuery
 * @param {string} method
 * @param {Record<string, string>} headers
 * @param {unknown} body
 * @param {{ internalAuth?: boolean }} [options]
 */
function internalHttpEnvelope(host, port, pathWithQuery, method, headers, body, options = {}) {
  const { payload, bodyB64, isBinary } = internalHttpPayload(body);
  return {
    envelope: Buffer.from(JSON.stringify({
      host,
      port,
      path: pathWithQuery,
      method,
      headers: internalHttpHeaders(headers, Boolean(payload || bodyB64 || isBinary), options),
      body: payload,
      bodyB64,
    })).toString("base64"),
    payload,
  };
}

const INTERNAL_HTTP_REQUEST_SCRIPT = `
  const http = require('http');
  const a = JSON.parse(Buffer.from(process.env.WDL_REQ, 'base64').toString('utf8'));
  const req = http.request({ host: a.host, port: a.port, path: a.path, method: a.method, headers: a.headers }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      const body = Buffer.concat(chunks);
      process.stdout.write(JSON.stringify({
        status: r.statusCode,
        body: body.toString('utf8'),
        bodyB64: body.toString('base64'),
        headers: r.headers,
      }));
      process.exit(0);
    });
  });
  req.on('error', (e) => { console.error(e.message); process.exit(2); });
  if (a.bodyB64) req.write(Buffer.from(a.bodyB64, 'base64'));
  else if (a.body) req.write(a.body);
  req.end();
`;

/**
 * @typedef {{
 *   status: number,
 *   body: string,
 *   bodyB64: string,
 *   headers: import("node:http").IncomingHttpHeaders,
 *   json: () => any,
 *   jsonOrNull: () => any,
 * }} InternalHttpResponse
 */

/**
 * @param {string} stdout @param {string} [stderr]
 * @returns {InternalHttpResponse}
 */
export function parseDockerJson(stdout, stderr = "") {
  try {
    const parsed = parseStdoutJson(stdout, "internal HTTP response stdout");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("internal HTTP response stdout must be a JSON object");
    }
    return withResponseJsonAccessors(/** @type {Omit<InternalHttpResponse, "json" | "jsonOrNull">} */ (parsed), "internal HTTP response body");
  } catch (err) {
    throw new Error(`invalid internal HTTP response: ${(stdout || stderr || (err instanceof Error ? err.message : String(err))).trim()}`, {
      cause: err,
    });
  }
}

// Host side can't resolve compose service names like user-runtime:8081,
// d1-runtime:8787, or scheduler:9110. Run the tiny HTTP client from the
// test-probe sidecar so runtime images do not need Node.
/**
 * @param {string} host @param {number} port @param {string} pathWithQuery @param {string} method
 * @param {Record<string, string>} [headers] @param {unknown} [body]
 * @param {{ internalAuth?: boolean }} [options]
 */
export function internalHttpRequest(host, port, pathWithQuery, method, headers = {}, body = null, options = {}) {
  const { envelope } = internalHttpEnvelope(host, port, pathWithQuery, method, headers, body, options);
  const out = runProbeNode(INTERNAL_HTTP_REQUEST_SCRIPT, {
    env: { WDL_REQ: envelope },
  });
  return parseDockerJson(out);
}

/**
 * @param {string} host @param {number} port @param {string} pathWithQuery @param {string} method
 * @param {Record<string, string>} [headers] @param {unknown} [body]
 * @param {{ internalAuth?: boolean }} [options]
 */
function internalHttpRequestLargeBody(host, port, pathWithQuery, method, headers = {}, body = null, options = {}) {
  const { payload, bodyB64, isBinary } = internalHttpPayload(body);
  const input = isBinary ? Buffer.from(/** @type {Uint8Array | Buffer} */ (body)) : payload;
  const envelope = Buffer.from(JSON.stringify({
    host,
    port,
    path: pathWithQuery,
    method,
    headers: internalHttpHeaders(headers, Boolean(payload || bodyB64 || isBinary), options),
  })).toString("base64");
  const script = `
    const http = require('http');
    const a = JSON.parse(Buffer.from(process.env.WDL_REQ, 'base64').toString('utf8'));
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const req = http.request({ host: a.host, port: a.port, path: a.path, method: a.method, headers: a.headers }, (r) => {
        const out = [];
        r.on('data', (c) => out.push(c));
        r.on('end', () => {
          const responseBody = Buffer.concat(out);
          process.stdout.write(JSON.stringify({
            status: r.statusCode,
            body: responseBody.toString('utf8'),
            bodyB64: responseBody.toString('base64'),
            headers: r.headers,
          }));
          process.exit(0);
        });
      });
      req.on('error', (e) => { console.error(e.message); process.exit(2); });
      const requestBody = Buffer.concat(chunks);
      if (requestBody.length > 0) req.write(requestBody);
      req.end();
    });
  `;
  return runProbeNodeAsync(script, {
    env: { WDL_REQ: envelope },
    input,
    evalScript: true,
  }).then((stdout) => parseDockerJson(stdout));
}

/**
 * @param {string} host @param {number} port @param {string} pathWithQuery @param {string} method
 * @param {Record<string, string>} [headers] @param {unknown} [body]
 * @param {{ internalAuth?: boolean }} [options]
 */
function internalHttpRequestAsync(host, port, pathWithQuery, method, headers = {}, body = null, options = {}) {
  const { envelope } = internalHttpEnvelope(host, port, pathWithQuery, method, headers, body, options);
  return runProbeNodeAsync(INTERNAL_HTTP_REQUEST_SCRIPT, {
    env: { WDL_REQ: envelope },
  }).then((stdout) => parseDockerJson(stdout));
}

/** @param {string} pathWithQuery */
export function runtimeInternalGet(pathWithQuery) {
  return internalHttpRequest("user-runtime", 8088, pathWithQuery, "GET").body;
}

// Scrape the scheduler's Prometheus endpoint. The Rust image is FROM
// scratch (no curl/wget), and 9110 isn't published to the host, so the
// request goes through the test-probe sidecar.
export function schedulerMetricsText() {
  return internalHttpRequest("scheduler", 9110, "/_metrics", "GET").body;
}

/** @param {string} pathWithQuery @param {Record<string, string>} headers */
export function runtimeInternalGetWithHeaders(pathWithQuery, headers) {
  // Kept helper name: this targets user-runtime:8081 tenant fetch dispatch,
  // not the auth-protected runtime internal socket on 8088.
  return internalHttpRequest("user-runtime", 8081, pathWithQuery, "GET", headers, null, { internalAuth: false });
}

/** @param {string} pathWithQuery @param {Record<string, string>} headers @param {unknown} body */
export function runtimeInternalPost(pathWithQuery, headers, body) {
  // Kept helper name: this targets user-runtime:8081 tenant fetch dispatch,
  // not the auth-protected runtime internal socket on 8088.
  return internalHttpRequest("user-runtime", 8081, pathWithQuery, "POST", headers, body, { internalAuth: false });
}

/** @param {string} pathWithQuery @param {Record<string, string>} headers @param {unknown} body */
export function runtimeDispatchPost(pathWithQuery, headers, body) {
  return internalHttpRequest("user-runtime", 8088, pathWithQuery, "POST", headers, body);
}

/** @param {string} pathWithQuery @param {Record<string, string>} headers @param {unknown} body */
export function systemRuntimeInternalPost(pathWithQuery, headers, body) {
  return internalHttpRequest("system-runtime", 8088, pathWithQuery, "POST", headers, body);
}

/** @param {string} host @param {number} port @param {string} pathWithQuery @param {Record<string, string>} [headers] */
export function serviceInternalGet(host, port, pathWithQuery, headers = {}) {
  return internalHttpRequest(host, port, pathWithQuery, "GET", headers);
}

/** @param {string} host @param {number} port @param {string} pathWithQuery @param {unknown} body @param {Record<string, string>} [headers] */
export function serviceInternalPost(host, port, pathWithQuery, body, headers = {}) {
  return internalHttpRequest(host, port, pathWithQuery, "POST", headers, body);
}

/** @param {string} host @param {number} port @param {string} pathWithQuery @param {unknown} body @param {Record<string, string>} [headers] */
export function serviceInternalPostLarge(host, port, pathWithQuery, body, headers = {}) {
  return internalHttpRequestLargeBody(host, port, pathWithQuery, "POST", headers, body);
}

/** @param {string} host @param {number} port @param {string} pathWithQuery @param {unknown} body @param {Record<string, string>} [headers] */
export function serviceInternalPostAsync(host, port, pathWithQuery, body, headers = {}) {
  return internalHttpRequestAsync(host, port, pathWithQuery, "POST", headers, body);
}

/** @param {string} name */
export function envoyStat(name) {
  const res = serviceInternalGet("envoy", 9901, `/stats?filter=${encodeURIComponent(`^${name}$`)}`);
  if (res.status !== 200) throw new Error(`envoy stats request failed: ${res.status} ${res.body}`);
  const match = res.body.match(new RegExp(`^${RegExp.escape(name)}:\\s+([0-9]+)$`, "m"));
  return match ? Number(match[1]) : 0;
}
