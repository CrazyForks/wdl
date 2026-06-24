import assert from "node:assert/strict";
import { test } from "node:test";

import { doProtocolDataUrl, loadDoProtocol } from "../helpers/load-do-protocol.js";
import {
  importRepositoryModule,
  importSpecifierReplacements,
  moduleDataUrl,
} from "../helpers/load-shared-module.js";

const PROTOCOL_URL = doProtocolDataUrl();
const { shardForObjectName } = await loadDoProtocol();

const redisUrl = moduleDataUrl(`
export function createRedisClient() {
  return { sAdd() {} };
}
`);

const {
  objectRegistryMember,
  parseObjectRegistryMember,
} = await importRepositoryModule("do-runtime/object-registry.js", importSpecifierReplacements({
  "do-runtime-protocol": PROTOCOL_URL,
  "do-runtime-redis": redisUrl,
}));

test("DO object registry members include the object shard", () => {
  const member = objectRegistryMember({ className: "Room", objectName: "room-a" });

  assert.equal(member, `Room:room-a:${shardForObjectName("room-a")}`);
  assert.deepEqual(parseObjectRegistryMember(member), {
    className: "Room",
    objectName: "room-a",
    shard: shardForObjectName("room-a"),
  });
});

test("DO object registry parser rejects malformed members", () => {
  assert.equal(parseObjectRegistryMember("Room:room-a"), null);
  assert.equal(parseObjectRegistryMember("Room:room-a:not-a-shard"), null);
  assert.equal(parseObjectRegistryMember("Room:room-a:16"), null);
});
