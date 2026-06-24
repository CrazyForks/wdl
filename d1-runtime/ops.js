import {
  peekTaskIdentity,
} from "d1-runtime-task-identity";
import {
  drainOwnedDbs,
  ownerTtlSeconds,
  readOwner,
  rebalanceOwnedDbs,
  renewOwnedDbs,
} from "d1-runtime-owner-registry";
import {
  isDraining,
  metrics,
  observedStorageSizeBytes,
  ownedDbs,
  SERVICE,
} from "d1-runtime-state";
import { json } from "d1-runtime-http";
import { readD1JsonObjectRequest } from "d1-runtime-protocol";
import { prometheusResponse } from "shared-respond";

/** @param {URL} url @param {Record<string, unknown>} env */
export async function handleProbe(url, env) {
  const dbKey = url.searchParams.get("dbKey");
  const rawGeneration = url.searchParams.get("generation");
  const generation = rawGeneration == null || rawGeneration === "" ? null : Number(rawGeneration);
  const owner = dbKey == null ? null : await readOwner(env, dbKey);
  const identity = peekTaskIdentity(env);
  return json({
    status: isDraining() ? "draining" : "owner-alive",
    taskId: identity?.taskId || null,
    endpoint: identity?.endpoint || null,
    dbKey,
    generation: generation != null && Number.isInteger(generation) && generation >= 0 ? generation : null,
    owner,
    draining: isDraining(),
  }, { status: isDraining() ? 503 : 200 });
}

/** @param {Record<string, unknown>} env */
export async function handleHealth(env) {
  return json({
    status: isDraining() ? "draining" : "ok",
    taskId: peekTaskIdentity(env)?.taskId || null,
    endpoint: peekTaskIdentity(env)?.endpoint || null,
    draining: isDraining(),
    ownerTtlSeconds: ownerTtlSeconds(env),
    ownerDbs: { owned: ownedDbs.size },
    observedStorageSizeBytes: observedStorageSizeBytes(),
  }, { status: isDraining() ? 503 : 200 });
}

export function handleMetrics() {
  metrics.setGauge("d1_open_db_count", { service: SERVICE }, ownedDbs.size);
  metrics.setGauge("d1_storage_size_bytes", { service: SERVICE }, observedStorageSizeBytes());
  return prometheusResponse(metrics);
}

/** @param {Record<string, unknown>} env */
export async function handleDrain(env) {
  return json(await drainOwnedDbs(env));
}

/** @param {Record<string, unknown>} env */
export async function handleRenew(env) {
  return json(await renewOwnedDbs(env));
}

/** @param {Request} request @param {Record<string, unknown>} env */
export async function handleRebalance(request, env) {
  return json(await rebalanceOwnedDbs(env, await readD1JsonObjectRequest(request, {
    label: "D1 rebalance",
  })));
}
