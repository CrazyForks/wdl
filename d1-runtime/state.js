import {
  createLogger,
  MetricsRegistry,
} from "shared-observability";

export const SERVICE = "d1-runtime";

/** @type {Map<string, import("d1-runtime-owner-registry").D1Owner>} */
export const ownedDbs = new Map();
/** @type {Map<string, { owner: import("d1-runtime-owner-registry").D1Owner, expiresAt: number, redisTimeBound: true }>} */
export const observedD1Owners = new Map();
/** @type {Map<string, number>} */
export const storageSizeByDb = new Map();
export const metrics = new MetricsRegistry();
export const log = createLogger(SERVICE);

let draining = false;
let pendingQueries = 0;

export function isDraining() {
  return draining;
}

/** @param {unknown} value */
export function setDraining(value) {
  draining = value === true;
}

export function beginPendingQuery() {
  pendingQueries += 1;
}

export function endPendingQuery() {
  pendingQueries = Math.max(0, pendingQueries - 1);
}

export function pendingQueryCount() {
  return pendingQueries;
}

/** @param {string | null | undefined} dbKey @param {unknown} payload */
export function recordPayloadStorageSize(dbKey, payload) {
  if (!dbKey) return;
  const candidates = Array.isArray(payload) ? payload : [payload];
  let size = null;
  for (const item of candidates) {
    if (item?.meta && typeof item.meta.size_after === "number") {
      size = item.meta.size_after;
    }
  }
  if (size != null) recordStorageSizeForDb(dbKey, size);
}

/** @param {string | null | undefined} dbKey @param {unknown} size */
export function recordStorageSizeForDb(dbKey, size) {
  if (!dbKey || typeof size !== "number" || !Number.isFinite(size)) return;
  storageSizeByDb.set(dbKey, size);
}

/** @param {string} dbKey */
export function forgetStorageSize(dbKey) {
  storageSizeByDb.delete(dbKey);
}

export function observedStorageSizeBytes() {
  let total = 0;
  for (const size of storageSizeByDb.values()) total += size;
  return total;
}
