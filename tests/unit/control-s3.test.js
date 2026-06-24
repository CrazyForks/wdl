import { test } from "node:test";
import assert from "node:assert/strict";

import {
  importRepositoryModule,
  repositoryFileUrl,
} from "../helpers/load-shared-module.js";

const { makeS3Client } = await importRepositoryModule("control/s3.js", [
  [/import \{ AwsClient \} from "aws4fetch";/, "class AwsClient { constructor(options) { this.options = options; } }"],
  [/from "runtime-r2-utils";/g, `from ${JSON.stringify(repositoryFileUrl("runtime/r2-utils.js"))};`],
]);

test("makeS3Client requires credentials outside explicit local/mock endpoints", () => {
  assert.throws(
    () => makeS3Client({
      S3_ENDPOINT: "https://assets.example",
      S3_BUCKET: "assets",
    }),
    /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required/
  );
});

test("makeS3Client permits test credentials only for local/mock endpoints", () => {
  assert.ok(makeS3Client({
    S3_ENDPOINT: "http://s3mock:9090",
    S3_BUCKET: "assets",
  }));
  assert.ok(makeS3Client({
    S3_ENDPOINT: "https://assets.example",
    S3_BUCKET: "assets",
    S3_ALLOW_TEST_CREDENTIALS: "1",
  }));
});
