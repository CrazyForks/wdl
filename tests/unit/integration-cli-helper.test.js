import { test } from "node:test";
import assert from "node:assert/strict";

import { integrationChildEnv, parseIntegrationCommandForTest } from "../integration/helpers/cli.js";

const NODE = JSON.stringify(process.execPath);

test("integration sh parses env assignments and quoted arguments without shell execution", () => {
  const parsed = parseIntegrationCommandForTest(
    `TEST_SH_VALUE=inline ${NODE} -e 'process.stdout.write(process.env.TEST_SH_VALUE + ":" + process.argv[1])' 'hello world'`
  );
  assert.deepEqual(parsed.env, { TEST_SH_VALUE: "inline" });
  assert.deepEqual(parsed.argv, [
    process.execPath,
    "-e",
    "process.stdout.write(process.env.TEST_SH_VALUE + \":\" + process.argv[1])",
    "hello world",
  ]);
});

test("integration sh does not treat quoted assignment-looking tokens as env", () => {
  const parsed = parseIntegrationCommandForTest(
    `'TEST_SH_VALUE=inline' ${NODE} -e 'process.stdout.write(process.env.TEST_SH_VALUE || "")'`
  );
  assert.deepEqual(parsed.env, {});
  assert.equal(parsed.argv[0], "TEST_SH_VALUE=inline");
  assert.equal(parsed.quoted[0], true);
});

test("integration sh does not leak node:test worker env into child processes", () => {
  const env = integrationChildEnv(
    { NODE_TEST_CONTEXT: "ctx", NODE_TEST_WORKER_ID: "worker", TEST_VALUE: "base" },
    { TEST_VALUE: "override" }
  );
  assert.equal("NODE_TEST_CONTEXT" in env, false);
  assert.equal("NODE_TEST_WORKER_ID" in env, false);
  assert.equal(env.TEST_VALUE, "override");
});

test("integration sh supports the explicit missing fallback used by Redis probes", () => {
  const parsed = parseIntegrationCommandForTest(`${NODE} -e 'process.exit(3)' 2>/dev/null || echo missing`);
  assert.deepEqual(parsed.argv, [process.execPath, "-e", "process.exit(3)"]);
  assert.equal(parsed.fallbackOutput, "missing\n");
});

test("integration sh rejects unsupported shell operators after parsing", () => {
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("first")' && ${NODE} -e 'process.stdout.write("second")'`),
    /unsupported integration shell syntax: &&/
  );
});

test("integration sh rejects unsupported ';' operator after parsing", () => {
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("first")' ; ${NODE} -e 'process.stdout.write("second")'`),
    /unsupported integration shell syntax: ;/
  );
});

test("integration sh rejects unsupported '|' operator after parsing", () => {
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("first")' | ${NODE} -e 'process.stdout.write("second")'`),
    /unsupported integration shell syntax: \|/
  );
});

test("integration sh rejects unsupported shell redirection after parsing", () => {
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("hidden")' >/dev/null`),
    /unsupported integration shell redirection: >\/dev\/null/
  );
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("hidden")' >`),
    /unsupported integration shell redirection: >/
  );
});

test("integration sh rejects other unsupported shell redirection operators, including standalone stderr redirection", () => {
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("hidden")' >>/dev/null`),
    /unsupported integration shell redirection: >>\/dev\/null/
  );
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("hidden")' <<EOF`),
    /unsupported integration shell redirection: <<EOF/
  );
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("hidden")' </dev/null`),
    /unsupported integration shell redirection: <\/dev\/null/
  );
  // `2>/dev/null` is only modeled inside the exact `2>/dev/null || echo missing`
  // fallback shape above; standalone stderr redirection remains unsupported.
  assert.throws(
    () => parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write("hidden")' 2>/dev/null`),
    /unsupported integration shell redirection: 2>\/dev\/null/
  );
});

test("integration sh keeps quoted operator-looking arguments as argv", () => {
  const parsed = parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write(process.argv[1])' 'left && right'`);
  assert.equal(parsed.argv.at(-1), "left && right");
  assert.equal(parsed.quoted.at(-1), true);
});

test("integration sh preserves empty quoted arguments", () => {
  const parsed = parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' x '' y`);
  assert.deepEqual(parsed.argv.slice(-3), ["x", "", "y"]);
});

test("integration sh allows quoted operator-looking scalar values", () => {
  const parsed = parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write(process.argv.slice(1).join(","))' '<html>' '|' '2>x'`);
  assert.deepEqual(parsed.argv.slice(-3), ["<html>", "|", "2>x"]);
  assert.deepEqual(parsed.quoted.slice(-3), [true, true, true]);
});

test("integration sh preserves literal backslashes in double-quoted arguments", () => {
  const parsed = parseIntegrationCommandForTest(`${NODE} -e 'process.stdout.write(process.argv[1])' "a\\nb"`);
  assert.equal(parsed.argv.at(-1), String.raw`a\nb`);
});
