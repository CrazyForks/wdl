import { test } from "node:test";
import {
  repositoryFileUrl,
  repositoryModuleDataUrl,
  importRepositoryModule,
} from "../helpers/load-shared-module.js";
import { d1TransportDataUrl } from "../helpers/load-d1-protocol.js";
import { assertJsonResponse } from "../helpers/response-json.js";

const d1QueryWireUrl = repositoryModuleDataUrl("shared/d1-query-wire.js", [
  [/from "shared-d1-params";/, `from ${JSON.stringify(repositoryFileUrl("shared/d1-params.js"))};`],
  [/from "shared-d1-data-field";/, `from ${JSON.stringify(repositoryFileUrl("shared/d1-data-field.js"))};`],
]);
const { jsonError } = await importRepositoryModule("d1-runtime/http.js", [
  [
    /from "shared-d1-transport";/,
    `from ${JSON.stringify(d1TransportDataUrl())};`
  ],
  [/from "shared-d1-query-wire";/, `from ${JSON.stringify(d1QueryWireUrl)};`],
  [/from "shared-respond";/, `from ${JSON.stringify(repositoryFileUrl("shared/respond.js"))};`],
]);

test("D1 runtime jsonError strips top-level reserved detail keys", async () => {
  const response = jsonError(409, "d1_lock_lost", "D1 lock was lost", {
    error: "detail_code",
    message: "detail message",
    reason: "legacy reason",
    databaseId: "main",
    nested: {
      error: "nested_code",
      message: "nested message",
      kept: "yes",
    },
  });

  await assertJsonResponse(response, 409, {
    databaseId: "main",
    nested: {
      error: "nested_code",
      message: "nested message",
      kept: "yes",
    },
    error: "d1_lock_lost",
    message: "D1 lock was lost",
  });
});
