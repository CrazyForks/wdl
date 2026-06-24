// WDL Workflows metadata path: deploy-time parsing and Redis persistence.
// Execution is covered by later workflows milestones.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminPost,
  assertStatus,
  readMeta,
  uniqueNs,
  setupIntegrationSuite,
} from "./helpers/index.js";
import { redisHGetJson } from "./helpers/redis.js";

setupIntegrationSuite();

const WORKER_CODE = `
export class OrderWorkflow {}
export class ReplacementWorkflow {}
export default { fetch() { return new Response("ok"); } };
`;

/** @param {string} ns @param {string} worker @param {string} workflowName */
function readWorkflowDef(ns, worker, workflowName) {
  return redisHGetJson(`wf:defs:${ns}:${worker}`, workflowName, {
    label: `wf:defs:${ns}:${worker} ${workflowName}`,
  });
}

test("deploy stores workflow metadata and wf:defs with stable workflow keys", async () => {
  const ns = uniqueNs("wfmeta");
  const first = await adminPost(`/ns/${ns}/worker/shop/deploy`, {
    code: WORKER_CODE,
    workflows: [
      { name: "orders", binding: "ORDERS", className: "OrderWorkflow" },
    ],
  });
  assertStatus(first, 201, "initial workflow deploy");

  const firstMeta = readMeta(ns, "shop", first.json.version);
  assert.equal(firstMeta.workflows.length, 1);
  assert.deepEqual(
    {
      name: firstMeta.workflows[0].name,
      binding: firstMeta.workflows[0].binding,
      className: firstMeta.workflows[0].className,
    },
    { name: "orders", binding: "ORDERS", className: "OrderWorkflow" },
  );
  assert.match(firstMeta.workflows[0].workflowKey, /^wf_[0-9a-f]{32}$/);

  const firstDef = readWorkflowDef(ns, "shop", "orders");
  assert.deepEqual(firstDef, {
    workflowKey: firstMeta.workflows[0].workflowKey,
    className: "OrderWorkflow",
  });

  const second = await adminPost(`/ns/${ns}/worker/shop/deploy`, {
    code: WORKER_CODE,
    workflows: [
      { name: "orders", binding: "ORDERS", className: "ReplacementWorkflow" },
    ],
  });
  assertStatus(second, 201, "replacement workflow deploy");

  const secondMeta = readMeta(ns, "shop", second.json.version);
  assert.equal(secondMeta.workflows[0].workflowKey, firstMeta.workflows[0].workflowKey);
  assert.equal(secondMeta.workflows[0].className, "ReplacementWorkflow");

  const secondDef = readWorkflowDef(ns, "shop", "orders");
  assert.deepEqual(secondDef, {
    workflowKey: firstMeta.workflows[0].workflowKey,
    className: "ReplacementWorkflow",
  });
});

test("deploy rejects Cloudflare script_name workflows with a stable code", async () => {
  const ns = uniqueNs("wfscript");
  const res = await adminPost(`/ns/${ns}/worker/shop/deploy`, {
    code: WORKER_CODE,
    workflows: [
      {
        name: "orders",
        binding: "ORDERS",
        className: "OrderWorkflow",
        script_name: "other-worker",
      },
    ],
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "workflow_script_name_unsupported");
});
