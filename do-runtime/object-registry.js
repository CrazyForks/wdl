import { DO_HOST_SHARD_COUNT, shardForObjectName } from "do-runtime-protocol";
import { createRedisClient } from "do-runtime-redis";

const OBJECT_REGISTRY_PREFIX = "do:objects:";

/** @param {Record<string, unknown>} env */
function redisClient(env) {
  return createRedisClient(env, "object_registry_unavailable", "DO object registry is not configured");
}

/** @param {unknown} value */
function encodePart(value) {
  return encodeURIComponent(String(value));
}

/** @param {string} value */
function decodePart(value) {
  return decodeURIComponent(value);
}

/** @param {string} doStorageId */
function objectRegistryKey(doStorageId) {
  return `${OBJECT_REGISTRY_PREFIX}${encodePart(doStorageId)}`;
}

/**
 * @typedef {{ className: string, objectName: string }} DoObjectTarget
 * @typedef {DoObjectTarget & { doStorageId: string }} DoObjectRegistration
 */

/** @param {DoObjectTarget} input */
export function objectRegistryMember({ className, objectName }) {
  return `${encodePart(className)}:${encodePart(objectName)}:${shardForObjectName(objectName)}`;
}

/** @param {unknown} member */
export function parseObjectRegistryMember(member) {
  if (typeof member !== "string") return null;
  const parts = member.split(":");
  if (parts.length !== 3) return null;
  try {
    const shard = Number(parts[2]);
    if (!Number.isInteger(shard) || shard < 0 || shard >= DO_HOST_SHARD_COUNT) return null;
    const parsed = {
      className: decodePart(parts[0]),
      objectName: decodePart(parts[1]),
      shard,
    };
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} env
 * @param {DoObjectRegistration} invoke
 */
export async function rememberDoObject(env, invoke) {
  await redisClient(env).sAdd(
    objectRegistryKey(invoke.doStorageId),
    objectRegistryMember(invoke)
  );
}
