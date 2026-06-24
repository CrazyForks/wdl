// Long-lived WebSocket sessions live on this Durable Object instead of
// the gateway worker's regular fetch handler so that workerd's
// `IoContext::abortFromHang` (io-context.c++:1443) skips them via
// `KJ_ASSERT(actor == kj::none)`. Without this, a 101 request that
// outlives the workerd hang window is aborted mid-rolling.

import { DurableObject } from "cloudflare:workers";
import { jsonError } from "shared-respond";
import {
  adjustGatewayWebSocketProxyBufferedMessages,
  adjustGatewayWebSocketProxyConnections,
  log,
  recordGatewayWebSocketProxy,
  recordGatewayWebSocketSessionLifetime,
} from "gateway-runtime";
import {
  proxyGatewayWebSocket,
  webSocketProxyOptionsFromEnv,
} from "gateway-websocket";
import { parseWorkerIdObject } from "shared-worker-id";

// Stripped before forwarding so the upstream worker never sees it.
const UPSTREAM_BINDING_HEADER = "x-wdl-upstream-binding";

/**
 * Build the upstream fetch factory once and reuse it across reconnects.
 * Reusing the captured headers preserves Sec-WebSocket-Key and trace ids
 * across retries while still constructing a fresh Request for each fetch.
 * @param {Request} request
 * @param {{ fetch(request: Request): Promise<Response> }} upstreamBinding
 * @returns {() => Promise<Response & { webSocket?: WebSocket }>}
 */
export function buildUpstreamRequestFactory(request, upstreamBinding) {
  const backendUrl = request.url;
  const backendHeaders = new Headers(request.headers);
  backendHeaders.delete(UPSTREAM_BINDING_HEADER);
  const buildBackendRequest = () => new Request(backendUrl, {
    method: "GET",
    headers: backendHeaders,
  });
  return async () => /** @type {Response & { webSocket?: WebSocket }} */ (
    await upstreamBinding.fetch(buildBackendRequest())
  );
}

export class GatewayWsHolder extends DurableObject {
  /** @param {Request} request */
  async fetch(request) {
    const bindingName = request.headers.get(UPSTREAM_BINDING_HEADER) || "RUNTIME_USER";
    const upstreamBinding = this.env[bindingName];
    if (!upstreamBinding || typeof upstreamBinding.fetch !== "function") {
      return jsonError(502, "upstream_binding_missing", `Upstream binding ${bindingName} not available`);
    }

    const requestId = request.headers.get("x-request-id") || "";
    const { namespace, worker, version } = parseWorkerIdObject(
      request.headers.get("x-worker-id") || ""
    );

    const upstreamFetch = buildUpstreamRequestFactory(request, upstreamBinding);
    const initial = await upstreamFetch();
    if (initial.status !== 101 || !initial.webSocket) {
      return initial;
    }
    const accepted = /** @type {Response & { webSocket: WebSocket }} */ (initial);

    return proxyGatewayWebSocket(
      accepted,
      upstreamFetch,
      recordGatewayWebSocketProxy,
      {
        adjustBufferedMessages: adjustGatewayWebSocketProxyBufferedMessages,
        adjustConnections: adjustGatewayWebSocketProxyConnections,
        recordEvent: (
          /** @type {string} */ level,
          /** @type {string} */ event,
          /** @type {Record<string, unknown>} */ fields = {}
        ) => log(level, event, {
          request_id: requestId,
          namespace,
          worker,
          version,
          binding: bindingName,
          ...fields,
        }),
        recordSessionLifetime: recordGatewayWebSocketSessionLifetime,
      },
      webSocketProxyOptionsFromEnv(this.env)
    );
  }
}
