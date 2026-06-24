import { test } from "node:test";
import assert from "node:assert/strict";
import {
  call,
  setup,
} from "./helpers/d1-runtime.js";
import {
  composeRecreate,
  composeRestart,
  uniqueNs,
  setupIntegrationSuite,
} from "./helpers/index.js";

setupIntegrationSuite();

test("D1 localDisk storage survives d1-runtime restart", async () => {
  const ns = uniqueNs("d1persist");
  await setup(ns, "app", "persistent-main");

  await call(ns, "app", { op: "init" });
  await call(ns, "app", { op: "insert", id: "m3", body: "before-restart" });

  composeRestart("d1-runtime");

  assert.deepEqual(await call(ns, "app", { op: "get", id: "m3" }), {
    id: "m3",
    body: "before-restart",
  });
});

test("D1 volume-backed localDisk survives d1-runtime container recreate", async () => {
  const ns = uniqueNs("d1recreate");
  await setup(ns, "app", "recreate-main");

  await call(ns, "app", { op: "init" });
  await call(ns, "app", { op: "insert", id: "m4", body: "before-recreate" });

  composeRecreate("d1-runtime");

  assert.deepEqual(await call(ns, "app", { op: "get", id: "m4" }), {
    id: "m4",
    body: "before-recreate",
  });
});
