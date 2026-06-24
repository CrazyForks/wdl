// ASSETS binding: admin uploads static files to s3mock on deploy, runtime
// hands URLs to the worker via env.ASSETS.url(). Assumes compose stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminFetch,
  ASSETS_CDN_BASE,
  deployAndPromote,
  gatewayFetch,
  rawHttpGet,
  responseJson,
  uniqueNs,
  setupIntegrationSuite,
} from "./helpers/index.js";

const CDN_BASE = ASSETS_CDN_BASE;

const ASSETS_WORKER = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.searchParams.get("path") || "";
    return new Response(await env.ASSETS.url(p));
  }
};`;

setupIntegrationSuite();

// URL shape: `${CDN_BASE}/assets/<ns>/<worker>/<28-hex-token>/<path>`.
// Each deploy gets a fresh token; rollback pivots to the older token.
/** @param {string} ns @param {string} worker @param {string} path */
function assetUrlShape(ns, worker, path) {
  return new RegExp(
    `^${RegExp.escape(CDN_BASE)}/assets/${RegExp.escape(ns)}/${RegExp.escape(worker)}/[0-9a-f]{28}/${RegExp.escape(path)}$`
  );
}

test("ASSETS binding: url() returns tokenized CDN URL", async () => {
  const ns = uniqueNs("assets-url");
  await deployAndPromote(ns, "w", {
    mainModule: "worker.js",
    modules: { "worker.js": ASSETS_WORKER },
    assets: {
      "logo.txt": Buffer.from("hello assets").toString("base64"),
    },
  });
  const r = await gatewayFetch(ns, "/w?path=logo.txt");
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, assetUrlShape(ns, "w", "logo.txt"));
});

test("ASSETS binding: uploaded file is reachable on s3mock", async () => {
  const ns = uniqueNs("assets-fetch");
  const payload = "body { color: red; }";
  await deployAndPromote(ns, "w", {
    mainModule: "worker.js",
    modules: { "worker.js": ASSETS_WORKER },
    assets: {
      "css/app.css": Buffer.from(payload).toString("base64"),
    },
  });
  const urlRes = await gatewayFetch(ns, "/w?path=css/app.css");
  const cdnUrl = await urlRes.text();
  assert.match(cdnUrl, assetUrlShape(ns, "w", "css/app.css"));
  const direct = await rawHttpGet(cdnUrl);
  assert.equal(direct.status, 200);
  assert.equal(await direct.text(), payload);
  assert.match(String(direct.headers.get("content-type") || ""), /text\/css/);
});

test("ASSETS binding: url() on different path pivots without redeploy", async () => {
  const ns = uniqueNs("assets-multi");
  await deployAndPromote(ns, "w", {
    mainModule: "worker.js",
    modules: { "worker.js": ASSETS_WORKER },
    assets: {
      "a.txt": Buffer.from("A").toString("base64"),
      "b.txt": Buffer.from("B").toString("base64"),
      "sub/c.txt": Buffer.from("C").toString("base64"),
    },
  });
  for (const [path, expected] of [
    ["a.txt", "A"],
    ["b.txt", "B"],
    ["sub/c.txt", "C"],
  ]) {
    const urlRes = await gatewayFetch(ns, `/w?path=${encodeURIComponent(path)}`);
    const cdnUrl = await urlRes.text();
    assert.match(cdnUrl, assetUrlShape(ns, "w", path));
    const direct = await rawHttpGet(cdnUrl);
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), expected);
  }
});

test("ASSETS binding: promoting a new version pivots url() output", async () => {
  const ns = uniqueNs("assets-version");
  const v1 = await deployAndPromote(ns, "w", {
    mainModule: "worker.js",
    modules: { "worker.js": ASSETS_WORKER },
    assets: { "msg.txt": Buffer.from("v1-content").toString("base64") },
  });
  const r1 = await gatewayFetch(ns, "/w?path=msg.txt");
  const url1 = await r1.text();
  assert.match(url1, assetUrlShape(ns, "w", "msg.txt"));
  const old = await rawHttpGet(url1);
  assert.equal(await old.text(), "v1-content");

  const v2 = await deployAndPromote(ns, "w", {
    mainModule: "worker.js",
    modules: { "worker.js": ASSETS_WORKER },
    assets: { "msg.txt": Buffer.from("v2-content").toString("base64") },
  });
  assert.notEqual(v1, v2);
  const r2 = await gatewayFetch(ns, "/w?path=msg.txt");
  const url2 = await r2.text();
  assert.match(url2, assetUrlShape(ns, "w", "msg.txt"));
  assert.notEqual(url1, url2, "token flip on new deploy");

  // Old version's assets stay reachable — rollback is a pointer flip.
  const oldDirect = await rawHttpGet(url1);
  assert.equal(await oldDirect.text(), "v1-content");
});

test("ASSETS binding: deploy rejects invalid base64 in assets map", async () => {
  const ns = uniqueNs("assets-bad");
  const res = await adminFetch(`/ns/${ns}/worker/w/deploy`, {
    method: "POST",
    body: JSON.stringify({
      mainModule: "worker.js",
      modules: { "worker.js": ASSETS_WORKER },
      assets: { "x.txt": "not valid base64!!!" },
    }),
  });
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.equal(body.error, "invalid_request");
  assert.match(body.message, /Invalid base64/);
});

test("ASSETS binding: deploy rejects path traversal in assets map", async () => {
  const ns = uniqueNs("assets-trav");
  const res = await adminFetch(`/ns/${ns}/worker/w/deploy`, {
    method: "POST",
    body: JSON.stringify({
      mainModule: "worker.js",
      modules: { "worker.js": ASSETS_WORKER },
      assets: { "../evil": Buffer.from("x").toString("base64") },
    }),
  });
  assert.equal(res.status, 400);
  const body = await responseJson(res);
  assert.equal(body.error, "invalid_request");
  assert.match(body.message, /invalid path/);
});
