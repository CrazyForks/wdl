import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  adminPost,
  composeRecreate,
  deployAndPromote,
  encodeClientTextFrame,
  envoyStat,
  readOneServerCloseFrame,
  readOneServerTextFrame,
  hostWsHandshake,
  gatewayUrl,
  wsHandshake,
  GATEWAY_HOST,
  GATEWAY_PORT,
  uniqueNs,
  setupIntegrationSuite,
} from "./helpers/index.js";
import { prometheusCounter } from "./helpers/prometheus.js";

setupIntegrationSuite();


/** @param {string} outcome */
async function gatewayWebSocketProxyCount(outcome) {
  const body = await (await fetch(gatewayUrl("/_metrics"))).text();
  return prometheusCounter(body, "wdl_websocket_proxies_total", {
    service: "gateway",
    outcome,
  });
}

async function gatewayWebSocketProxyEstablished() {
  return await gatewayWebSocketProxyCount("established");
}

/** @param {string} state */
async function gatewayWebSocketProxyConnections(state) {
  const body = await (await fetch(gatewayUrl("/_metrics"))).text();
  return prometheusCounter(body, "wdl_websocket_proxy_connections", {
    service: "gateway",
    state,
  });
}

/** @param {string} outcome */
async function gatewayWebSocketSessionLifetimeCount(outcome) {
  const body = await (await fetch(gatewayUrl("/_metrics"))).text();
  return prometheusCounter(body, "wdl_websocket_session_lifetime_ms_count", {
    service: "gateway",
    outcome,
  });
}

test("ws upgrade: client ⇄ gateway ⇄ runtime ⇄ loaded worker echoes a frame", async () => {
  const ns = uniqueNs("ws");
  const name = "echo";
  const code = `
    export default {
      async fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("need upgrade", { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        server.addEventListener("message", (evt) => {
          server.send("echo:" + evt.data);
        });
        return new Response(null, { status: 101, webSocket: client });
      },
    };
  `;
  await deployAndPromote(ns, name, { code });

  const beforeEnvoy = envoyStat("cluster.user_runtime.upstream_rq_total");
  const beforeProxy = await gatewayWebSocketProxyEstablished();
  const beforeActiveConnections = await gatewayWebSocketProxyConnections("active");
  const { status, headers, socket, head } = await wsHandshake(ns, `/${name}`);
  try {
    assert.equal(status, 101);
    assert.equal((headers.upgrade || "").toLowerCase(), "websocket");
    assert.equal((headers.connection || "").toLowerCase(), "upgrade");
    assert.ok(headers["x-request-id"], "x-request-id should land on the 101 response");
    assert.equal(head.length, 0, "no frame data should precede our send");

    const received = readOneServerTextFrame(socket);
    socket.write(encodeClientTextFrame("hello"));
    assert.equal(await received, "echo:hello");
    const afterEnvoy = envoyStat("cluster.user_runtime.upstream_rq_total");
    assert.ok(afterEnvoy > beforeEnvoy, "gateway should reach user-runtime through Envoy for websocket upgrades");
    assert.ok(
      await gatewayWebSocketProxyEstablished() > beforeProxy,
      "gateway should hold the external websocket and proxy frames to runtime"
    );
    assert.ok(
      await gatewayWebSocketProxyConnections("active") > beforeActiveConnections,
      "gateway should report the active held websocket"
    );
  } finally {
    socket.destroy();
  }
});

test("gateway-held ws reconnects backend after user-runtime restart", async () => {
  const ns = uniqueNs("ws-reconnect");
  const name = "echo";
  const code = `
    export default {
      async fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("need upgrade", { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        server.addEventListener("message", (evt) => {
          server.send("echo:" + evt.data);
        });
        return new Response(null, { status: 101, webSocket: client });
      },
    };
  `;
  await deployAndPromote(ns, name, { code });

  const beforeReconnect = await gatewayWebSocketProxyCount("reconnected");
  const beforeEnvoy = envoyStat("cluster.user_runtime.upstream_rq_total");
  const { status, socket } = await wsHandshake(ns, `/${name}`);
  try {
    assert.equal(status, 101);

    const first = readOneServerTextFrame(socket);
    socket.write(encodeClientTextFrame("before"));
    assert.equal(await first, "echo:before");

    composeRecreate("user-runtime");

    const second = readOneServerTextFrame(socket, { timeoutMs: 10_000 });
    socket.write(encodeClientTextFrame("after-1"));
    assert.equal(await second, "echo:after-1");
    socket.write(encodeClientTextFrame("after-2"));
    assert.equal(await readOneServerTextFrame(socket), "echo:after-2");
    assert.ok(
      await gatewayWebSocketProxyCount("reconnected") > beforeReconnect,
      "gateway should keep the client websocket open while replacing its backend websocket"
    );
    assert.ok(
      envoyStat("cluster.user_runtime.upstream_rq_total") >= beforeEnvoy + 2,
      "gateway reconnect should establish a second backend websocket through the user-runtime Envoy cluster"
    );
  } finally {
    socket.destroy();
  }
});

