// Local/manual websocket hang repro. Stops the backend longer
// than the reconnect budget, then closes the client to drop the
// remaining couple()-side PendingEvent so workerd's hang detector can
// fire if this path is on the gateway-worker IoContext. The DO holder
// path is exempt and should produce no "had hung".
//
// Renamed off `.test.js` so the default integration runner does not
// pick it up — this test stops `user-runtime`, which would break every
// later test sharing the same compose project. Run explicitly:
//   node --test tests/integration/manual/websocket-hang-repro.manual.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  composeStart,
  composeStop,
  composeUpNoBuildFlag,
  deployAndPromote,
  ensureStackUp,
  encodeClientTextFrame,
  readOneServerTextFrame,
  sh,
  uniqueNs,
  wsHandshake,
} from "../helpers/index.js";

before(async () => {
  await ensureStackUp();
});

test(
  "backend stays down past reconnect budget while WS is held",
  { timeout: 6 * 60_000 },
  async () => {
    const ns = uniqueNs("ws-hang-repro");
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
    await deployAndPromote(ns, "echo", { code });

    const { status, headers, socket } = await wsHandshake(ns, "/echo");
    assert.equal(status, 101);
    const requestId = headers["x-request-id"];
    assert.ok(requestId, "x-request-id should land on the 101 response");

    let backendStopped = false;

    try {
      socket.write(encodeClientTextFrame("warmup"));
      assert.equal(await readOneServerTextFrame(socket), "echo:warmup");

      composeStop("user-runtime");
      backendStopped = true;

      // Wait through the reconnect budget (~9s) plus a small grace.
      await new Promise((resolve) => setTimeout(resolve, 15_000));

      // Drop the remaining PendingEvent (couple()'s eyeball pump) so
      // the IoContext can reach the abort condition.
      socket.destroy();

      await new Promise((resolve) => setTimeout(resolve, 60_000));
    } finally {
      try { socket.destroy(); } catch {}
      if (backendStopped) {
        try {
          composeStart("user-runtime");
          sh(`docker compose up -d${composeUpNoBuildFlag()} --wait user-runtime`);
        } catch (err) {
          console.error("failed to restart user-runtime:", err);
        }
      }
    }

    // workerd's hang error is from server.c++ stderr, not our structured
    // logger, so it may not carry our request id — search both.
    const gatewayLogs = sh("docker compose logs gateway --since=8m", { stdio: "pipe" });
    const idLogs = gatewayLogs
      .split("\n")
      .filter((line) => line.includes(requestId))
      .join("\n");
    const allLogs = gatewayLogs
      .split("\n")
      .filter((line) => /had hung|abortFromHang|worker.*hung/i.test(line))
      .join("\n");
    const hung = /had hung/i.test(idLogs) || /had hung/i.test(allLogs);
    const reconnectFailed = /websocket_reconnect_failed/.test(idLogs);

    console.log("repro result", { requestId, reconnectFailed, hung });
    console.log("---structured log for this request---");
    console.log(idLogs);
    if (allLogs.trim().length > 0) {
      console.log("---hang-related lines (any request)---");
      console.log(allLogs);
    }

    assert.ok(reconnectFailed, "gateway should log websocket_reconnect_failed");

    if (hung) {
      console.log("HANG DETECTOR FIRED on this path");
    } else {
      console.log("no hang detector fire on this path");
    }
  }
);
