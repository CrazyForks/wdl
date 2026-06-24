const utf8Encoder = new TextEncoder();

/**
 * FNV-1a 32-bit over UTF-8 bytes. Use this for wire-compatible hashes shared
 * with Rust `wdl_rust_common::hash::fnv1a32`.
 *
 * @param {string} value
 */
export function fnv1a32Utf8(value) {
  let hash = 2166136261;
  const bytes = utf8Encoder.encode(value);
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * FNV-1a 32-bit over JavaScript UTF-16 code units. This preserves legacy JS
 * routing hashes whose inputs are restricted to ASCII by their callers.
 *
 * @param {string} value
 */
export function fnv1a32CodeUnits(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
