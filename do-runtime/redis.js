import { DoRuntimeError } from "do-runtime-protocol";
import { createRequiredRedisClient } from "shared-redis-client";

/**
 * @param {Record<string, unknown>} env
 * @param {string} code
 * @param {string} message
 */
export function createRedisClient(env, code, message) {
  return createRequiredRedisClient(env, DoRuntimeError, code, message);
}
