import assert from "node:assert/strict";
import { test } from "node:test";

import { SigV4Client } from "../../shared/vendor/aws-sigv4.js";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const SESSION_TOKEN = "session-token-example";
const FIXED_DATETIME = "20260616T010203Z";
const S3_ENDPOINT = "https://s3.us-east-1.amazonaws.com";

// Fixed vectors are kept inline so vendored signer changes cannot silently
// redefine expected output.
const FIXTURES = [
  {
    name: "put object signs S3 path, query, metadata, and unsigned payload",
    url: `${S3_ENDPOINT}/wdl-r2/r2/demo/uploads/a%26b.txt?partNumber=1&uploadId=upload-id`,
    init: {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "x-amz-meta-color": "blue",
      },
      body: "hello",
    },
    expectedAuthorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260616/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-color, Signature=1c6bb19462b7ea6eeb31b1e069fcba0cdb36d6c95efa6e39744fd102a2630f50",
    expectedContentSha256: "UNSIGNED-PAYLOAD",
    expectedUrl: `${S3_ENDPOINT}/wdl-r2/r2/demo/uploads/a%26b.txt?partNumber=1&uploadId=upload-id`,
  },
  {
    name: "delete objects signs explicit payload hash and checksum header",
    url: `${S3_ENDPOINT}/wdl-r2?delete`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/xml",
        "x-amz-checksum-sha256": "checksum-base64",
        "x-amz-content-sha256": "e2000f6b1fc1db795626ddaf9c13324157e9f56cb7820b40d7c3253a08ee5b91",
      },
      body: "<Delete/>",
    },
    expectedAuthorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260616/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date, Signature=93a1cf22c38a19def0aeb042bc4fbcf9e486240f71e91dbbb0dd75924e4f73a5",
    expectedContentSha256: "e2000f6b1fc1db795626ddaf9c13324157e9f56cb7820b40d7c3253a08ee5b91",
    expectedUrl: `${S3_ENDPOINT}/wdl-r2?delete`,
  },
  {
    name: "session token participates in signed headers",
    url: `${S3_ENDPOINT}/wdl-r2/r2/demo/uploads/session.txt`,
    sessionToken: SESSION_TOKEN,
    init: {
      method: "HEAD",
    },
    expectedAuthorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260616/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=f54699d16ac946691025f331377c59814b85e1078bc70ea66925457e2549d0a7",
    expectedContentSha256: "UNSIGNED-PAYLOAD",
    expectedSecurityToken: SESSION_TOKEN,
    expectedUrl: `${S3_ENDPOINT}/wdl-r2/r2/demo/uploads/session.txt`,
  },
  {
    name: "range header participates in signed headers",
    url: `${S3_ENDPOINT}/wdl-r2/r2/demo/uploads/range.txt`,
    init: {
      method: "GET",
      headers: {
        range: "bytes=5-14",
      },
    },
    expectedAuthorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260616/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=4314b16522bc84770fe27958aeb288cd651cd367744a4c3f842ff0aa3172e43d",
    expectedContentSha256: "UNSIGNED-PAYLOAD",
    expectedUrl: `${S3_ENDPOINT}/wdl-r2/r2/demo/uploads/range.txt`,
  },
];

test("aws-sigv4 S3 signing matches fixed SigV4 golden vectors", async () => {
  for (const fixture of FIXTURES) {
    const client = new SigV4Client({
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      sessionToken: fixture.sessionToken,
      service: "s3",
      region: "us-east-1",
      cache: new Map(),
      retries: 0,
    });
    const signed = await client.sign(fixture.url, {
      ...fixture.init,
      signing: { signingDate: FIXED_DATETIME },
    });
    assert.equal(signed.url, fixture.expectedUrl, fixture.name);
    assert.equal(signed.headers.get("authorization"), fixture.expectedAuthorization, fixture.name);
    assert.equal(signed.headers.get("x-amz-date"), FIXED_DATETIME, fixture.name);
    assert.equal(signed.headers.get("x-amz-content-sha256"), fixture.expectedContentSha256, fixture.name);
    assert.equal(signed.headers.get("x-amz-security-token"), fixture.expectedSecurityToken ?? null, fixture.name);
  }
});

/** @param {typeof globalThis.fetch} fetch */
function testClient(fetch) {
  return new SigV4Client({
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    service: "s3",
    region: "us-east-1",
    cache: new Map(),
    retries: 3,
    initialRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    fetch,
  });
}

test("aws-sigv4 fetch retries idempotent transient responses", async () => {
  for (const { method, body } of [
    { method: "GET", body: undefined },
    { method: "HEAD", body: undefined },
    { method: "PUT", body: "hello" },
  ]) {
    /** @type {Array<{ url: string, method: string, authorization: string | null, body: string }>} */
    const calls = [];
    const client = testClient(async (input) => {
      const request = /** @type {Request} */ (input);
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.clone().text(),
      });
      return new Response(null, { status: calls.length === 1 ? 500 : 200 });
    });

    const response = await client.fetch(`${S3_ENDPOINT}/wdl-r2/retry.txt`, {
      method,
      body,
      signing: { signingDate: FIXED_DATETIME },
    });

    assert.equal(response.status, 200, method);
    assert.equal(calls.length, 2, method);
    assert.equal(calls[0].url, calls[1].url, method);
    assert.equal(calls[0].method, method, method);
    assert.equal(calls[1].method, method, method);
    assert.equal(calls[0].body, calls[1].body, method);
    assert.equal(calls[0].body, body ?? "", method);
    assert.ok(calls[0].authorization?.startsWith("AWS4-HMAC-SHA256 "), method);
    assert.equal(calls[0].authorization, calls[1].authorization, method);
  }
});

test("aws-sigv4 fetch does not retry POST transient responses", async () => {
  /** @type {Request[]} */
  const calls = [];
  const client = testClient(async (input) => {
    const request = /** @type {Request} */ (input);
    calls.push(request);
    return new Response(null, { status: 500 });
  });

  const response = await client.fetch(`${S3_ENDPOINT}/wdl-r2?delete`, {
    method: "POST",
    body: "<Delete/>",
    signing: { signingDate: FIXED_DATETIME },
  });

  assert.equal(response.status, 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
});

test("aws-sigv4 fetch with retries disabled makes one attempt", async () => {
  /** @type {Request[]} */
  const calls = [];
  const client = new SigV4Client({
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    service: "s3",
    region: "us-east-1",
    cache: new Map(),
    retries: 0,
    fetch: async (/** @type {RequestInfo | URL} */ input) => {
      const request = /** @type {Request} */ (input);
      calls.push(request);
      return new Response(null, { status: 500 });
    },
  });

  const response = await client.fetch(`${S3_ENDPOINT}/wdl-r2/retry-disabled.txt`, {
    method: "GET",
    signing: { signingDate: FIXED_DATETIME },
  });

  assert.equal(response.status, 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});
