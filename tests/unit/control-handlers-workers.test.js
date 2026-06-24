import { test } from "node:test";
import assert from "node:assert/strict";
import { controlSharedStubUrl } from "../helpers/control-shared-stub.js";
import {
  applyModuleReplacements,
  moduleDataUrl,
  readRepositoryFile,
} from "../helpers/load-shared-module.js";
import { assertJsonResponse } from "../helpers/response-json.js";

const controlSharedUrl = controlSharedStubUrl(`
export const state = {
  redis: {
    async session(fn) {
      globalThis.__workersHandlerState.sessions += 1;
      return await fn(globalThis.__workersHandlerState.session);
    },
  },
  log(level, event, fields) {
    globalThis.__workersHandlerState.logs.push({ level, event, fields });
  },
};
`);

const controlLibUrl = moduleDataUrl(`
export function routesKey(ns) { return "routes:" + ns; }
export function workersIndexKey(ns) { return "workers:" + ns; }
export function workerVersionsKey(ns, name) { return "worker-versions:" + ns + ":" + name; }
`);

const src = applyModuleReplacements(readRepositoryFile("control/handlers/workers.js"), [
  [/from "control-shared";/, `from ${JSON.stringify(controlSharedUrl)};`],
  [/from "control-lib";/, `from ${JSON.stringify(controlLibUrl)};`],
]);

const { handle } = await import(moduleDataUrl(src));

function resetWorkersHandlerState() {
  /** @type {unknown[][]} */
  const commands = [];
  /** @type {any} */ (globalThis).__workersHandlerState = {
    sessions: 0,
    logs: [],
    session: {
      /** @param {string} key */
      async sMembers(key) {
        commands.push(["SMEMBERS", key]);
        return ["beta", "alpha"];
      },
      /** @param {string} key */
      async hGetAll(key) {
        commands.push(["HGETALL", key]);
        return { alpha: "v2" };
      },
      /**
       * @param {string[]} keys
       * @param {number} start
       * @param {number} stop
       */
      async zRangeMany(keys, start, stop) {
        commands.push(["ZRANGE_PIPELINE", keys, start, stop]);
        return keys.map((key) => (key.endsWith(":alpha") ? ["v1", "v2"] : ["v1"]));
      },
      /** @param {string[]} keys */
      async existsMany(keys) {
        commands.push(["EXISTS_PIPELINE", keys]);
        return keys.map((key) => key.endsWith(":beta"));
      },
    },
    commands,
  };
  return /** @type {any} */ (globalThis).__workersHandlerState;
}

test("workers handler lists namespace state through one Redis session", async () => {
  const state = resetWorkersHandlerState();

  const response = await handle({ method: "GET", nsName: "demo", requestId: "rid-workers" });

  assert.equal(state.sessions, 1);
  await assertJsonResponse(response, 200, {
    namespace: "demo",
    workers: [
      {
        name: "alpha",
        activeVersion: "v2",
        versions: ["v1", "v2"],
        versionCount: 2,
        hasSecrets: false,
      },
      {
        name: "beta",
        activeVersion: null,
        versions: ["v1"],
        versionCount: 1,
        hasSecrets: true,
      },
    ],
  });
  assert.deepEqual(state.commands, [
    ["SMEMBERS", "workers:demo"],
    ["HGETALL", "routes:demo"],
    ["ZRANGE_PIPELINE", [
      "worker-versions:demo:alpha",
      "worker-versions:demo:beta",
    ], 0, -1],
    ["EXISTS_PIPELINE", [
      "secrets:demo:alpha",
      "secrets:demo:beta",
    ]],
  ]);
  assert.deepEqual(state.logs, [{
    level: "info",
    event: "workers_listed",
    fields: { request_id: "rid-workers", namespace: "demo", count: 2 },
  }]);
});
