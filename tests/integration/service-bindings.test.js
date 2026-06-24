// Service bindings: worker → worker in-process RPC via workerLoader.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminPost,
  deployAndPromote,
  gatewayWorkerId,
  gatewayFetch,
  responseJson,
  uniqueNs,
  setupIntegrationSuite,
} from "./helpers/index.js";

setupIntegrationSuite();

const TARGET_V1 = `
export default {
  fetch(req) {
    return new Response(JSON.stringify({ tag: "v1", path: new URL(req.url).pathname }), {
      headers: { "content-type": "application/json" },
    });
  }
};`;

const TARGET_V2 = `
export default {
  fetch() {
    return new Response(JSON.stringify({ tag: "v2" }), {
      headers: { "content-type": "application/json" },
    });
  }
};`;

const CALLER = `
export default {
  async fetch(req, env) {
    const inner = await env.AUTH.fetch(new Request("https://svc/ping"));
    const body = await inner.json();
    return new Response(JSON.stringify({ caller: "ok", target: body }), {
      headers: { "content-type": "application/json" },
    });
  }
};`;

test("deploy fails 409 when service binding target has no active version", async () => {
  const ns = uniqueNs("sb");
  const res = await adminPost(`/ns/${ns}/worker/caller/deploy`, {
    code: CALLER,
    bindings: { AUTH: { type: "service", service: "missing" } },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, "service_binding_target_inactive");
  assert.match(res.json.message, /no active version/);
});

test("deploy fails 400 when service binding targets self", async () => {
  const ns = uniqueNs("sb");
  await deployAndPromote(ns, "caller", { code: TARGET_V1 });
  const res = await adminPost(`/ns/${ns}/worker/caller/deploy`, {
    code: CALLER,
    bindings: { AUTH: { type: "service", service: "caller" } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "service_binding_self_target");
  assert.match(res.json.message, /cannot target self/);
});

test("service binding: caller invokes target in-process, version pinned at deploy", async () => {
  const ns = uniqueNs("sb");
  await deployAndPromote(ns, "auth", { code: TARGET_V1 });
  await deployAndPromote(ns, "caller", {
    code: CALLER,
    bindings: { AUTH: { type: "service", service: "auth" } },
  });

  const res = await gatewayFetch(ns, "/caller/");
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.caller, "ok");
  assert.equal(body.target.tag, "v1");
  assert.equal(body.target.path, "/ping");
});

test("service binding: pinned version survives target promotion (no late binding)", async () => {
  const ns = uniqueNs("sb");
  await deployAndPromote(ns, "auth", { code: TARGET_V1 });
  await deployAndPromote(ns, "caller", {
    code: CALLER,
    bindings: { AUTH: { type: "service", service: "auth" } },
  });

  const before = await gatewayFetch(ns, "/caller/");
  assert.equal((await responseJson(before)).target.tag, "v1");

  // Promote auth to v2. Caller is pinned to v1 via __meta__ — the
  // behaviour under test is that it does NOT pick up v2.
  await deployAndPromote(ns, "auth", { code: TARGET_V2 });

  const after = await gatewayFetch(ns, "/caller/");
  assert.equal(after.status, 200);
  const body = await responseJson(after);
  assert.equal(body.target.tag, "v1", "caller must stay pinned to v1 after auth promote");

  // Redeploying the caller re-resolves the pin to the now-active v2.
  await deployAndPromote(ns, "caller", {
    code: CALLER,
    bindings: { AUTH: { type: "service", service: "auth" } },
  });
  const refreshed = await gatewayFetch(ns, "/caller/");
  assert.equal((await responseJson(refreshed)).target.tag, "v2");
});

const HEADER_ECHO = `
export default {
  fetch(req) {
    return new Response(JSON.stringify({
      wid: req.headers.get("x-worker-id"),
      rid: req.headers.get("x-request-id"),
    }), { headers: { "content-type": "application/json" } });
  }
};`;

// One worker covers multiple header scenarios; test picks via ?mode=.
const HEADER_CALLER = `
export default {
  async fetch(req, env) {
    const mode = new URL(req.url).searchParams.get("mode");
    let inner;
    if (mode === "forge") {
      inner = await env.T.fetch(new Request("https://svc/", {
        headers: { "x-worker-id": "attacker:ns:v999", "x-request-id": "caller-rid" },
      }));
    } else if (mode === "forward") {
      inner = await env.T.fetch(req);
    } else {
      inner = await env.T.fetch(new Request("https://svc/"));
    }
    const body = await inner.json();
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }
};`;

test("service binding: x-worker-id forced to target id, caller cannot forge", async () => {
  const ns = uniqueNs("sb");
  const targetVersion = await deployAndPromote(ns, "target", { code: HEADER_ECHO });
  await deployAndPromote(ns, "caller", {
    code: HEADER_CALLER,
    bindings: { T: { type: "service", service: "target" } },
  });

  const res = await gatewayFetch(ns, "/caller/?mode=forge");
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.wid, gatewayWorkerId(ns, "target", targetVersion),
    "platform must overwrite caller-supplied x-worker-id with target's id");
  assert.notEqual(body.wid, "attacker:ns:v999");
});

test("service binding: x-request-id preserved when caller forwards the outer request", async () => {
  const ns = uniqueNs("sb");
  await deployAndPromote(ns, "target", { code: HEADER_ECHO });
  await deployAndPromote(ns, "caller", {
    code: HEADER_CALLER,
    bindings: { T: { type: "service", service: "target" } },
  });

  const res = await gatewayFetch(ns, "/caller/?mode=forward", {
    headers: { "x-request-id": "trace-end-to-end" },
  });
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.equal(body.rid, "trace-end-to-end");
});
