import { test } from "node:test";
import assert from "node:assert/strict";
import {
  R2_OBJECT_MAX_BUFFER_BYTES,
  assertR2BufferSize,
  encodeS3KeyPath,
  encodeS3Query,
  r2PhysicalKey,
  r2PhysicalPrefix,
  r2RangeAndSizeFromHeaders,
  stripR2PhysicalPrefix,
  validateR2BucketName,
} from "../../runtime/r2-utils.js";

test("r2PhysicalPrefix scopes virtual buckets under namespace", () => {
  assert.equal(
    r2PhysicalPrefix({ ns: "demo", bucketName: "uploads" }),
    "r2/demo/uploads/"
  );
  assert.equal(
    r2PhysicalKey({ ns: "demo", bucketName: "uploads" }, "dir/x.txt"),
    "r2/demo/uploads/dir/x.txt"
  );
});

test("normalizeR2ObjectKey rejects URL path traversal segments", () => {
  assert.throws(
    () => r2PhysicalKey({ ns: "demo", bucketName: "uploads" }, "../x.txt"),
    /must not contain \. or \.\. path segments/
  );
  assert.throws(
    () => r2PhysicalKey({ ns: "demo", bucketName: "uploads" }, "a/./x.txt"),
    /must not contain \. or \.\. path segments/
  );
});

test("stripR2PhysicalPrefix rejects backend keys outside the binding prefix", () => {
  const props = { ns: "demo", bucketName: "uploads" };
  assert.equal(stripR2PhysicalPrefix(props, "r2/demo/uploads/a.txt"), "a.txt");
  assert.throws(
    () => stripR2PhysicalPrefix(props, "r2/other/uploads/a.txt"),
    /outside the binding prefix/
  );
});

test("validateR2BucketName enforces prefix-safe virtual bucket names", () => {
  validateR2BucketName("uploads-1");
  assert.throws(() => validateR2BucketName("Uploads"), /bucket_name must match/);
  assert.throws(() => validateR2BucketName("bad/name"), /bucket_name must match/);
});

test("encodeS3KeyPath percent-encodes key segments while preserving slashes", () => {
  assert.equal(
    encodeS3KeyPath("r2/demo/uploads/a b/?.txt"),
    "r2/demo/uploads/a%20b/%3F.txt"
  );
});

test("encodeS3KeyPath encodes key segments without URL path normalization", () => {
  const encoded = encodeS3KeyPath("assets/demo/site/v1/%2e%2e/%2e%2e/victim/app.js");

  assert.equal(
    encoded,
    "assets/demo/site/v1/%252e%252e/%252e%252e/victim/app.js"
  );
  assert.equal(
    new URL(`http://s3.local/bucket/${encoded}`).pathname,
    "/bucket/assets/demo/site/v1/%252e%252e/%252e%252e/victim/app.js"
  );
});

test("encodeS3Query keeps spaces as percent-encoded bytes", () => {
  assert.equal(
    encodeS3Query({
      "list-type": "2",
      prefix: "r2/demo/uploads/folder name",
      delimiter: "/",
      "continuation-token": "",
    }),
    "list-type=2&prefix=r2%2Fdemo%2Fuploads%2Ffolder%20name&delimiter=%2F"
  );
});

test("assertR2BufferSize caps buffered operations at 25MiB", () => {
  assert.equal(R2_OBJECT_MAX_BUFFER_BYTES, 25 * 1024 * 1024);
  assertR2BufferSize(R2_OBJECT_MAX_BUFFER_BYTES, "put");
  assert.throws(
    () => assertR2BufferSize(R2_OBJECT_MAX_BUFFER_BYTES + 1, "put"),
    /exceeds the 25 MiB WDL R2 limit/
  );
});

test("r2RangeAndSizeFromHeaders keeps object size on range responses", () => {
  const headers = new Headers({
    "content-length": "10",
    "content-range": "bytes 5-14/100",
  });
  assert.deepEqual(r2RangeAndSizeFromHeaders(headers), {
    size: 100,
    range: { offset: 5, length: 10 },
  });
});
