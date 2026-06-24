// Workflows service skeleton: local compose wiring, health, and metrics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { responseJson, serviceInternalGet, setupIntegrationSuite } from "./helpers/index.js";

setupIntegrationSuite();

test("workflows exposes health and metrics through the private service", () => {
  const health = serviceInternalGet("workflows", 9120, "/_healthz");
  assert.equal(health.status, 200);
  const body = responseJson(health);
  assert.equal(body.ok, true);
  assert.equal(body.service, "workflows");
  assert.match(body.instance, /^wf-[0-9a-f]{16}$/);

  const metrics = serviceInternalGet("workflows", 9120, "/_metrics");
  assert.equal(metrics.status, 200);
  assert.match(metrics.body, /# TYPE wdl_workflow_health_checks_total counter/);
  assert.match(metrics.body, /wdl_workflow_health_checks_total\{outcome="ok"\} [1-9][0-9]*/);
  assert.match(metrics.body, /# TYPE wdl_workflow_redis_ping_duration_ms summary/);
});
