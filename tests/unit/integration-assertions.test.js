import { test } from "node:test";
import assert from "node:assert/strict";

import { assertNotStatus, assertStatus, assertStatusIn } from "../integration/helpers/assertions.js";

test("integration assertStatus includes structured object bodies in diagnostics", () => {
  assert.throws(
    () => assertStatus({ status: 500, body: { error: "bad", detail: 42 } }, 200, "d1 query"),
    /d1 query: expected status 200; \{"error":"bad","detail":42\}/
  );
});

test("integration assertStatus keeps string bodies unchanged in diagnostics", () => {
  assert.throws(
    () => assertStatus({ status: 500, body: "plain failure" }, 200, "http call"),
    /http call: expected status 200; plain failure/
  );
});

test("integration assertStatus does not use native json functions as diagnostics", () => {
  assert.throws(
    () => assertStatus({ status: 500, json() { return { error: "bad" }; } }, 200, "native response"),
    (error) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.equal(error.message.startsWith("native response: expected status 200"), true);
      assert.equal(String(error).includes("function"), false);
      return true;
    }
  );
});

test("integration assertStatus accepts an explicit diagnostic value", () => {
  assert.throws(
    () => assertStatus({ status: 500, json() { return { error: "ignored" }; } }, 200, "native response", { error: "bad" }),
    /native response: expected status 200; \{"error":"bad"\}/
  );
});

test("integration assertStatusIn accepts any expected status", () => {
  assert.doesNotThrow(() => assertStatusIn({ status: 409, json: { error: "exists" } }, [201, 409], "create"));
  assert.throws(
    () => assertStatusIn({ status: 500, json: { error: "bad" } }, [201, 409], "create"),
    /create: expected status in 201, 409; \{"error":"bad"\}/
  );
});

test("integration assertNotStatus reports structured diagnostics", () => {
  assert.doesNotThrow(() => assertNotStatus({ status: 409, body: { error: "blocked" } }, 200, "delete"));
  assert.throws(
    () => assertNotStatus({ status: 200, body: { error: "unexpected" } }, 200, "delete"),
    /delete: expected status not to be 200; \{"error":"unexpected"\}/
  );
});
