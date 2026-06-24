import { test } from "node:test";
import assert from "node:assert/strict";
import { controlSharedStubUrl } from "../helpers/control-shared-stub.js";
import {
  applyModuleReplacements,
  moduleDataUrl,
  readRepositoryFile,
} from "../helpers/load-shared-module.js";
import { jsonRequest } from "../helpers/request-body.js";
import { assertJsonResponse } from "../helpers/response-json.js";

/** @type {any} */ (globalThis).__authTokensHandlerState = null;

const controlSharedUrl = controlSharedStubUrl(`
export const state = {
  log(level, event, fields) {
    globalThis.__authTokensHandlerState.logs.push({ level, event, fields });
  },
};
export function authPolicyResponse(err) {
  return jsonError(err.status || 503, err.reason || "auth_error", err.message || "auth error");
}
`);

const src = applyModuleReplacements(readRepositoryFile("control/handlers/auth-tokens.js"), [
  [/from "control-shared";/, `from ${JSON.stringify(controlSharedUrl)};`],
]);

const { handle } = await import(moduleDataUrl(src));

function resetAuthTokensHandlerState() {
  /** @type {any} */ (globalThis).__authTokensHandlerState = {
    delegatedIssueCalls: [],
    issueCalls: [],
    logs: [],
  };
  return /** @type {any} */ (globalThis).__authTokensHandlerState;
}

test("auth delegated token handler accepts only template in request body", async () => {
  const state = resetAuthTokensHandlerState();
  const response = await handle({
    request: jsonRequest("https://ctl.example/auth/delegated-tokens", { template: "wdl-chat-ns-pool", foo: "bar" }, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    env: {
      AUTH: {
        /** @param {Record<string, unknown>} input */
        async delegatedIssue(input) {
          state.delegatedIssueCalls.push(input);
          return { tokenId: "delegated-1" };
        },
      },
    },
    url: new URL("https://ctl.example/auth/delegated-tokens"),
    method: "POST",
    auth: { tokenId: "issuer-1" },
    requestId: "rid-auth-delegated",
    routeKind: "delegatedTokens",
  });

  await assertJsonResponse(response, 400, {
    error: "invalid_template_request",
    message: "foo is not accepted by delegated issue",
  });
  assert.deepEqual(state.delegatedIssueCalls, []);
});

test("auth token handler rejects storage-shaped issue_templates before AUTH issue", async () => {
  const state = resetAuthTokensHandlerState();
  const response = await handle({
    request: jsonRequest("https://ctl.example/auth/tokens", {
      kind: "token-issuer",
      issueTemplates: ["wdl-chat-ns-pool"],
      issue_templates: ["wdl-chat-ns-pool"],
    }, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    env: {
      AUTH: {
        /** @param {Record<string, unknown>} input */
        async issue(input) {
          state.issueCalls.push(input);
          return { tokenId: "issuer-1" };
        },
      },
    },
    url: new URL("https://ctl.example/auth/tokens"),
    method: "POST",
    auth: { tokenId: "bootstrap" },
    requestId: "rid-auth-issue",
  });

  await assertJsonResponse(response, 400, {
    error: "invalid_template_request",
    message: "issue_templates is a storage field; use issueTemplates",
  });
  assert.deepEqual(state.issueCalls, []);
});
