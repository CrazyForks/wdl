import { test } from "node:test";
import assert from "node:assert/strict";
import { importRepositoryModule, moduleDataUrl } from "../helpers/load-shared-module.js";
import { controlSharedStubUrl } from "../helpers/control-shared-stub.js";
import { assertJsonResponse } from "../helpers/response-json.js";

const controlR2Url = moduleDataUrl(`
export const calls = [];
export async function listR2Buckets(args) {
  calls.push(["list-buckets", args]);
  return { buckets: [], cursor: null, truncated: false };
}
export async function listR2Objects(args) {
  calls.push(["list-objects", args]);
  return { objects: [], prefixes: [], cursor: null, truncated: false };
}
export async function headR2Object(args) {
  calls.push(["head-object", args]);
  return new Response(null, { headers: { etag: '"abc"', "content-type": "text/plain" } });
}
export async function getR2Object(args) {
  calls.push(["get-object", args]);
  return new Response("hello", { headers: { etag: '"abc"', "content-type": "text/plain" } });
}
export async function deleteR2Object(args) {
  calls.push(["delete-object", args]);
  return { status: "deleted" };
}
`);

const controlSharedUrl = controlSharedStubUrl(`
export const state = {
  r2: {},
  log() {},
};
`);

/**
 * @typedef {{ handle(args: { method: string, url: URL, ns: string, subPath: string[], requestId: string }): Promise<Response> }} R2HandlerModule
 * @typedef {{ calls: Array<[string, unknown]> }} ControlR2Stub
 */

const [handlerModule, controlR2Module] = await Promise.all([
  importRepositoryModule("control/handlers/r2.js", [
    [/from "control-r2";/, `from ${JSON.stringify(controlR2Url)};`],
    [/from "control-shared";/, `from ${JSON.stringify(controlSharedUrl)};`],
  ]),
  import(controlR2Url),
]);
const { handle } = /** @type {R2HandlerModule} */ (handlerModule);
const controlR2 = /** @type {ControlR2Stub} */ (controlR2Module);

function resetCalls() {
  controlR2.calls.length = 0;
}

test("R2 collection objects path only supports GET list", async () => {
  resetCalls();
  const response = await handle({
    method: "GET",
    url: new URL("https://control.test/ns/demo/r2/buckets/uploads/objects"),
    ns: "demo",
    subPath: ["buckets", "uploads", "objects"],
    requestId: "rid",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(controlR2.calls.map((call) => call[0]), ["list-objects"]);
});

test("R2 collection objects path rejects object methods without calling admin object client", async () => {
  for (const method of ["HEAD", "DELETE", "POST", "PUT", "PATCH"]) {
    resetCalls();
    const response = await handle({
      method,
      url: new URL("https://control.test/ns/demo/r2/buckets/uploads/objects"),
      ns: "demo",
      subPath: ["buckets", "uploads", "objects"],
      requestId: "rid",
    });

    await assertJsonResponse(response, 405, {
      error: "method_not_allowed",
      message: "Method not allowed",
    }, method);
    assert.deepEqual(controlR2.calls, [], method);
  }
});

test("R2 buckets collection path supports GET list", async () => {
  resetCalls();
  const response = await handle({
    method: "GET",
    url: new URL("https://control.test/ns/demo/r2/buckets"),
    ns: "demo",
    subPath: ["buckets"],
    requestId: "rid",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(controlR2.calls.map((call) => call[0]), ["list-buckets"]);
});

test("R2 individual bucket path is not an object route", async () => {
  resetCalls();
  const response = await handle({
    method: "GET",
    url: new URL("https://control.test/ns/demo/r2/buckets/uploads"),
    ns: "demo",
    subPath: ["buckets", "uploads"],
    requestId: "rid",
  });

  await assertJsonResponse(response, 404, {
    error: "not_found",
    message: "Not found",
  });
  assert.deepEqual(controlR2.calls, []);
});

test("R2 individual object path routes HEAD/GET/DELETE to object client", async () => {
  const scenarios = [
    { method: "HEAD", expectedCall: "head-object" },
    { method: "GET", expectedCall: "get-object" },
    { method: "DELETE", expectedCall: "delete-object" },
  ];
  for (const { method, expectedCall } of scenarios) {
    resetCalls();
    const response = await handle({
      method,
      url: new URL("https://control.test/ns/demo/r2/buckets/uploads/objects/file.txt"),
      ns: "demo",
      subPath: ["buckets", "uploads", "objects", "file.txt"],
      requestId: "rid",
    });

    assert.equal(response.status, 200, method);
    assert.deepEqual(controlR2.calls.map((call) => call[0]), [expectedCall], method);
    assert.equal(
      /** @type {{ key?: string }} */ (controlR2.calls[0][1]).key,
      "file.txt",
      method,
    );
  }
});
