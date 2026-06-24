import { test } from "node:test";
import assert from "node:assert/strict";

import { withRecordingFetch } from "../helpers/mock-fetch.js";
import { jsonRequest, parseJsonObjectRequestBody } from "../helpers/request-body.js";

test("withRecordingFetch records URL, init, parsed body, and returns configured response", async () => {
  /** @type {Array<{ url: string, init: RequestInit, body: Record<string, unknown> }>} */
  const calls = [];

  await withRecordingFetch(calls, async () => {
    const response = await fetch("https://unit.test/record", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(response.status, 202);
  }, {
    response: new Response(null, { status: 202 }),
    capture: (call, _url, init) => ({
      ...call,
      body: parseJsonObjectRequestBody(init, "recording fetch request body"),
    }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://unit.test/record");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, { ok: true });
});

test("withRecordingFetch clones static Response bodies for repeated calls", async () => {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];

  await withRecordingFetch(calls, async () => {
    const first = await fetch("https://unit.test/first");
    const second = await fetch("https://unit.test/second");

    assert.deepEqual(await first.json(), { ok: true });
    assert.deepEqual(await second.json(), { ok: true });
  }, {
    response: Response.json({ ok: true }),
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://unit.test/first",
    "https://unit.test/second",
  ]);
});

test("withRecordingFetch passes the captured call to response factories", async () => {
  /** @type {Array<{ url: string, parsedBody: Record<string, unknown> }>} */
  const calls = [];

  await withRecordingFetch(calls, async () => {
    const response = await fetch("https://unit.test/factory", {
      method: "POST",
      body: JSON.stringify({ value: 42 }),
    });
    assert.deepEqual(await response.json(), { echoed: { value: 42 } });
  }, {
    capture: (call, _url, init) => ({
      url: call.url,
      parsedBody: parseJsonObjectRequestBody(init, "recording fetch request body"),
    }),
    response: (_url, _init, call) => Response.json({ echoed: call.parsedBody }),
  });

  assert.deepEqual(calls, [
    { url: "https://unit.test/factory", parsedBody: { value: 42 } },
  ]);
});

test("jsonRequest builds a Request with a JSON string body", async () => {
  const request = jsonRequest("https://unit.test/body", { ok: true }, { method: "POST" });

  assert.equal(request.method, "POST");
  assert.deepEqual(await request.json(), { ok: true });
});
