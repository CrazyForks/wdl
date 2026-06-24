import assert from "node:assert/strict";
import { parseJsonText } from "./json-payload.js";

/**
 * @typedef {{ status?: number, text?: () => Promise<string>, json?: () => Promise<unknown>, clone?: () => { text(): Promise<string> } }} JsonResponseLike
 */

/**
 * @param {JsonResponseLike} response
 * @returns {Promise<string>}
 */
async function responseTextDiagnostic(response) {
  if (typeof response.clone !== "function") return "";
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

/**
 * @param {JsonResponseLike} response
 * @param {number} expectedStatus
 * @param {string} [label]
 * @returns {Promise<any>}
 */
export async function readJsonResponse(response, expectedStatus, label = "response") {
  const diagnostic = response.status === expectedStatus ? "" : await responseTextDiagnostic(response);
  assert.equal(
    response.status,
    expectedStatus,
    diagnostic ? `${label}: expected status ${expectedStatus}; ${diagnostic}` : `${label}: expected status ${expectedStatus}`
  );
  if (typeof response.text === "function") {
    return parseJsonText(await response.text(), label);
  }
  if (typeof response.json === "function") {
    return await response.json();
  }
  throw new TypeError(`expected ${label} to expose text() or json()`);
}

/**
 * @param {JsonResponseLike} response
 * @param {number} expectedStatus
 * @param {unknown} expectedBody
 * @param {string} [label]
 */
export async function assertJsonResponse(response, expectedStatus, expectedBody, label = "response") {
  assert.deepEqual(await readJsonResponse(response, expectedStatus, label), expectedBody);
}
