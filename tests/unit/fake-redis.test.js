import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeRedis, FakeRedisWatchError } from "../helpers/mocks/fake-redis.js";

test("fake redis client records batched hash reads", async () => {
  const redis = createFakeRedis();
  redis.hashes.set("hash:a", { one: "1", two: "2" });
  redis.hashes.set("hash:b", { one: "3" });

  assert.deepEqual(await redis.hGetAllMany(["hash:a", "hash:b", "hash:c"]), [
    { one: "1", two: "2" },
    { one: "3" },
    {},
  ]);
  assert.deepEqual(await redis.hGetMany([
    ["hash:a", "two"],
    ["hash:b", "missing"],
  ]), ["2", null]);
  assert.deepEqual(redis.commands, [
    ["hGetAllMany", ["hash:a", "hash:b", "hash:c"]],
    ["hGetMany", [["hash:a", "two"], ["hash:b", "missing"]]],
  ]);
});

test("fake redis session records single and batched hash reads", async () => {
  const redis = createFakeRedis();
  redis.hashes.set("hash:a", { one: "1" });
  redis.hashes.set("hash:b", { two: "2" });

  await redis.session(async (session) => {
    assert.deepEqual(await session.hGetAll("hash:a"), { one: "1" });
    assert.deepEqual(await session.hGetAllMany(["hash:a", "hash:b"]), [
      { one: "1" },
      { two: "2" },
    ]);
    assert.equal(await session.hGet("hash:b", "two"), "2");
  });
  assert.deepEqual(redis.commands, [
    ["hGetAll", "hash:a"],
    ["hGetAllMany", ["hash:a", "hash:b"]],
    ["hGet", "hash:b", "two"],
  ]);
});

test("fake redis supports lock-style set and delIfEq with TTL expiry", async () => {
  let nowMs = 1_000;
  const redis = createFakeRedis(undefined, { nowMs: () => nowMs });

  assert.equal(await redis.set("lock", "token-a", { nx: true, ttl: 1 }), "OK");
  assert.equal(await redis.set("lock", "token-b", { nx: true, ttl: 1 }), null);
  assert.equal(await redis.set("lock", "token-b", { ifeq: "token-a", ttl: 1 }), "OK");
  assert.equal(await redis.delIfEq("lock", "token-a"), 0);
  assert.equal(await redis.get("lock"), "token-b");
  nowMs += 1_001;
  assert.equal(await redis.get("lock"), null);
  assert.equal(await redis.set("lock", "token-c", { nx: true }), "OK");
  assert.equal(await redis.delIfEq("lock", "token-c"), 1);
  assert.equal(await redis.exists("lock"), 0);
});

test("fake redis set without ttl clears an existing expiration", async () => {
  let nowMs = 1_000;
  const redis = createFakeRedis(undefined, { nowMs: () => nowMs });

  assert.equal(await redis.set("key", "a", { ttl: 1 }), "OK");
  assert.equal(await redis.set("key", "b"), "OK");
  nowMs += 1_001;
  assert.equal(await redis.get("key"), "b");
});

test("fake redis scan paginates matching keys", async () => {
  const redis = createFakeRedis();
  redis.strings.set("auth:token:a", "1");
  redis.strings.set("auth:token:b", "2");
  redis.hashes.set("auth:token:c", { value: "3" });
  redis.strings.set("worker:demo", "ignored");

  const first = await redis.scan("0", "auth:token:*", 2);
  const second = await redis.scan(first[0], "auth:token:*", 2);

  assert.deepEqual(first, ["2", ["auth:token:a", "auth:token:b"]]);
  assert.deepEqual(second, ["0", ["auth:token:c"]]);
});

test("fake redis multi can inject watch conflicts", async () => {
  const redis = createFakeRedis();
  redis.execFailures = 1;

  await assert.rejects(
    () => redis.session((session) => session.multi().set("key", "value").exec()),
    (err) => err instanceof FakeRedisWatchError
  );
  assert.equal(redis.strings.has("key"), false);

  await redis.session((session) => session.multi().set("key", "value").exec());
  assert.equal(redis.strings.get("key"), "value");
});

test("fake redis multi set honors lock options", async () => {
  let nowMs = 1_000;
  const redis = createFakeRedis(undefined, { nowMs: () => nowMs });

  await redis.session((session) => session.multi().set("lock", "token-a", { nx: true, ttl: 1 }).exec());
  await redis.session((session) => session.multi().set("lock", "token-b", { nx: true }).exec());
  assert.equal(redis.strings.get("lock"), "token-a");

  await redis.session((session) => session.multi().set("lock", "token-b", { ifeq: "token-a", ttl: 1 }).exec());
  assert.equal(redis.strings.get("lock"), "token-b");
  nowMs += 1_001;
  assert.equal(await redis.get("lock"), null);
});

test("fake redis multi set without ttl clears an existing expiration", async () => {
  let nowMs = 1_000;
  const redis = createFakeRedis(undefined, { nowMs: () => nowMs });

  await redis.session((session) => session.multi().set("key", "a", { ttl: 1 }).exec());
  await redis.session((session) => session.multi().set("key", "b").exec());
  nowMs += 1_001;
  assert.equal(await redis.get("key"), "b");
});
