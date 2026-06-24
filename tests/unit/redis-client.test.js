import assert from "node:assert/strict";
import { test } from "node:test";
import { importRepositoryModule, moduleDataUrl } from "../helpers/load-shared-module.js";

const redisUrl = moduleDataUrl(`
export class RedisClient {
  constructor(addr) {
    this.addr = addr;
  }
}
`);
const { createRequiredRedisClient } = await importRepositoryModule("shared/redis-client.js", [
  [/from "shared-redis";/, `from ${JSON.stringify(redisUrl)};`],
]);

class ProtocolError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

test("required Redis client helper preserves caller error type and code", () => {
  assert.throws(
    () => createRequiredRedisClient({}, ProtocolError, "registry_unavailable", "registry missing"),
    (err) => (
      err instanceof ProtocolError &&
      err.status === 503 &&
      err.code === "registry_unavailable" &&
      err.message === "registry missing"
    )
  );
});

test("required Redis client helper constructs RedisClient when REDIS_ADDR is present", () => {
  const client = createRequiredRedisClient({ REDIS_ADDR: "redis:6379" }, ProtocolError, "x", "y");
  assert.equal(client.constructor.name, "RedisClient");
  assert.equal(client.addr, "redis:6379");
});
