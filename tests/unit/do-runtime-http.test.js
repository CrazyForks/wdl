import { test } from "node:test";
import { importRepositoryModule, repositoryFileUrl } from "../helpers/load-shared-module.js";
import { assertJsonResponse } from "../helpers/response-json.js";

const { jsonError } = await importRepositoryModule("do-runtime/http.js", [
  [/from "shared-respond";/, `from ${JSON.stringify(repositoryFileUrl("shared/respond.js"))};`],
]);

test("DO runtime jsonError preserves top-level error and message over detail keys", async () => {
  const response = jsonError(503, "stable_code", "Stable message", {
    error: "detail_code",
    message: "detail message",
    reason: "legacy reason",
    request_id: "req-1",
    nested: {
      error: "nested_code",
      message: "nested message",
      kept: true,
    },
  });

  await assertJsonResponse(response, 503, {
    request_id: "req-1",
    nested: {
      error: "nested_code",
      message: "nested message",
      kept: true,
    },
    error: "stable_code",
    message: "Stable message",
  });
});
