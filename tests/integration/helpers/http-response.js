import assert from "node:assert/strict";
import { parseJsonText } from "./json-payload.js";
import { assertStatus } from "./assertions.js";

const EMPTY_BODY = "";

/**
 * @typedef {{
 *   body?: unknown,
 *   text?: () => string | Promise<string>,
 * }} JsonReadableResponse
 */

const responseCache = new WeakMap();

/** @param {unknown} value */
function isPromiseLike(value) {
  return Boolean(value && typeof value === "object" && typeof /** @type {{ then?: unknown }} */ (value).then === "function");
}

/**
 * Expose a collected Node HTTP response body with lazy text decoding.
 * @param {Buffer} buf
 */
export function bufferedResponseBody(buf) {
  /** @type {string | undefined} */
  let text;
  return {
    async text() {
      text ??= buf.toString("utf8");
      return text;
    },
    async arrayBuffer() {
      const copy = new ArrayBuffer(buf.byteLength);
      new Uint8Array(copy).set(buf);
      return copy;
    },
  };
}

/**
 * @param {JsonReadableResponse} response
 * @returns {string | Promise<string>}
 */
function responseText(response) {
  if (typeof response.body === "string") return response.body;
  if (typeof response.text === "function") return response.text();
  throw new TypeError("expected integration response to expose body or text()");
}

/**
 * @param {JsonReadableResponse} response
 * @returns {{ text?: string | Promise<string>, json?: unknown, jsonOrNull?: unknown }}
 */
function cacheFor(response) {
  let cache = responseCache.get(response);
  if (!cache) {
    cache = {};
    responseCache.set(response, cache);
  }
  return cache;
}

/**
 * @param {JsonReadableResponse} response
 * @returns {string | Promise<string>}
 */
function cachedResponseText(response) {
  const cache = cacheFor(response);
  if (!("text" in cache)) cache.text = responseText(response);
  return /** @type {string | Promise<string>} */ (cache.text);
}

/**
 * @param {JsonReadableResponse} response
 * @param {string} label
 * @param {{ allowEmpty: boolean }} options
 */
function parseResponseJsonText(response, label, options) {
  const text = cachedResponseText(response);
  if (isPromiseLike(text)) {
    return Promise.resolve(text).then((resolved) => parseResponseJsonTextValue(resolved, label, options));
  }
  return parseResponseJsonTextValue(/** @type {string} */ (text), label, options);
}

/**
 * @param {string} text
 * @param {string} label
 * @param {{ allowEmpty: boolean }} options
 */
function parseResponseJsonTextValue(text, label, options) {
  if (text === EMPTY_BODY) {
    if (options.allowEmpty) return null;
    throw new SyntaxError(`expected ${label} to contain JSON, got empty body`);
  }
  return parseJsonText(text, label);
}

/**
 * Parse and cache a response JSON body. Empty bodies are errors.
 *
 * For response objects with a synchronous `body` string this returns the parsed value
 * synchronously. For Fetch-like responses that only expose async `text()`, it returns
 * a Promise for the parsed value.
 *
 * @param {JsonReadableResponse} response
 * @param {string} [label]
 * @returns {any}
 */
export function responseJson(response, label = "integration response body") {
  const cache = cacheFor(response);
  if (!("json" in cache)) {
    cache.json = parseResponseJsonText(response, label, { allowEmpty: false });
  }
  return cache.json;
}

/**
 * Parse and cache a response JSON body. Empty bodies become null.
 *
 * @param {JsonReadableResponse} response
 * @param {string} [label]
 * @returns {any}
 */
export function responseJsonOrNull(response, label = "integration response body") {
  const cache = cacheFor(response);
  if (!("jsonOrNull" in cache)) {
    cache.jsonOrNull = parseResponseJsonText(response, label, { allowEmpty: true });
  }
  return cache.jsonOrNull;
}

/**
 * Assert a response status and parse the JSON body with one cached text read.
 * Supports both native Fetch `Response` objects and collected integration
 * responses that expose a string `body`.
 *
 * @param {JsonReadableResponse & { status?: number }} response
 * @param {number} expectedStatus
 * @param {string} [label]
 * @returns {Promise<any>}
 */
export async function readIntegrationJson(response, expectedStatus, label = "integration response") {
  const text = await cachedResponseText(response);
  assertStatus(response, expectedStatus, label, text);
  return parseResponseJsonTextValue(text, `${label} body`, { allowEmpty: false });
}

/**
 * Assert a response status and compare its parsed JSON body.
 *
 * @param {JsonReadableResponse & { status?: number }} response
 * @param {number} expectedStatus
 * @param {unknown} expectedBody
 * @param {string} [label]
 */
export async function assertIntegrationJson(response, expectedStatus, expectedBody, label = "integration response") {
  const body = await readIntegrationJson(response, expectedStatus, label);
  assert.deepEqual(body, expectedBody);
  return body;
}

/**
 * Attach synchronous JSON accessors to response objects that carry a string `body`.
 *
 * @template {JsonReadableResponse} T
 * @param {T} response
 * @param {string} [label]
 * @returns {T & { json: () => any, jsonOrNull: () => any }}
 */
export function withResponseJsonAccessors(response, label = "integration response body") {
  if (typeof response.body !== "string") {
    throw new TypeError("withResponseJsonAccessors expects a collected response with string body");
  }
  return /** @type {T & { json: () => any, jsonOrNull: () => any }} */ (Object.assign(response, {
    json: () => responseJson(response, label),
    jsonOrNull: () => responseJsonOrNull(response, label),
  }));
}
