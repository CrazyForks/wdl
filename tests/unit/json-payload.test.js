import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStoredJson } from "../helpers/json-payload.js";

test("parseStoredJson parses stored JSON strings with a label", () => {
  assert.deepEqual(parseStoredJson('{"ok":true}', "owner record"), { ok: true });
});

test("parseStoredJson rejects missing stored values before JSON parsing", () => {
  assert.throws(
    () => parseStoredJson(undefined, "owner record"),
    /expected owner record to be a JSON string/
  );
});
