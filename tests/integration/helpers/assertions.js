import assert from "node:assert/strict";

/**
 * @typedef {{ status?: number, body?: unknown, json?: unknown }} StatusLikeResponse
 */

/** @param {StatusLikeResponse} response */
function responseDiagnostic(response) {
  if ("body" in response && response.body != null) return stringifyDiagnostic(response.body);
  if ("json" in response && response.json != null) return stringifyDiagnostic(response.json);
  return "";
}

/** @param {unknown} value */
function stringifyDiagnostic(value) {
  if (typeof value === "string") return value;
  if (typeof value === "function") return "";
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {StatusLikeResponse} response
 * @param {number} expected
 * @param {string} [label]
 * @param {unknown} [diagnosticValue]
 */
export function assertStatus(response, expected, label = "response", diagnosticValue) {
  const diagnostic = arguments.length >= 4 ? stringifyDiagnostic(diagnosticValue) : responseDiagnostic(response);
  assert.equal(
    response.status,
    expected,
    diagnostic ? `${label}: expected status ${expected}; ${diagnostic}` : `${label}: expected status ${expected}`
  );
}

/**
 * @param {StatusLikeResponse} response
 * @param {number} unexpected
 * @param {string} [label]
 */
export function assertNotStatus(response, unexpected, label = "response") {
  const diagnostic = responseDiagnostic(response);
  assert.notEqual(
    response.status,
    unexpected,
    diagnostic ? `${label}: expected status not to be ${unexpected}; ${diagnostic}` :
      `${label}: expected status not to be ${unexpected}`
  );
}

/**
 * @param {StatusLikeResponse} response
 * @param {number[]} expected
 * @param {string} [label]
 */
export function assertStatusIn(response, expected, label = "response") {
  const diagnostic = responseDiagnostic(response);
  assert.ok(
    expected.includes(response.status ?? -1),
    diagnostic ? `${label}: expected status in ${expected.join(", ")}; ${diagnostic}` :
      `${label}: expected status in ${expected.join(", ")}`
  );
}
