import { decodePatternProjection } from "shared-route-projection";

/**
 * @typedef {import("shared-route-projection").PatternProjection} PatternProjection
 * @typedef {Pick<PatternProjection, "kind" | "value"> & { host: string, slot: string }} RoutePattern
 * @typedef {Record<string, Record<string, string | null | undefined>>} HostState
 */

/** @param {RoutePattern} r */
export function routeKey(r) { return `${r.host}|${r.slot}`; }

/** @param {RoutePattern[]} routes */
export function computeRouteKeySet(routes) {
  return new Set(routes.map(routeKey));
}

/** @param {RoutePattern[]} oldRoutes @param {RoutePattern[]} newRoutes */
export function computeAffectedHosts(oldRoutes, newRoutes) {
  return new Set(oldRoutes.map((r) => r.host)).union(new Set(newRoutes.map((r) => r.host)));
}

/** @param {string} ns @param {Set<string>} affectedHosts @param {RoutePattern[]} oldRoutes @param {RoutePattern[]} newRoutes @param {Set<string>} newRouteKeys @param {HostState} hostState */
export function computeNsHostDeltas(ns, affectedHosts, oldRoutes, newRoutes, newRouteKeys, hostState) {
  /** @type {string[]} */
  const nsHostsAdd = [];
  /** @type {string[]} */
  const nsHostsRem = [];
  const newByHost = Map.groupBy(newRoutes, (r) => r.host);
  const removedByHost = Map.groupBy(
    oldRoutes.filter((r) => !newRouteKeys.has(routeKey(r))),
    (r) => r.host
  );
  for (const h of affectedHosts) {
    const remaining = new Map(Object.entries(hostState[h] || {}));
    for (const r of removedByHost.get(h) || []) remaining.delete(r.slot);
    for (const r of newByHost.get(h) || []) remaining.set(r.slot, "owned-by-self");
    let nsOwns = false;
    for (const [, raw] of remaining) {
      if (raw === "owned-by-self") { nsOwns = true; break; }
      const p = decodePatternProjection(raw);
      if (p && p.ns === ns) { nsOwns = true; break; }
    }
    (nsOwns ? nsHostsAdd : nsHostsRem).push(h);
  }
  return { nsHostsAdd, nsHostsRem };
}

/** @param {Record<string, string | null | undefined>} hash */
export function stringHash(hash) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(hash)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
