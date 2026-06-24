import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyModuleReplacements,
  moduleDataUrl,
  readRepositoryFile,
  repositoryFileUrl,
} from "../helpers/load-shared-module.js";
import { withMockedFetch } from "../helpers/mock-fetch.js";
import { readJsonResponse } from "../helpers/response-json.js";
import { sharedInternalAuthUrl } from "../helpers/runtime-proxy-stub.js";

const OWNER_ENDPOINT_URL = repositoryFileUrl("runtime/_wdl-owner-endpoint.js");
const TEST_INTERNAL_AUTH_TOKEN = "test-internal-auth-token";

async function loadWorker() {
  const source = applyModuleReplacements(readRepositoryFile("runtime/do-owner-network.js"), [
    [/from "runtime-owner-endpoint";/g, `from ${JSON.stringify(OWNER_ENDPOINT_URL)};`],
    [/from "shared-internal-auth";/g, `from ${JSON.stringify(sharedInternalAuthUrl())};`],
  ]);
  return await import(moduleDataUrl(source));
}

test("do owner network forwards only valid DO owner endpoints", async () => {
  const { default: worker } = await loadWorker();
  /** @type {string[]} */
  const urls = [];
  await withMockedFetch(async (request) => {
    urls.push(request instanceof Request ? request.url : String(request));
    assert.equal(
      request instanceof Request ? request.headers.get("x-wdl-internal-auth") : null,
      TEST_INTERNAL_AUTH_TOKEN
    );
    return new Response("owner-ok");
  }, async () => {
    for (const request of [
      new Request("http://do-runtime-a:8788/internal/do/invoke", { method: "POST" }),
      new Request("http://do-runtime-a:8788/internal/do/connect", { method: "GET" }),
    ]) {
      const response = await worker.fetch(request, { WDL_INTERNAL_AUTH_TOKEN: TEST_INTERNAL_AUTH_TOKEN });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "owner-ok");
    }
    assert.deepEqual(urls, [
      "http://do-runtime-a:8788/internal/do/invoke",
      "http://do-runtime-a:8788/internal/do/connect",
    ]);
  });
});

test("do owner network rejects invalid owner endpoints before forwarding", async () => {
  const { default: worker } = await loadWorker();
  let called = false;
  await withMockedFetch(async () => {
    called = true;
    return new Response("unexpected");
  }, async () => {
    for (const url of [
      "http://d1-runtime-a:8787/internal/do/invoke",
      "http://do-runtime-a:8787/internal/do/invoke",
      "http://169.254.169.254:8788/internal/do/invoke",
      "http://evil.test:8788/internal/do/invoke",
    ]) {
      const response = await worker.fetch(new Request(url));
      const body = await readJsonResponse(response, 400, url);
      assert.equal(body.error, "invalid_owner_endpoint");
    }
    assert.equal(called, false);
  });
});

test("do owner network rejects non-owner-dispatch paths before forwarding", async () => {
  const { default: worker } = await loadWorker();
  let called = false;
  await withMockedFetch(async () => {
    called = true;
    return new Response("unexpected");
  }, async () => {
    for (const request of [
      new Request("http://do-runtime-a:8788/internal/do/drain", { method: "POST" }),
      new Request("http://do-runtime-a:8788/internal/do/storage/delete-worker", { method: "POST" }),
      new Request("http://do-runtime-a:8788/internal/do/invoke", { method: "GET" }),
      new Request("http://do-runtime-a:8788/internal/do/connect", { method: "POST" }),
      new Request("http://do-runtime-a:8788/_metrics", { method: "GET" }),
    ]) {
      const response = await worker.fetch(request);
      const body = await readJsonResponse(response, 400, request.url);
      assert.equal(body.error, "invalid_owner_path");
    }
    assert.equal(called, false);
  });
});
