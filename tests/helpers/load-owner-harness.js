import {
  importRepositoryModule,
  importSpecifierReplacements,
  moduleDataUrl,
  repositoryFileUrl,
  repositoryModuleDataUrl,
  sharedModuleDataUrl,
} from "./load-shared-module.js";
import { sharedInternalAuthUrl } from "./runtime-proxy-stub.js";

/**
 * @typedef {{
 *   fetches: any[],
 *   logs: any[],
 *   metrics: any[],
 * }} OwnerHarnessState
 */

/** @returns {string} */
export function sharedOwnerLeaseUrl() {
  return sharedModuleDataUrl("shared/owner-lease.js");
}

/** @returns {string} */
export function sharedOwnerProtocolUrl() {
  return repositoryModuleDataUrl("shared/owner-protocol.js", [
    [/from "shared-owner-lease";/, `from ${JSON.stringify(sharedOwnerLeaseUrl())};`],
  ]);
}

/** @returns {string} */
export function sharedOwnerForwarderUrl() {
  return repositoryModuleDataUrl("shared/owner-forwarder.js", [
    [/from "shared-internal-auth";/, `from ${JSON.stringify(sharedInternalAuthUrl())};`],
    [/from "shared-errors";/, `from ${JSON.stringify(repositoryFileUrl("shared/errors.js"))};`],
    [/from "shared-owner-endpoint";/, `from ${JSON.stringify(repositoryFileUrl("shared/owner-endpoint.js"))};`],
  ]);
}

/**
 * @param {string} globalName
 * @param {string} service
 */
export function createOwnerClientHarness(globalName, service) {
  /** @type {OwnerHarnessState} */
  const state = { fetches: [], logs: [], metrics: [] };
  Object.defineProperty(globalThis, globalName, {
    value: state,
    configurable: true,
    writable: true,
  });
  const stateKey = JSON.stringify(globalName);
  const stateUrl = moduleDataUrl(`
export const SERVICE = ${JSON.stringify(service)};
export const metrics = {
  increment(name, labels) {
    globalThis[${stateKey}].metrics.push({ name, labels });
  },
};
export function log(level, event, fields) {
  globalThis[${stateKey}].logs.push({ level, event, fields });
}
`);
  const internalAuthUrl = sharedInternalAuthUrl();
  const errorsUrl = repositoryFileUrl("shared/errors.js");
  const ownerEndpointUrl = repositoryFileUrl("shared/owner-endpoint.js");
  const ownerLeaseUrl = sharedOwnerLeaseUrl();
  const ownerForwarderUrl = sharedOwnerForwarderUrl();

  return {
    state,
    stateUrl,
    errorsUrl,
    internalAuthUrl,
    ownerForwarderUrl,
    ownerEndpointUrl,
    ownerLeaseUrl,
    reset() {
      state.fetches = [];
      state.logs = [];
      state.metrics = [];
    },
  };
}

/**
 * @param {string} relativePath
 * @param {Record<string, string>} replacements
 */
export async function importOwnerClientModule(relativePath, replacements) {
  return await importRepositoryModule(relativePath, importSpecifierReplacements(replacements));
}
