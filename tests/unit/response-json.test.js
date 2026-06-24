import { test } from "node:test";
import assert from "node:assert/strict";
import { assertJsonResponse, readJsonResponse } from "../helpers/response-json.js";

test("readJsonResponse checks status and returns parsed JSON", async () => {
  const response = Response.json({ ok: true }, { status: 201 });

  assert.deepEqual(await readJsonResponse(response, 201, "created"), { ok: true });
});

test("readJsonResponse rejects when status does not match expected value", async () => {
  const response = Response.json({ ok: true }, { status: 201 });

  await assert.rejects(
    () => readJsonResponse(response, 200, "created response"),
    /created response: expected status 200/
  );
});

test("readJsonResponse labels invalid JSON bodies", async () => {
  const response = new Response("{", { status: 200 });

  await assert.rejects(
    () => readJsonResponse(response, 200, "created response"),
    /expected created response to contain valid JSON/
  );
});

test("assertJsonResponse includes cloned body text in status diagnostics", async () => {
  const response = Response.json({ error: "bad" }, { status: 400 });

  await assert.rejects(
    () => assertJsonResponse(response, 200, { ok: true }, "created"),
    /created: expected status 200; \{"error":"bad"\}/
  );
  assert.deepEqual(await response.json(), { error: "bad" });
});
