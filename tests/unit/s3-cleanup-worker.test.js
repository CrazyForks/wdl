import assert from "node:assert/strict";
import { test } from "node:test";

import { deletePrefix } from "../../system-workers/s3-cleanup/src/index.js";
import { withMockedProperty } from "../helpers/mock-global.js";

/** @param {Response[]} responses */
function s3Mock(responses) {
  /** @type {Array<{ url: string, init?: RequestInit }>} */
  const calls = [];
  return {
    calls,
    s3: /** @type {any} */ ({
      endpoint: "http://s3.test",
      bucket: "wdl",
      aws: {
        /** @param {RequestInfo | URL} url @param {RequestInit} [init] */
        async fetch(url, init) {
          calls.push({ url: String(url), init });
          const response = responses.shift();
          if (!response) throw new Error("unexpected S3 request");
          return response;
        },
      },
    }),
  };
}

test("deletePrefix follows truncated empty pages before marking cleanup done", async () => {
  const { s3, calls } = s3Mock([
    new Response([
      "<ListBucketResult>",
      "<IsTruncated>true</IsTruncated>",
      "<NextContinuationToken>cursor&amp;1</NextContinuationToken>",
      "</ListBucketResult>",
    ].join("")),
    new Response([
      "<ListBucketResult>",
      "<s3:IsTruncated>false</s3:IsTruncated>",
      "<s3:Contents><s3:Key>assets/demo/a&amp;b.txt</s3:Key></s3:Contents>",
      "</ListBucketResult>",
    ].join("")),
    new Response("<DeleteResult><Deleted><Key>assets/demo/a&amp;b.txt</Key></Deleted></DeleteResult>"),
  ]);

  const result = await deletePrefix(s3, "assets/demo/");

  assert.deepEqual(result, { deletedCount: 1 });
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1].url).searchParams.get("continuation-token"), "cursor&1");
  assert.equal(calls[2].init?.method, "POST");
});

test("deletePrefix retries transient DeleteObjects responses", async () => {
  const { s3, calls } = s3Mock([
    new Response([
      "<ListBucketResult>",
      "<IsTruncated>false</IsTruncated>",
      "<Contents><Key>assets/demo/retry.txt</Key></Contents>",
      "</ListBucketResult>",
    ].join("")),
    new Response("slow down", { status: 500 }),
    new Response("<DeleteResult><Deleted><Key>assets/demo/retry.txt</Key></Deleted></DeleteResult>"),
  ]);

  const result = await deletePrefix(s3, "assets/demo/");

  assert.deepEqual(result, { deletedCount: 1 });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init?.method, "POST");
  assert.equal(calls[2].init?.method, "POST");
  assert.equal(calls[1].url, calls[2].url);
});

test("deletePrefix returns the last transient DeleteObjects response after retry exhaustion", async () => {
  const { s3, calls } = s3Mock([
    new Response([
      "<ListBucketResult>",
      "<IsTruncated>false</IsTruncated>",
      "<Contents><Key>assets/demo/retry.txt</Key></Contents>",
      "</ListBucketResult>",
    ].join("")),
    ...Array.from({ length: 11 }, () => new Response("still slow", { status: 429 })),
  ]);

  await withMockedProperty(Math, "random", () => 0, async () => {
    await assert.rejects(
      () => deletePrefix(s3, "assets/demo/"),
      /s3 delete assets\/demo\/ → 429: still slow/
    );
  });

  assert.equal(calls.length, 12);
  assert.ok(calls.slice(1).every((call) => call.init?.method === "POST"));
});

test("deletePrefix retries truncated list responses without continuation tokens", async () => {
  const { s3 } = s3Mock([
    new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"),
  ]);

  await assert.rejects(
    () => deletePrefix(s3, "assets/demo/"),
    /truncated without NextContinuationToken/
  );
});
