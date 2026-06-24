import { createHash } from "node:crypto";

/** @param {string} ns @param {string} worker @param {string} doStorageId @param {string} className @param {string} objectName */
export function doAlarmJobIdForStorage(ns, worker, doStorageId, className, objectName) {
  return `doa-${createHash("sha256")
    .update(ns)
    .update("\0")
    .update(worker)
    .update("\0")
    .update(doStorageId)
    .update("\0")
    .update(className)
    .update("\0")
    .update(objectName)
    .digest("hex")}`;
}
