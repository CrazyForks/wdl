// @wdl-cli-integration
// End-to-end CLI deploy of test-workers/pages-assets: CLI bundles the worker via
// wrangler, sends the `public/` tree as assets, admin uploads to s3mock,
// gateway routes, and the browser can fetch both the worker HTML and the
// CDN-hosted static files.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSETS_CDN_BASE,
  gatewayFetch,
  rawHttpGet,
  runWdlCli,
  uniqueNs,
  setupIntegrationSuite,
} from "./helpers/index.js";

const CDN_BASE = ASSETS_CDN_BASE;

setupIntegrationSuite();

test("pages-assets demo: CLI deploys, gateway serves HTML with CDN URLs, CDN returns bytes", async () => {
  const ns = uniqueNs("pa");
  const deploy = runWdlCli(["deploy", "test-workers/pages-assets", "--ns", ns]);
  assert.equal(deploy.status, 0, deploy.stderr || deploy.stdout);

  const res = await gatewayFetch(ns, "/pages-assets");
  assert.equal(res.status, 200);
  const html = await res.text();

  // URL shape: `${CDN_BASE}/assets/<ns>/<worker>/<28-hex token>/<path>`.
  // Pull whichever token the deploy happened to generate so we can fetch.
  const cssPattern = new RegExp(
    `${RegExp.escape(CDN_BASE)}/assets/${RegExp.escape(ns)}/pages-assets/[0-9a-f]{28}/style\\.css`
  );
  const txtPattern = new RegExp(
    `${RegExp.escape(CDN_BASE)}/assets/${RegExp.escape(ns)}/pages-assets/[0-9a-f]{28}/hello\\.txt`
  );
  const cssMatch = html.match(cssPattern);
  const txtMatch = html.match(txtPattern);
  assert.ok(cssMatch, `expected CSS URL ${cssPattern} in HTML:\n${html}`);
  assert.ok(txtMatch, `expected TXT URL ${txtPattern} in HTML:\n${html}`);

  const css = await rawHttpGet(cssMatch[0]);
  assert.equal(css.status, 200);
  assert.match(String(css.headers.get("content-type") || ""), /text\/css/);
  assert.match(await css.text(), /font-family/);

  const txt = await rawHttpGet(txtMatch[0]);
  assert.equal(txt.status, 200);
  assert.match(await txt.text(), /Hello from the CDN/);
});
