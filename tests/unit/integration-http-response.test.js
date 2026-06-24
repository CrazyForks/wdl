import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDockerJson } from "../integration/helpers/internal-http.js";
import {
  assertIntegrationJson,
  bufferedResponseBody,
  readIntegrationJson,
  responseJson,
  responseJsonOrNull,
  withResponseJsonAccessors,
} from "../integration/helpers/http-response.js";

test("buffered response body exposes lazy text and reusable bytes", async () => {
  const body = bufferedResponseBody(Buffer.from("{\"ok\":true}"));

  assert.equal(await body.text(), "{\"ok\":true}");
  assert.deepEqual([...new Uint8Array(await body.arrayBuffer())], [...Buffer.from("{\"ok\":true}")]);
  assert.deepEqual(await responseJson(body), { ok: true });
});

test("response JSON helpers share a single async text() read", async () => {
  let textCalls = 0;
  const response = {
    async text() {
      textCalls += 1;
      return "{\"ok\":true}";
    },
  };

  assert.deepEqual(await responseJson(response), { ok: true });
  assert.deepEqual(await responseJsonOrNull(response), { ok: true });
  assert.equal(textCalls, 1);
});

test("integration JSON helper asserts status and parses native fetch responses", async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

  assert.deepEqual(await readIntegrationJson(response, 201, "native response"), { ok: true });
});

test("integration JSON helper asserts collected response bodies", async () => {
  const response = { status: 200, body: JSON.stringify({ ok: true }) };

  assert.deepEqual(
    await assertIntegrationJson(response, 200, { ok: true }, "collected response"),
    { ok: true }
  );
});

test("withResponseJsonAccessors only accepts collected string-body responses", async () => {
  const response = { status: 200, body: JSON.stringify({ ok: true }) };
  const withAccessors = withResponseJsonAccessors(response);

  assert.equal(withAccessors, response);
  assert.deepEqual(withAccessors.json(), { ok: true });
  assert.deepEqual(withAccessors.jsonOrNull(), { ok: true });
  assert.throws(
    () => withResponseJsonAccessors(new Response(JSON.stringify({ ok: true }))),
    /expects a collected response with string body/
  );
});

test("integration JSON helper includes body text on status failure without rereading", async () => {
  let textCalls = 0;
  const response = {
    status: 500,
    async text() {
      textCalls += 1;
      return "{\"error\":\"boom\"}";
    },
  };

  await assert.rejects(
    readIntegrationJson(response, 200, "failing response"),
    /failing response: expected status 200; \{"error":"boom"\}/
  );
  assert.equal(textCalls, 1);
});

test("internal HTTP docker response stdout must be a JSON object", () => {
  assert.throws(
    () => parseDockerJson("null"),
    /invalid internal HTTP response: null/
  );
});
