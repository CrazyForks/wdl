/**
 * Treat nullish and explicitly-empty env values as absent while preserving
 * numeric zero and other falsy-but-meaningful values.
 *
 * @template T
 * @param {T | null | undefined | ""} value
 * @param {T} fallback
 * @returns {T}
 */
export function envValueOr(value, fallback) {
  return value == null || value === "" ? fallback : value;
}
