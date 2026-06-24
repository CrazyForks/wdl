import { bytesToHex } from "./hex.js";

/** @param {number} [byteLength] */
export function randomHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
