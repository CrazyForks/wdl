import assert from "node:assert/strict";
import { test } from "node:test";
import {
  importRepositoryModule,
  importSpecifierReplacements,
  moduleDataUrl,
} from "../helpers/load-shared-module.js";
import { d1ProtocolDataUrl } from "../helpers/load-d1-protocol.js";
import { readJsonResponse } from "../helpers/response-json.js";

const taskIdentityUrl = moduleDataUrl(`
export function peekTaskIdentity() {
  return { taskId: "d1-runtime-a", endpoint: "d1-runtime-a:8787" };
}
`);
const ownerRegistryUrl = moduleDataUrl(`
export async function drainOwnedDbs() { return { released: 0 }; }
export function ownerTtlSeconds() { return 120; }
export async function readOwner() { return null; }
export async function rebalanceOwnedDbs(_env, body) { return { body }; }
export async function renewOwnedDbs() { return { renewed: 0 }; }
`);
const stateUrl = moduleDataUrl(`
export const SERVICE = "d1-runtime";
export const metrics = { setGauge() {}, renderPrometheus() { return ""; } };
export const ownedDbs = new Map();
export function isDraining() { return false; }
export function observedStorageSizeBytes() { return 0; }
`);
const httpUrl = moduleDataUrl(`
export function json(data, init = {}) {
  return Response.json(data, init);
}
`);
const respondUrl = moduleDataUrl(`
export function prometheusResponse() {
  return new Response("");
}
`);

const {
  handleProbe,
  handleRebalance,
} = await importRepositoryModule("d1-runtime/ops.js", importSpecifierReplacements({
  "d1-runtime-task-identity": taskIdentityUrl,
  "d1-runtime-owner-registry": ownerRegistryUrl,
  "d1-runtime-state": stateUrl,
  "d1-runtime-http": httpUrl,
  "d1-runtime-protocol": d1ProtocolDataUrl(),
  "shared-respond": respondUrl,
}));

test("D1 probe treats empty generation query as absent", async () => {
  const response = await handleProbe(new URL("https://d1-runtime/internal/d1/probe?dbKey=db1&generation="), {});
  const body = await readJsonResponse(response, 200);
  assert.equal(body.generation, null);
});

test("D1 probe preserves zero generation query values", async () => {
  const response = await handleProbe(new URL("https://d1-runtime/internal/d1/probe?dbKey=db1&generation=0"), {});
  const body = await readJsonResponse(response, 200);
  assert.equal(body.generation, 0);
});

test("D1 rebalance reads a bounded JSON body", async () => {
  const response = await handleRebalance(new Request("https://d1-runtime/internal/d1/rebalance", {
    method: "POST",
    body: JSON.stringify({ target: "task-a" }),
  }), {});
  const body = await readJsonResponse(response, 200);
  assert.deepEqual(body.body, { target: "task-a" });

  await assert.rejects(
    () => handleRebalance(new Request("https://d1-runtime/internal/d1/rebalance", {
      method: "POST",
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      body: "{}",
    }), {}),
    (err) => err instanceof Error &&
      /** @type {{ status?: unknown, code?: unknown }} */ (err).status === 413 &&
      /** @type {{ status?: unknown, code?: unknown }} */ (err).code === "limit-exceeded" &&
      /maximum D1 rebalance body/.test(err.message)
  );
});
