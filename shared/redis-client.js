import { RedisClient } from "shared-redis";

/**
 * @param {{ REDIS_ADDR?: string }} env
 * @param {new (status: number, code: string, message: string) => Error} ErrorClass
 * @param {string} code
 * @param {string} message
 * @returns {RedisClient}
 */
export function createRequiredRedisClient(env, ErrorClass, code, message) {
  if (!env.REDIS_ADDR) {
    throw new ErrorClass(503, code, message);
  }
  return new RedisClient(env.REDIS_ADDR);
}
