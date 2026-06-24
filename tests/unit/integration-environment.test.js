import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ROOT, resolveWdlCliBin } from "../../scripts/integration-environment.js";
import { makeTempDir, removeTempDir } from "../helpers/temp-dir.js";

test("resolveWdlCliBin uses the supplied PATH environment", () => {
  assert.equal(resolveWdlCliBin({ PATH: "" }), "wdl");
});

test("resolveWdlCliBin resolves executable wdl commands on PATH", () => {
  const dir = makeTempDir("wdl-cli-path-");
  try {
    const bin = path.join(dir, "wdl");
    writeFileSync(bin, "#!/usr/bin/env node\n");
    chmodSync(bin, 0o755);
    assert.equal(resolveWdlCliBin({ PATH: dir }), bin);
  } finally {
    removeTempDir(dir);
  }
});

test("resolveWdlCliBin ignores non-executable wdl commands on PATH", () => {
  const dir = makeTempDir("wdl-cli-path-");
  try {
    const bin = path.join(dir, "wdl");
    writeFileSync(bin, "#!/usr/bin/env node\n");
    chmodSync(bin, 0o644);
    assert.equal(resolveWdlCliBin({ PATH: dir }), "wdl");
  } finally {
    removeTempDir(dir);
  }
});

test("resolveWdlCliBin resolves repository-relative overrides", () => {
  assert.equal(
    resolveWdlCliBin({ WDL_CLI_BIN: "local-cli/bin/wdl.js" }),
    path.join(ROOT, "local-cli/bin/wdl.js")
  );
});

test("resolveWdlCliBin preserves absolute overrides", () => {
  const absoluteBin = path.join(ROOT, "local-cli/bin/wdl.js");
  assert.equal(resolveWdlCliBin({ WDL_CLI_BIN: absoluteBin }), absoluteBin);
});

test("ROOT points to the repository root directory", () => {
  assert.equal(existsSync(path.join(ROOT, "package.json")), true);
});
