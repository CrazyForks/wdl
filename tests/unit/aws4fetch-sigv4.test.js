import assert from "node:assert/strict";
import { test } from "node:test";

import { AwsClient } from "../../shared/vendor/aws4fetch.js";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const SESSION_TOKEN = "session-token-example";
const FIXED_DATETIME = "20260616T010203Z";
const S3_ENDPOINT = "https://s3.us-east-1.amazonaws.com";

// Fixed vectors generated once from an independent SigV4 implementation and kept
// inline so vendored signer changes cannot silently redefine expected output.
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
    expectedAuthorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260616/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-color, Signature=5e3987228d5dc7205ef1738b1d535f56fa406a7669abd2b38a4ffee235b171bc",
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
    expectedAuthorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260616/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date, Signature=61b0447a5da60ca033a42e22dccdeb60830f05cd921782952a4a556de23845c0",
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
];

test("aws4fetch S3 signing matches fixed SigV4 golden vectors", async () => {
  for (const fixture of FIXTURES) {
    const client = new AwsClient({
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      sessionToken: fixture.sessionToken,
      service: "s3",
      region: "us-east-1",
      cache: new Map(),
      retries: 0,
      initRetryMs: 0,
    });
    const signed = await client.sign(fixture.url, {
      ...fixture.init,
      aws: { datetime: FIXED_DATETIME },
    });
    assert.equal(signed.url, fixture.expectedUrl, fixture.name);
    assert.equal(signed.headers.get("authorization"), fixture.expectedAuthorization, fixture.name);
    assert.equal(signed.headers.get("x-amz-date"), FIXED_DATETIME, fixture.name);
    assert.equal(signed.headers.get("x-amz-content-sha256"), fixture.expectedContentSha256, fixture.name);
    assert.equal(signed.headers.get("x-amz-security-token"), fixture.expectedSecurityToken ?? null, fixture.name);
  }
});
