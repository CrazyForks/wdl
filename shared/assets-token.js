// Time-sortable ms prefix + crypto-random tail: lets an offline GC filter
// orphans by time window, and guards against same-ms concurrent-deploy
// collisions.

import { bytesToHex } from "./hex.js";

export const ASSETS_TOKEN_RE = /^[0-9a-f]{28}$/;

/**
 * @param {number} [now]
 * @returns {string}
 */
export function generateAssetsToken(now = Date.now()) {
  if (!Number.isInteger(now) || now < 0) {
    throw new Error(`generateAssetsToken: bad timestamp ${now}`);
  }
  // 48 bits of ms fits through year 10889.
  const msHex = now.toString(16).padStart(12, "0");
  if (msHex.length > 12) {
    throw new Error("generateAssetsToken: timestamp exceeds 48 bits");
  }
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  return msHex + bytesToHex(rand);
}

/**
 * @param {string} ns
 * @param {string} worker
 * @param {string} token
 * @returns {string}
 */
export function assetsPrefixFor(ns, worker, token) {
  if (typeof ns !== "string" || !ns) throw new Error("assetsPrefixFor: ns required");
  if (typeof worker !== "string" || !worker) throw new Error("assetsPrefixFor: worker required");
  if (typeof token !== "string" || !ASSETS_TOKEN_RE.test(token)) {
    throw new Error(`assetsPrefixFor: bad token ${JSON.stringify(token)}`);
  }
  return `assets/${ns}/${worker}/${token}/`;
}