test("gateway-held pattern-routed ws reconnects backend after user-runtime restart", async () => {
  const ns = uniqueNs("ws-pattern-reconnect");
  const name = "echo";
  const host = `${ns}.routes.workers.example`;
  const code = `
    export default {
      async fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("need upgrade", { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        server.addEventListener("message", (evt) => {
          server.send("echo:" + evt.data);
        });
        return new Response(null, { status: 101, webSocket: client });
      },
    };
  `;
  const hosts = await adminPost(`/ns/${ns}/hosts`, { hosts: [host] });
  assert.equal(hosts.status, 200);
  await deployAndPromote(ns, name, { code, routes: [`${host}/ws/*`] });

  const beforeReconnect = await gatewayWebSocketProxyCount("reconnected");
  const beforeEnvoy = envoyStat("cluster.user_runtime.upstream_rq_total");
  const { status, socket } = await hostWsHandshake(host, "/ws/room");
  try {
    assert.equal(status, 101);

    const first = readOneServerTextFrame(socket);
    socket.write(encodeClientTextFrame("before"));
    assert.equal(await first, "echo:before");

    composeRecreate("user-runtime");

    const second = readOneServerTextFrame(socket, { timeoutMs: 10_000 });
    socket.write(encodeClientTextFrame("after"));
    assert.equal(await second, "echo:after");
    assert.ok(
      await gatewayWebSocketProxyCount("reconnected") > beforeReconnect,
      "gateway should reconnect pattern-routed backend websockets"
    );
    assert.ok(
      envoyStat("cluster.user_runtime.upstream_rq_total") >= beforeEnvoy + 2,
      "pattern-routed websocket reconnect should establish a second backend request through Envoy"
    );
  } finally {
    socket.destroy();
  }
});

test("gateway-held ws proactively reconnects backend for server-pushed frames", async () => {
  const ns = uniqueNs("ws-push-reconnect");
  const name = "push";
  const code = `
    export default {
      async fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("need upgrade", { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        setTimeout(() => {
          try {
            server.send("open");
          } catch {}
        }, 100);
        server.addEventListener("message", (evt) => {
          server.send("echo:" + evt.data);
        });
        return new Response(null, { status: 101, webSocket: client });
      },
    };
  `;
  await deployAndPromote(ns, name, { code });

  const beforeReconnect = await gatewayWebSocketProxyCount("reconnected");
  const beforeEnvoy = envoyStat("cluster.user_runtime.upstream_rq_total");
  const { status, socket } = await wsHandshake(ns, `/${name}`);
  try {
    assert.equal(status, 101);
    assert.equal(await readOneServerTextFrame(socket), "open");

    composeRecreate("user-runtime");

    assert.equal(
      await readOneServerTextFrame(socket, { timeoutMs: 15_000 }),
      "open"
    );
    assert.ok(
      await gatewayWebSocketProxyCount("reconnected") > beforeReconnect,
      "gateway should proactively reconnect the backend websocket after upstream close"
    );
    assert.ok(
      envoyStat("cluster.user_runtime.upstream_rq_total") >= beforeEnvoy + 2,
      "proactive websocket reconnect should establish a second backend request through Envoy"
    );
  } finally {
    socket.destroy();
  }
});

test("gateway-held ws closes with 1011 when backend reconnect cannot produce an upgrade", async () => {
  const ns = uniqueNs("ws-reconnect-fail");
  const name = "fail";
  const code = `
    let accepted = false;

    export default {
      async fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("need upgrade", { status: 426 });
        }
        if (accepted) {
          return new Response("backend unavailable", { status: 503 });
        }
        accepted = true;
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        setTimeout(() => {
          server.close(1011, "backend lost");
        }, 100);
        return new Response(null, { status: 101, webSocket: client });
      },
    };
  `;
  await deployAndPromote(ns, name, { code });

  const beforeFailed = await gatewayWebSocketProxyCount("reconnect_failed");
  const beforeSessionFailures = await gatewayWebSocketSessionLifetimeCount("reconnect_failed");
  const { status, socket } = await wsHandshake(ns, `/${name}`);
  try {
    assert.equal(status, 101);
    assert.deepEqual(
      await readOneServerCloseFrame(socket, { timeoutMs: 15_000 }),
      { code: 1011, reason: "upstream reconnect failed" }
    );
    assert.ok(
      await gatewayWebSocketProxyCount("reconnect_failed") > beforeFailed,
      "gateway should report bounded websocket reconnect failure"
    );
    assert.ok(
      await gatewayWebSocketSessionLifetimeCount("reconnect_failed") > beforeSessionFailures,
      "gateway should report websocket session lifetime for reconnect failures"
    );
  } finally {
    socket.destroy();
  }
});

test("non-ws requests still go through the respond() rewrite (x-request-id preserved)", async () => {
  const ns = uniqueNs("ws");
  const name = "no-upgrade";
  const code = `
    export default {
      async fetch() {
        return new Response("plain", { status: 200 });
      },
    };
  `;
  await deployAndPromote(ns, name, { code });

  await new Promise((resolve, reject) => {
    const req = http.request({
      host: GATEWAY_HOST,
      port: GATEWAY_PORT,
      method: "GET",
      path: `/${name}`,
      headers: { Host: `${ns}.workers.local` },
      agent: false,
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          assert.equal(res.statusCode, 200);
          assert.equal(Buffer.concat(chunks).toString("utf8"), "plain");
          assert.ok(res.headers["x-request-id"], "request id header preserved on non-101");
          resolve(undefined);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
});
