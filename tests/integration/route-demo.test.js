// @wdl-cli-integration
// End-to-end CLI deploy of test-workers/route-demo: CLI parses wrangler `routes`,
// admin stores them in version meta, promote populates patterns:<host>,
// gateway dispatches by Host/path-prefix, worker sees the full request path.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runWdlCli,
  setupIntegrationSuite,
  uniqueNs,
  adminPost,
  hostFetch,
  responseJson,
} from "./helpers/index.js";

setupIntegrationSuite();

test("route-demo: cli deploys with routes; gateway dispatches two disjoint slots", async () => {
  const ns = uniqueNs("rd");
  // Hosts are an operator concern, not the CLI's — declare before promote.
  const decl = await adminPost(`/ns/${ns}/hosts`, { hosts: ["demo.workers.example"] });
  assert.equal(decl.status, 200);

  const deploy = runWdlCli(["deploy", "test-workers/route-demo", "--ns", ns]);
  assert.equal(deploy.status, 0, deploy.stderr || deploy.stdout);

  // /abc/* slash-bounded prefix: path is forwarded unchanged, matched=/abc/*.
  const abc = await hostFetch("demo.workers.example", "/abc/foo?x=1");
  assert.equal(abc.status, 200);
  const abcBody = await responseJson(abc);
  assert.equal(abcBody.worker, "route-demo");
  assert.equal(abcBody.host, "demo.workers.example");
  assert.equal(abcBody.path, "/abc/foo");
  assert.equal(abcBody.query, "?x=1");
  assert.equal(abcBody.matched, "/abc/*");

  // /bcd* startsWith glob: matches /bcd, /bcdef, /bcd/zzz, all to slot "/bcd*".
  const bcdef = await hostFetch("demo.workers.example", "/bcdef");
  assert.equal(bcdef.status, 200);
  assert.equal((await responseJson(bcdef)).matched, "/bcd*");

  // No matching slot → 404 from gateway; never reaches runtime.
  const def = await hostFetch("demo.workers.example", "/def");
  assert.equal(def.status, 404);
  assert.deepEqual(await responseJson(def), { error: "not_found", message: "Not found" });
});
