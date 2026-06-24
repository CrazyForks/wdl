import { test } from "node:test";
import assert from "node:assert/strict";

import { d1ProtocolDataUrl } from "../helpers/load-d1-protocol.js";
import {
  importRepositoryModule,
  importSpecifierReplacements,
  moduleDataUrl,
} from "../helpers/load-shared-module.js";

const ownerRegistryUrl = moduleDataUrl(`
export function redisClient() {
  return { set() {} };
}
`);

const {
  assertD1TestHooksEnabled,
  isD1ActorTestHook,
  normalizeD1TestHookRequest,
} = await importRepositoryModule("d1-runtime/test-hooks.js", importSpecifierReplacements({
  "d1-runtime-protocol": d1ProtocolDataUrl(),
  "d1-runtime-owner-registry": ownerRegistryUrl,
}));

/**
 * @param {unknown} err
 * @param {number} status
 * @param {string} code
 */
function hasErrorStatusAndCode(err, status, code) {
  if (!err || typeof err !== "object") return false;
  const shaped = /** @type {{ status?: unknown, code?: unknown }} */ (err);
  return shaped.status === status && shaped.code === code;
}

test("D1 test hooks: normalize only accepts the test-hook control surface", () => {
  const query = normalizeD1TestHookRequest({
    namespace: "tenant-a",
    databaseId: "main",
    mode: "all",
    __control: "hold-transaction",
    __holdMs: 250,
    statements: [{ sql: "select ?", params: [true] }],
  });

  assert.equal(query.dbKey, "tenant-a:main");
  assert.equal(query.__control, "hold-transaction");
  assert.equal(query.__holdMs, 250);
  assert.deepEqual(query.statements[0].params, [1]);
  assert.throws(
    () => normalizeD1TestHookRequest({
      namespace: "tenant-a",
      databaseId: "main",
      statements: [{ sql: "select 1" }],
    }),
    (err) => hasErrorStatusAndCode(err, 400, "invalid-control")
  );
});

test("D1 test hooks: disabled environments fail closed", () => {
  assert.doesNotThrow(() => assertD1TestHooksEnabled({ D1_TEST_HOOKS: "1" }));
  assert.throws(
    () => assertD1TestHooksEnabled({}),
    (err) => hasErrorStatusAndCode(err, 404, "not-found")
  );
  assert.equal(isD1ActorTestHook({ __control: "hold-transaction" }), true);
  assert.equal(isD1ActorTestHook({ __control: "wait-until-idle" }), false);
});
