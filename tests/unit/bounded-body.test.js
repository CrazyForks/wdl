import { test } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLargeError, readBoundedBytes, readBoundedText } from "../../shared/bounded-body.js";

test("readBoundedText rejects oversized declared content length", async () => {
  const request = new Request("https://demo.workers.example", {
    method: "POST",
    headers: { "content-length": "5" },
    body: "abcde",
  });

  await assert.rejects(
    () => readBoundedText(request, 4),
    (err) => err instanceof BodyTooLargeError && err.maxBytes === 4
  );
});

test("readBoundedBytes rejects streamed body after crossing the byte cap", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  });
  const request = new Request(
    "https://demo.workers.example",
    /** @type {RequestInit} */ (/** @type {unknown} */ ({ method: "POST", body, duplex: "half" }))
  );

  await assert.rejects(
    () => readBoundedBytes(request, 3),
    (err) => err instanceof BodyTooLargeError && err.maxBytes === 3
  );
});

test("readBoundedBytes returns an empty body when no request body exists", async () => {
  const request = new Request("https://demo.workers.example");
  const bytes = await readBoundedBytes(request, 1);
  assert.equal(bytes.byteLength, 0);
});
