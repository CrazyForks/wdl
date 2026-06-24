// Multi-module bundles: text/json/wasm/data round-trip through Redis +
// workerLoader without corruption. Assumes compose stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deployAndPromote, gatewayFetch, responseJson, setupIntegrationSuite } from "./helpers/index.js";

setupIntegrationSuite();

test("text + json + data bundled together", async () => {
  const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10]; // PNG magic
  await deployAndPromote("modns1", "multi", {
    mainModule: "worker.js",
    modules: {
      "worker.js": `
        import config from "./config.json";
        import greeting from "./greeting.txt";
        import icon from "./icon.png";
        export default {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/config") return Response.json(config);
            if (url.pathname === "/greeting") return new Response(greeting);
            if (url.pathname === "/icon") {
              return new Response(icon, { headers: { "content-type": "image/png" }});
            }
            return new Response("not found", { status: 404 });
          }
        };
      `,
      "config.json": { json: { name: "multi", version: 1 } },
      "greeting.txt": { text: "hello world" },
      "icon.png": { data_b64: Buffer.from(pngBytes).toString("base64") },
    },
  });

  const cfg = await gatewayFetch("modns1", "/multi/config");
  assert.equal(cfg.status, 200);
  assert.deepEqual(await responseJson(cfg), { name: "multi", version: 1 });

  const g = await gatewayFetch("modns1", "/multi/greeting");
  assert.equal(await g.text(), "hello world");

  const icon = await gatewayFetch("modns1", "/multi/icon");
  const iconBytes = new Uint8Array(await icon.arrayBuffer());
  assert.deepEqual(Array.from(iconBytes), pngBytes);
});

test("compatibilityDate and vars propagated", async () => {
  await deployAndPromote("modns2", "v", {
    mainModule: "worker.js",
    compatibilityDate: "2026-04-24",
    vars: { GREETING: "hi-from-vars" },
    modules: {
      "worker.js": `export default {
        fetch(request, env) {
          return new Response(env.GREETING || "(no var)");
        }
      };`,
    },
  });
  const res = await gatewayFetch("modns2", "/v");
  assert.equal(await res.text(), "hi-from-vars");
});
