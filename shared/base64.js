// Stack-safe byte/base64 helpers shared by workerd tiers. Keep this module
// dependency-free so it can be embedded anywhere a small shared primitive is
// needed.

const CHUNK_SIZE = 0x8000;
const utf8Encoder = new TextEncoder();

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** @param {string} value @returns {Uint8Array} */
export function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** @param {string} value @returns {string} */
export function textToBase64(value) {
  return bytesToBase64(utf8Encoder.encode(value));
}
