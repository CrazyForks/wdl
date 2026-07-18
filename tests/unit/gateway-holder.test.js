import { test } from "node:test";
import assert from "node:assert/strict";
import {
  importRepositoryModule,
  repositoryFileUrl,
} from "../helpers/load-shared-module.js";
import { assertJsonResponse } from "../helpers/response-json.js";

const holderModule = await importRepositoryModule("gateway/holder.js", [
  [
    /import \{ DurableObject \} from "cloudflare:workers";/,
    "class DurableObject {}"
  ],
  [
    /import \{ jsonError \} from "shared-respond";/,
    "function jsonError(status, error, message) { return new Response(JSON.stringify({ error, message }), { status }); }"
  ],
  [
    /import \{[\s\S]*?\} from "gateway-runtime";/,
    `const adjustGatewayWebSocketProxyBufferedMessages = () => {};
const adjustGatewayWebSocketProxyConnections = () => {};
const log = () => {};
const recordGatewayWebSocketProxy = () => {};
const recordGatewayWebSocketSessionLifetime = () => {};`
  ],
  [
    /import \{[\s\S]*?\} from "gateway-websocket";/,
    `const proxyGatewayWebSocket = (...args) => {
  globalThis.__gatewayProxyCalls.push(args);
  return new Response("proxied", { status: 200 });
};
const webSocketProxyOptionsFromEnv = () => ({});`
  ],
  [
    /import \{ parseWorkerIdObject \} from "shared-worker-id";/,
    `import { parseWorkerIdObject } from ${JSON.stringify(repositoryFileUrl("shared/worker-id.js"))};`
  ],
]);

Reflect.set(globalThis, "__gatewayProxyCalls", []);
const gatewayProxyCalls = /** @type {unknown[][]} */ (Reflect.get(globalThis, "__gatewayProxyCalls"));
const { GatewayWsHolder, buildUpstreamRequestFactory } = holderModule;

test("GatewayWsHolder fetch rejects missing upstream binding", async () => {
  const holder = new GatewayWsHolder();
  holder.env = {};

  const response = await holder.fetch(new Request("https://gateway.workers.example/ws"));
  await assertJsonResponse(response, 502, {
    error: "upstream_binding_missing",
    message: "Upstream binding RUNTIME_USER not available",
  });
});

test("GatewayWsHolder fetch passes through non-upgrade upstream responses", async () => {
  const holder = new GatewayWsHolder();
  /** @type {Request[]} */
  const requests = [];
  holder.env = {
    RUNTIME_SYSTEM: {
      /** @param {Request} request */
      async fetch(request) {
        requests.push(request);
        return new Response("plain", { status: 200 });
      },
    },
  };

  const response = await holder.fetch(new Request("https://gateway.workers.example/ws", {
    headers: { "x-wdl-upstream-binding": "RUNTIME_SYSTEM" },
  }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "plain");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.has("x-wdl-upstream-binding"), false);
});

test("GatewayWsHolder fetch proxies accepted websocket responses with stable log context", async () => {
  gatewayProxyCalls.length = 0;
  const holder = new GatewayWsHolder();
  /** @type {Request[]} */
  const requests = [];
  const accepted = /** @type {Response & { webSocket: WebSocket }} */ ({
    status: 101,
    webSocket: {},
  });
  holder.env = {
    RUNTIME_USER: {
      /** @param {Request} request */
      async fetch(request) {
        requests.push(request);
        return accepted;
      },
    },
  };

  const response = await holder.fetch(new Request("https://gateway.workers.example/ws", {
    headers: {
      "x-request-id": "rid-2",
      "x-worker-id": "demo:chat:v7",
      "x-wdl-upstream-binding": "RUNTIME_USER",
    },
  }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "proxied");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.has("x-wdl-upstream-binding"), false);
  assert.equal(gatewayProxyCalls.length, 1);
  const [, upstreamFetch, , options] = /** @type {[unknown, () => Promise<Response>, unknown, { recordEvent(level: string, event: string, fields?: Record<string, unknown>): void }]} */ (
    gatewayProxyCalls[0]
  );
  await upstreamFetch();
  assert.equal(requests.length, 2, "proxy reconnect must reuse the upstream request factory");
  options.recordEvent("warn", "ws_retry", { detail: "again" });
});

test("GatewayWsHolder upstream request factory strips holder header and preserves retry headers", async () => {
  /** @type {Request[]} */
  const requests = [];
  const upstreamFetch = buildUpstreamRequestFactory(
    new Request("https://runtime.workers.example/ws", {
      headers: {
        "sec-websocket-key": "socket-key",
        "x-request-id": "rid-1",
        "x-wdl-upstream-binding": "RUNTIME_USER",
      },
    }),
    {
      /** @param {Request} request */
      async fetch(request) {
        requests.push(request);
        return new Response("ok");
      },
    }
  );

  await upstreamFetch();
  await upstreamFetch();

  assert.equal(requests.length, 2);
  assert.notEqual(requests[0], requests[1]);
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "https://runtime.workers.example/ws");
    assert.equal(request.headers.get("sec-websocket-key"), "socket-key");
    assert.equal(request.headers.get("x-request-id"), "rid-1");
    assert.equal(request.headers.has("x-wdl-upstream-binding"), false);
  }
});
