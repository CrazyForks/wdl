import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { importRepositoryModule } from "../helpers/load-shared-module.js";
import { OBSERVABILITY_NOOP_URL } from "../helpers/mocks/observability.js";

const {
  forgetStorageSize,
  observedStorageSizeBytes,
  recordPayloadStorageSize,
  recordStorageSizeForDb,
  storageSizeByDb,
} = await importRepositoryModule("d1-runtime/state.js", [
  [/from "shared-observability";/, `from ${JSON.stringify(OBSERVABILITY_NOOP_URL)};`],
]);

beforeEach(() => {
  storageSizeByDb.clear();
});

test("D1 state: storage size accounting records the last successful owner-observed payload size", () => {
  recordPayloadStorageSize("tenant-a:db1", [
    { success: true, meta: { size_after: 4096 } },
    { success: true, meta: { size_after: 8192 } },
  ]);
  recordPayloadStorageSize("tenant-a:db2", { success: true, meta: { size_after: 1024 } });

  assert.equal(storageSizeByDb.get("tenant-a:db1"), 8192);
  assert.equal(storageSizeByDb.get("tenant-a:db2"), 1024);
  assert.equal(observedStorageSizeBytes(), 9216);
});

test("D1 state: storage size accounting ignores malformed samples and clears on owner loss", () => {
  recordStorageSizeForDb("tenant-a:db1", 4096);
  recordStorageSizeForDb("tenant-a:db2", Number.NaN);
  recordPayloadStorageSize("tenant-a:db3", { success: true, meta: { size_after: "4096" } });

  assert.equal(observedStorageSizeBytes(), 4096);
  forgetStorageSize("tenant-a:db1");
  assert.equal(observedStorageSizeBytes(), 0);
});
