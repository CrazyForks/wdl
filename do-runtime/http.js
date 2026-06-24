import { jsonErrorWith, jsonInitResponse } from "shared-respond";

export const json = jsonInitResponse;

/**
 * @param {number} status
 * @param {string} error
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
export function jsonError(status, error, message, extra = {}) {
  return jsonErrorWith(json, status, error, message, extra);
}
