import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installConsoleMethodCapture,
  installStreamWriteCapture,
  withCapturedConsole,
} from "../helpers/output-capture.js";

test("withCapturedConsole captures log and error output then restores methods", () => {
  const originalLog = console.log;
  const originalError = console.error;
  withCapturedConsole(({ stdout, stderr }) => {
    console.log("hello", "world");
    console.error("bad", 42);
    assert.deepEqual(stdout, ["hello world"]);
    assert.deepEqual(stderr, ["bad 42"]);
  });
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
});

test("installConsoleMethodCapture supports custom formatting", () => {
  /** @type {Array<{ message: string }>} */
  const warnings = [];
  const restore = installConsoleMethodCapture("warn", warnings, (message) => ({ message: String(message) }));
  try {
    console.warn("careful");
  } finally {
    restore();
  }
  assert.deepEqual(warnings, [{ message: "careful" }]);
});

test("installStreamWriteCapture captures chunks and invokes write callbacks", () => {
  /** @type {{ write: (...args: any[]) => boolean }} */
  const stream = {
    write() {
      throw new Error("expected mock write");
    },
  };
  /** @type {string[]} */
  const writes = [];
  let callbackCalled = false;
  const restore = installStreamWriteCapture(stream, writes);
  try {
    assert.equal(stream.write("warning", "utf8", () => {
      callbackCalled = true;
    }), true);
  } finally {
    restore();
  }
  assert.deepEqual(writes, ["warning"]);
  assert.equal(callbackCalled, true);
  assert.throws(() => stream.write(), /expected mock write/);
});
