import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedOwnerForwarderUrl } from "../helpers/load-owner-harness.js";

const { MAX_OWNER_FORWARD_HOPS, forwardOutcome, parseForwardHopCount } =
  await import(sharedOwnerForwarderUrl());

test("owner forward hop count clamps to a non-negative integer", () => {
  assert.equal(parseForwardHopCount("5"), 5);
  assert.equal(parseForwardHopCount("1.9"), 1);
  assert.equal(parseForwardHopCount("abc"), 0);
  assert.equal(parseForwardHopCount("-1"), 0);
  assert.equal(parseForwardHopCount(null), 0);
  assert.equal(parseForwardHopCount(undefined), 0);
  assert.equal(parseForwardHopCount(""), 0);
  assert.equal(parseForwardHopCount(Infinity), 0);
  assert.equal(MAX_OWNER_FORWARD_HOPS, 2);
});

test("owner forward outcome splits ok from error at the 4xx boundary", () => {
  assert.equal(forwardOutcome({ status: 200 }), "ok");
  assert.equal(forwardOutcome({ status: 399 }), "ok");
  assert.equal(forwardOutcome({ status: 400 }), "error");
  assert.equal(forwardOutcome({ status: 503 }), "error");
  assert.equal(forwardOutcome(null), "error");
  assert.equal(forwardOutcome(undefined), "error");
  assert.equal(forwardOutcome({ status: "not-a-status" }), "error");
});
