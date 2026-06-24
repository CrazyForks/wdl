import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir } from "../helpers/temp-dir.js";

test("withTempDir removes the temporary directory after success", async () => {
  let seenDir = "";
  await withTempDir("wdl-temp-dir-", async (dir) => {
    seenDir = dir;
    writeFileSync(path.join(dir, "marker.txt"), "ok");
    assert.equal(existsSync(dir), true);
  });
  assert.equal(existsSync(seenDir), false);
});

test("withTempDir removes the temporary directory after failure", async () => {
  let seenDir = "";
  await assert.rejects(
    withTempDir("wdl-temp-dir-", async (dir) => {
      seenDir = dir;
      writeFileSync(path.join(dir, "marker.txt"), "ok");
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(existsSync(seenDir), false);
});
