// @wdl-cli-integration
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSETS_CDN_BASE,
  adminGetFresh,
  adminPost,
  hostFetch,
  rawHttpGet,
  responseJson,
  runWdlCli,
  uniqueNs,
  setupIntegrationSuite,
} from "./helpers/index.js";

const CDN_BASE = ASSETS_CDN_BASE;

setupIntegrationSuite();

/** @param {string[]} args */
function runDeploy(args) {
  return runWdlCli(["deploy", "test-workers/multi-env-demo", ...args]);
}

test("multi-env demo: cli requires --env when wrangler config defines named environments", async () => {
  const ns = uniqueNs("menv");
  const res = runDeploy(["--ns", ns]);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /named environments found \(staging, production\)/);
});

test("multi-env demo: same worker name deploys across namespaces with env-specific config", async () => {
  const stagingNs = uniqueNs("menv-stg");
  const prodNs = uniqueNs("menv-prd");

  const stagingDecl = await adminPost(`/ns/${stagingNs}/hosts`, {
    hosts: ["staging.workers.example"],
  });
  assert.equal(stagingDecl.status, 200);
  const prodDecl = await adminPost(`/ns/${prodNs}/hosts`, {
    hosts: ["production.workers.example"],
  });
  assert.equal(prodDecl.status, 200);

  const stagingDeploy = runDeploy(["--ns", stagingNs, "--env", "staging"]);
  assert.equal(stagingDeploy.status, 0, stagingDeploy.stderr || stagingDeploy.stdout);
  assert.match(stagingDeploy.stdout, new RegExp(`${RegExp.escape(stagingNs)}/multi-env-demo@v1 live`));

  const productionDeploy = runDeploy(["--ns", prodNs, "--env", "production"]);
  assert.equal(productionDeploy.status, 0, productionDeploy.stderr || productionDeploy.stdout);
  assert.match(productionDeploy.stdout, new RegExp(`${RegExp.escape(prodNs)}/multi-env-demo@v1 live`));

  const stagingVersions = await adminGetFresh(`/ns/${stagingNs}/worker/multi-env-demo/versions`);
  assert.equal(stagingVersions.status, 200);
  assert.deepEqual(stagingVersions.json.versions, [{ version: "v1", active: true }]);

  const productionVersions = await adminGetFresh(`/ns/${prodNs}/worker/multi-env-demo/versions`);
  assert.equal(productionVersions.status, 200);
  assert.deepEqual(productionVersions.json.versions, [{ version: "v1", active: true }]);

  const staging = await hostFetch("staging.workers.example");
  assert.equal(staging.status, 200);
  const stagingBody = await responseJson(staging);
  const stagingUrlShape = new RegExp(
    `^${RegExp.escape(CDN_BASE)}/assets/${RegExp.escape(stagingNs)}/multi-env-demo/[0-9a-f]{28}/hello\\.txt$`
  );
  assert.match(stagingBody.assetUrl, stagingUrlShape);
  const { assetUrl: _sAssetUrl, ...stagingRest } = stagingBody;
  assert.deepEqual(stagingRest, {
    envName: "staging",
    baseOnly: null,
    shared: "staging",
    hasAssets: true,
    path: "/",
  });
  const stagingAsset = await rawHttpGet(stagingBody.assetUrl);
  assert.equal(stagingAsset.status, 200);
  assert.match(await stagingAsset.text(), /hello from inherited top-level assets/);

  const production = await hostFetch("production.workers.example");
  assert.equal(production.status, 200);
  const productionBody = await responseJson(production);
  const prodUrlShape = new RegExp(
    `^${RegExp.escape(CDN_BASE)}/assets/${RegExp.escape(prodNs)}/multi-env-demo/[0-9a-f]{28}/hello\\.txt$`
  );
  assert.match(productionBody.assetUrl, prodUrlShape);
  const { assetUrl: _pAssetUrl, ...prodRest } = productionBody;
  assert.deepEqual(prodRest, {
    envName: "production",
    baseOnly: null,
    shared: "production",
    hasAssets: true,
    path: "/",
  });
  const asset = await rawHttpGet(productionBody.assetUrl);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /hello from production override assets/);
});
