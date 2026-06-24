import { WorkerEntrypoint } from "cloudflare:workers";
import {
  DO_CONNECT_URL,
  DO_INVOKE_URL,
  connectHeaders,
  doOwnerHintCacheKey,
  dispatchDoRequestWithOwnerHint,
  fetchInvokeInit,
  isWebSocketUpgrade,
  retryableOwnerRaceResponse,
  rpcInvokeInit,
  rpcResultFromResponse,
  staleDoOwnerHintResponse,
  stripOwnerHintHeaders,
  withoutOwnerHintOptIn,
} from "runtime-do-transport";
import { createOwnerHintCache } from "runtime-owner-hint-cache";
import { withInternalAuth } from "shared-internal-auth";

/**
 * @typedef {{ ns: string, worker: string, version: string, doStorageId: string, className: string }} DoBindingProps
 * @typedef {{ DO_BACKEND: { fetch(url: string, init?: RequestInit): Promise<Response> }, WDL_INTERNAL_AUTH_TOKEN?: unknown }} DoBindingEnv
 * @typedef {{ ctx: { props: DoBindingProps }, env: DoBindingEnv }} DoBinding
 */

const ownerHintCache = createOwnerHintCache();

/** @param {Request} request */
function replayOwnerUnavailableForFetch(request) {
  const method = request.method.toUpperCase();
  return method === "GET" || method === "HEAD";
}

/** @param {DurableObjectNamespace} binding @returns {DoBinding} */
function doBinding(binding) {
  return /** @type {DoBinding} */ (/** @type {unknown} */ (binding));
}

/** @param {DurableObjectNamespace} binding */
function propsOf(binding) {
  const view = doBinding(binding);
  const props = view.ctx.props || /** @type {DoBindingProps} */ ({});
  return {
    ns: props.ns,
    worker: props.worker,
    version: props.version,
    doStorageId: props.doStorageId,
    className: props.className,
  };
}

/**
 * @param {DurableObjectNamespace} binding
 * @param {RequestInit} init
 * @param {string} objectName
 * @param {{ replayOwnerUnavailable?: boolean }} [options]
 */
async function dispatchInvokeWithOwnerHint(binding, init, objectName, { replayOwnerUnavailable = false } = {}) {
  const backend = doBinding(binding).env.DO_BACKEND;
  const props = propsOf(binding);
  const hintKey = doOwnerHintCacheKey(props, objectName);
  const response = await dispatchDoRequestWithOwnerHint({
    routerFetch: (url, requestInit) => backend.fetch(url, requestInit),
    routerUrl: DO_INVOKE_URL,
    ownerFetch: fetch,
    ownerPath: "/internal/do/invoke",
    init,
    cachedHint: /** @type {import("runtime-do-transport").DoOwnerHint | null} */ (ownerHintCache.get(hintKey)),
    rememberHint: (hint) => ownerHintCache.set(hintKey, hint),
    clearHint: () => ownerHintCache.delete(hintKey),
    staleCachedResponse: staleDoOwnerHintResponse,
    bypassOwnerHintResponse: retryableOwnerRaceResponse,
    replayOwnerUnavailable,
  });
  if (await retryableOwnerRaceResponse(response)) {
    ownerHintCache.delete(hintKey);
    return stripOwnerHintHeaders(await backend.fetch(DO_INVOKE_URL, withoutOwnerHintOptIn(init)));
  }
  return stripOwnerHintHeaders(response);
}

export class DurableObjectNamespace extends WorkerEntrypoint {
  /**
   * @param {string} objectName
   * @param {Request} request
   * @param {string | null} [requestId]
   * @returns {Promise<Response>}
   */
  async fetchObject(objectName, request, requestId = null) {
    const props = propsOf(this);
    // This facade is only used inside do-runtime for DO-to-DO calls. The
    // self-service calls intentionally start fresh internal requests; owner
    // forwarding, if needed, will add and enforce hop-count headers.
    if (isWebSocketUpgrade(request)) {
      const init = {
        method: "GET",
        headers: withInternalAuth(connectHeaders(props, objectName, request, requestId), doBinding(this).env),
      };
      const hintKey = doOwnerHintCacheKey(props, objectName);
      return stripOwnerHintHeaders(await dispatchDoRequestWithOwnerHint({
        routerFetch: (url, requestInit) => doBinding(this).env.DO_BACKEND.fetch(url, requestInit),
        routerUrl: DO_CONNECT_URL,
        ownerFetch: fetch,
        ownerPath: "/internal/do/connect",
        init,
        cachedHint: /** @type {import("runtime-do-transport").DoOwnerHint | null} */ (ownerHintCache.get(hintKey)),
        rememberHint: (hint) => ownerHintCache.set(hintKey, hint),
        clearHint: () => ownerHintCache.delete(hintKey),
        staleCachedResponse: staleDoOwnerHintResponse,
        replayOwnerUnavailable: false,
      }));
    }
    const init = await fetchInvokeInit(props, objectName, request, requestId);
    init.headers = withInternalAuth(init.headers, doBinding(this).env);
    return await dispatchInvokeWithOwnerHint(this, init, objectName, {
      replayOwnerUnavailable: replayOwnerUnavailableForFetch(request),
    });
  }

  /**
   * @param {string} objectName
   * @param {string} method
   * @param {unknown[]} args
   * @param {string | null} [requestId]
   */
  async rpcObject(objectName, method, args, requestId = null) {
    const props = propsOf(this);
    const init = rpcInvokeInit(props, objectName, method, args, requestId);
    init.headers = withInternalAuth(init.headers, doBinding(this).env);
    const routed = await dispatchInvokeWithOwnerHint(this, init, objectName);
    return await rpcResultFromResponse(routed);
  }
}
