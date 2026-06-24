// Holds a WebSocket open for >4 minutes through the gateway. Anchors the
// workerd hang-window regression: a gateway-worker fetch handler holding
// a 101 used to be aborted with `Worker's code had hung` past ~3 min;
// the GatewayWsHolder DO routes the upgrade onto an actor IoContext,
// which `IoContext::abortFromHang` skips.
//
// Renamed off `.test.js` so the default integration runner does not pick
// it up. Run explicitly:
//   node --test tests/integration/manual/websocket-long-hold.manual.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  deployAndPromote,
  ensureStackUp,
  encodeClientTextFrame,
  readOneServerTextFrame,
  uniqueNs,
  wsHandshake,
} from "../helpers/index.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const TICK_COUNT = 9;

before(async () => {
  await ensureStackUp();
});

test(
  "gateway holds a WebSocket open for >4 minutes across the workerd hang window",
  { timeout: TICK_COUNT * HEARTBEAT_INTERVAL_MS + 60_000 },
  async () => {
    const ns = uniqueNs("ws-long-hold");
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

    const { status, socket } = await wsHandshake(ns, "/echo");
    assert.equal(status, 101);
    try {
      for (let i = 0; i < TICK_COUNT; i++) {
        const elapsedSeconds = i * (HEARTBEAT_INTERVAL_MS / 1000);
        const expected = `tick-${i}`;
        socket.write(encodeClientTextFrame(expected));
        const reply = await readOneServerTextFrame(socket, { timeoutMs: 10_000 });
        assert.equal(
          reply,
          `echo:${expected}`,
          `tick ${i} (~${elapsedSeconds}s in)`
        );
        if (i < TICK_COUNT - 1) {
          await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_INTERVAL_MS));
        }
      }
    } finally {
      socket.destroy();
    }
  }
);
