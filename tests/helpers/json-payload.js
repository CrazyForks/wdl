/**
 * @param {string} text
 * @param {string} [label]
 * @returns {any}
 */
export function parseJsonText(text, label = "JSON payload") {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SyntaxError(
      `expected ${label} to contain valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {any}
 */
export function parseStoredJson(value, label = "stored JSON payload") {
  if (typeof value !== "string") {
    throw new TypeError(`expected ${label} to be a JSON string`);
  }
  return parseJsonText(value, label);
}

/**
 * @param {string} bodyB64
 * @param {string} [label]
 * @returns {any}
 */
export function parseBase64Json(bodyB64, label = "base64 JSON payload") {
  return parseJsonText(Buffer.from(bodyB64, "base64").toString("utf8"), label);
}

/**
 * @param {string} stdout
 * @param {string} [label]
 * @returns {any}
 */
export function parseStdoutJson(stdout, label = "command JSON stdout") {
  return parseJsonText(stdout.trim(), label);
}
