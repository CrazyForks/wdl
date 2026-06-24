import { test } from "node:test";
import assert from "node:assert/strict";
import { doAlarmJobIdForStorage } from "../helpers/do-alarm-job-id.js";
import { readRepositoryJson } from "../helpers/load-shared-module.js";

const DO_ALARM_JOB_ID_FIXTURES = readRepositoryJson("tests/fixtures/do-alarm-job-id.json");

test("DO alarm job id follows the cross-language fixture contract", () => {
  for (const { purpose, input, expected } of DO_ALARM_JOB_ID_FIXTURES) {
    assert.equal(typeof purpose, "string");
    assert.equal(
      doAlarmJobIdForStorage(
        input.ns,
        input.worker,
        input.doStorageId,
        input.className,
        input.objectName,
      ),
      expected,
    );
  }
});
