import { repositoryFileUrl, repositoryModuleDataUrl } from "./load-shared-module.js";

const SHARED_INTERNAL_AUTH_URL = repositoryFileUrl("shared/internal-auth.js");
const SHARED_RESPOND_URL = repositoryFileUrl("shared/respond.js");

/** @returns {string} */
export function runtimeProxyBindingStubUrl() {
  return repositoryModuleDataUrl("runtime/bindings/proxy.js", [
    [/from "shared-internal-auth";/, `from ${JSON.stringify(SHARED_INTERNAL_AUTH_URL)};`],
    [/from "shared-respond";/, `from ${JSON.stringify(SHARED_RESPOND_URL)};`],
  ]);
}

/** @returns {string} */
export function sharedInternalAuthUrl() {
  return SHARED_INTERNAL_AUTH_URL;
}
