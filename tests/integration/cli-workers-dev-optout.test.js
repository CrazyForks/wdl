// @wdl-cli-integration
// End-to-end CLI deploy of test-workers/workers-dev-optout: the CLI turns
// wrangler `workers_dev = false` into the `workersDev` the platform sees, so
// the pattern route keeps serving while the platform-domain path 404s.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminPost,
  assertOk,
  assertStatus,
  gatewayFetch,
  hostFetch,
  responseJson,
  runWdlCli,
  setupIntegrationSuite,
  uniqueNs,
} from "./helpers/index.js";

const OPT_OUT_HOST = "optout.workers.example";

setupIntegrationSuite();

test("workers-dev-optout: cli deploy keeps the pattern route and drops the platform URL", async () => {
  const ns = uniqueNs("wdopt");
  const decl = await adminPost(`/ns/${ns}/hosts`, { hosts: [OPT_OUT_HOST] });
  assertStatus(decl, 200, "host declaration");

  const deploy = runWdlCli(["deploy", "test-workers/workers-dev-optout", "--ns", ns]);
  assertOk(deploy);
  assert.match(
    deploy.stdout,
    /https?:\/\/optout\.workers\.example(?::\d+)?\/\*/
  );
  assert.doesNotMatch(
    deploy.stdout,
    new RegExp(
      `https?://${RegExp.escape(ns)}\\.workers\\.local(?::\\d+)?/workers-dev-optout/`
    )
  );

  const routed = await hostFetch(OPT_OUT_HOST, "/hello");
  assertStatus(routed, 200, "pattern route after opt-out");
  assert.deepEqual(await responseJson(routed), {
    worker: "workers-dev-optout",
    host: OPT_OUT_HOST,
    path: "/hello",
  });

  assertStatus(
    await gatewayFetch(ns, "/workers-dev-optout/hello"),
    404,
    "platform-domain path after opt-out"
  );
});
