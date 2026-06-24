// End-to-end coverage for [[platform_bindings]]: linker resolution,
// callerSecrets forwarding, R1, as-uniqueness, and per-entrypoint ACL.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminPost,
  adminPut,
  deployAndPromote,
  gatewayFetch,
  responseJson,
  uniqueNs,
  setupIntegrationSuite,
  workerFetchCallerSource,
} from "./helpers/index.js";

setupIntegrationSuite();

// Inline demo source — self-contained so a run can't silently link
// against a stale bundled copy.
const PLATFORM_DEMO_SRC = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class Echo extends WorkerEntrypoint {
  async echo(...args) {
    return {
      args,
      callerNs: this.ctx.props.callerNs,
      callerSecrets: this.ctx.props.callerSecrets ?? null,
    };
  }
  async boom(msg) { throw new Error(msg ?? "demo-error"); }
  async probe() {
    return {
      envKeys: Object.keys(this.env).toSorted(),
      propsKeys: Object.keys(this.ctx.props).toSorted(),
    };
  }
  async fetch(req) {
    return Response.json({
      via: "fetch",
      url: req.url,
      callerNs: this.ctx.props.callerNs,
      callerSecrets: this.ctx.props.callerSecrets ?? null,
    });
  }
}
export class Ops extends WorkerEntrypoint {
  async whoami() { return { entrypoint: "Ops", callerNs: this.ctx.props.callerNs }; }
}
export default { fetch() { return new Response("jsrpc only", { status: 404 }); } };
`;

async function deployDemo(as = "DEMO") {
  const exportsEntries = [
    {
      entrypoint: "Echo",
      as,
      allowedCallers: ["*"],
      requiredCallerSecrets: ["ALLOWED_KEY"],
    },
    {
      entrypoint: "Ops",
      as: `${as}_OPS`,
      allowedCallers: ["*"],
      requiredCallerSecrets: [],
    },
  ];
  await deployAndPromote("__platform__", "platform-demo", {
    code: PLATFORM_DEMO_SRC,
    exports: exportsEntries,
  });
}

test("[[platform_bindings]] end-to-end: Echo dispatch + callerNs + callerSecrets filter", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  // ALLOWED_KEY is listed, LEAK_KEY is not — LEAK_KEY must not travel.
  await adminPut(`/ns/${callerNs}/secrets/ALLOWED_KEY`, { value: "present" });
  await adminPut(`/ns/${callerNs}/secrets/LEAK_KEY`, { value: "leak-me" });

  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      return Response.json(await env.DEMO.echo("hi", { n: 1 }));
    `),
    platformBindings: [{ binding: "DEMO", platform: "DEMO" }],
  });

  const res = await gatewayFetch(callerNs, "/app/");
  assert.equal(res.status, 200);
  const body = await responseJson(res);
  assert.deepEqual(body.args, ["hi", { n: 1 }]);
  assert.equal(body.callerNs, callerNs);
  assert.deepEqual(body.callerSecrets, { ALLOWED_KEY: "present" });
  assert.ok(!("LEAK_KEY" in body.callerSecrets));
});

test("[[platform_bindings]] caller vars do NOT fall back into callerSecrets", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  // Same-named var exists, but secrets path must not fall back to vars.
  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      return Response.json(await env.DEMO.echo());
    `),
    vars: { ALLOWED_KEY: "var-value-must-not-leak" },
    platformBindings: [{ binding: "DEMO" }],
  });
  const res = await gatewayFetch(callerNs, "/app/");
  const body = await responseJson(res);
  assert.deepEqual(body.callerSecrets, {});
});

test("[[platform_bindings]] aliasing: binding name decoupled from platform `as`", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  await adminPut(`/ns/${callerNs}/secrets/ALLOWED_KEY`, { value: "ok" });

  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      return Response.json(await env.PAYMENT.echo("aliased"));
    `),
    platformBindings: [{ binding: "PAYMENT", platform: "DEMO" }],
  });
  const res = await gatewayFetch(callerNs, "/app/");
  const body = await responseJson(res);
  assert.deepEqual(body.args, ["aliased"]);
});

test("[[platform_bindings]] multi-entrypoint: DEMO → Echo, DEMO_OPS → Ops", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  await adminPut(`/ns/${callerNs}/secrets/ALLOWED_KEY`, { value: "v" });
  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      const e = await env.DEMO.echo();
      const o = await env.OPS.whoami();
      return Response.json({ echoCallerNs: e.callerNs, opsCallerNs: o.callerNs, opsEntry: o.entrypoint });
    `),
    platformBindings: [
      { binding: "DEMO", platform: "DEMO" },
      { binding: "OPS", platform: "DEMO_OPS" },
    ],
  });
  const res = await gatewayFetch(callerNs, "/app/");
  const body = await responseJson(res);
  assert.equal(body.echoCallerNs, callerNs);
  assert.equal(body.opsCallerNs, callerNs);
  assert.equal(body.opsEntry, "Ops");
});

test("[[platform_bindings]] error annotation carries through to caller", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  await adminPut(`/ns/${callerNs}/secrets/ALLOWED_KEY`, { value: "v" });
  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      await env.DEMO.boom("kaboom");
      return new Response("unreachable");
    `),
    platformBindings: [{ binding: "DEMO" }],
  });
  const res = await gatewayFetch(callerNs, "/app/");
  assert.equal(res.status, 500);
  const body = await responseJson(res);
  assert.match(body.err, /kaboom/);
  assert.match(body.err, /service binding/);
  // Pinned platform worker id lets operators trace which version served.
  assert.match(body.err, /__platform__:platform-demo:v\d+/);
});

test("[[platform_bindings]] probe: env (platform worker's own) vs ctx.props (per-caller) do not cross-contaminate", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  await adminPut(`/ns/${callerNs}/secrets/ALLOWED_KEY`, { value: "v" });
  await adminPut(`/ns/${callerNs}/secrets/ONLY_IN_CALLER`, { value: "x" });
  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`return Response.json(await env.DEMO.probe());`),
    vars: { CALLER_VAR: "dont-leak" },
    platformBindings: [{ binding: "DEMO" }],
  });
  const res = await gatewayFetch(callerNs, "/app/");
  const body = await responseJson(res);
  assert.ok(body.propsKeys.includes("callerNs"));
  assert.ok(body.propsKeys.includes("callerSecrets"));
  for (const leak of ["CALLER_VAR", "ONLY_IN_CALLER", "ALLOWED_KEY"]) {
    assert.ok(!body.envKeys.includes(leak), `${leak} leaked into platform worker env`);
  }
});

test("[[platform_bindings]] missing caller secrets → deploy warnings[]", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  const dep = await adminPost(`/ns/${callerNs}/worker/app/deploy`, {
    code: workerFetchCallerSource(`return new Response("x");`),
    platformBindings: [{ binding: "DEMO" }],
  });
  assert.equal(dep.status, 201);
  assert.ok(Array.isArray(dep.json.warnings), "warnings should be present");
  const w = dep.json.warnings.find((/** @type {any} */ x) => x.binding === "DEMO");
  assert.ok(w, "warning for DEMO expected");
  assert.deepEqual(w.missingCallerSecrets, ["ALLOWED_KEY"]);
});

test("[[platform_bindings]] callerNs is runtime-signed: caller cannot forge via ctx.props tampering", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  await adminPut(`/ns/${callerNs}/secrets/ALLOWED_KEY`, { value: "v" });
  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      const attempts = [];
      try {
        env.DEMO.ctx.props.callerNs = "attacker";
        attempts.push("mutate-ok");
      } catch (err) {
        attempts.push("mutate-threw:" + err.message);
      }
      try {
        Object.defineProperty(env.DEMO.ctx, "props", { value: { callerNs: "attacker" } });
        attempts.push("defineProperty-ok");
      } catch (err) {
        attempts.push("defineProperty-threw:" + err.message);
      }
      const fetchRes = await env.DEMO.fetch(new Request("https://x/", {
        headers: { "x-caller-ns": "attacker" },
      }));
      const viaFetch = await fetchRes.json();
      const viaRpc = await env.DEMO.echo("check");
      return Response.json({ attempts, reportedViaRpc: viaRpc.callerNs, reportedViaFetch: viaFetch.callerNs });
    `),
    platformBindings: [{ binding: "DEMO" }],
  });
  const res = await gatewayFetch(callerNs, "/app/");
  const body = await responseJson(res);
  // Whether tampering throws or no-ops is workerd's call; the invariant
  // we lock is that the target never sees "attacker".
  assert.equal(body.reportedViaRpc, callerNs);
  assert.equal(body.reportedViaFetch, callerNs);
  assert.notEqual(body.reportedViaRpc, "attacker");
  assert.notEqual(body.reportedViaFetch, "attacker");
});

test("[[platform_bindings]] .fetch(Request) path forwards callerNs + callerSecrets via ServiceBinding#fetch", async () => {
  // Sibling of the forwardRpc tests; guards the fetch branch so a
  // regression that stops propagating props there doesn't hide until
  // production.
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  await adminPut(`/ns/${callerNs}/secrets/ALLOWED_KEY`, { value: "via-fetch" });
  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      const r = await env.DEMO.fetch(new Request("https://platform-demo.internal/hello"));
      const body = await r.json();
      return Response.json(body);
    `),
    platformBindings: [{ binding: "DEMO" }],
  });
  const res = await gatewayFetch(callerNs, "/app/");
  const body = await responseJson(res);
  assert.equal(body.via, "fetch");
  assert.equal(body.callerNs, callerNs);
  assert.deepEqual(body.callerSecrets, { ALLOWED_KEY: "via-fetch" });
});

test("[[platform_bindings]] default function export is exposed through .fetch(Request)", async () => {
  await deployAndPromote("__platform__", "platform-fn", {
    code: `
      export default function(request) {
        return new Response("platform-fn:" + new URL(request.url).pathname);
      }
    `,
    exports: [{ entrypoint: "default", as: "DEMO", allowedCallers: ["*"] }],
  });
  const callerNs = uniqueNs("pbc");
  await deployAndPromote(callerNs, "app", {
    code: workerFetchCallerSource(`
      const r = await env.DEMO.fetch(new Request("https://platform-fn.internal/from-platform-binding"));
      return new Response(await r.text());
    `),
    platformBindings: [{ binding: "DEMO" }],
  });

  const res = await gatewayFetch(callerNs, "/app/");

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "platform-fn:/from-platform-binding");
});

test("requiredCallerSecrets cannot be smuggled via raw [[services]] bindings", async () => {
  // Direct admin API is the only path that could land this field on a
  // raw service binding; CLI grammar filters it out. Admin must reject.
  const targetNs = uniqueNs("sbt");
  const callerNs = uniqueNs("sbc");
  await deployAndPromote(targetNs, "target", {
    code: PLATFORM_DEMO_SRC,
    exports: [{ entrypoint: "Echo", allowedCallers: ["*"] }],
  });
  const res = await adminPost(`/ns/${callerNs}/worker/rogue/deploy`, {
    code: workerFetchCallerSource(`return new Response("x");`),
    bindings: {
      T: {
        type: "service",
        service: "target",
        ns: targetNs,
        entrypoint: "Echo",
        requiredCallerSecrets: ["ALLOWED_KEY"],
      },
    },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /requiredCallerSecrets is set by the platform linker/);
});

test("R1: raw [[services]] targeting __platform__ → 400", async () => {
  await deployDemo();
  const callerNs = uniqueNs("pbc");
  const res = await adminPost(`/ns/${callerNs}/worker/rogue/deploy`, {
    code: workerFetchCallerSource(`return new Response("x");`),
    bindings: {
      X: {
        type: "service",
        service: "platform-demo",
        ns: "__platform__",
        entrypoint: "Echo",
      },
    },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /\[\[platform_bindings\]\]/);
});

test("Unknown platform name → 400 with helpful message", async () => {
  const callerNs = uniqueNs("pbc");
  const res = await adminPost(`/ns/${callerNs}/worker/app/deploy`, {
    code: workerFetchCallerSource(`return new Response("x");`),
    platformBindings: [{ binding: "X", platform: "UNKNOWN_XYZ" }],
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /UNKNOWN_XYZ/);
  assert.match(res.json.message, /not registered/);
});

test("`as` uniqueness: two __platform__ workers claiming the same `as` → 409 at promote", async () => {
  await deployDemo("DEMO");
  // Rival deploy commits (burns a version), but promote must 409 —
  // platform-demo already holds `as = "DEMO"`.
  const dep = await adminPost(`/ns/__platform__/worker/platform-rival/deploy`, {
    code: PLATFORM_DEMO_SRC,
    exports: [
      { entrypoint: "Echo", as: "DEMO", allowedCallers: ["*"] },
    ],
  });
  assert.equal(dep.status, 201);
  const prom = await adminPost(`/ns/__platform__/worker/platform-rival/promote`, {
    version: dep.json.version,
  });
  assert.equal(prom.status, 409);
  assert.equal(prom.json.error, "platform_as_conflict");
  assert.match(prom.json.message, /already claimed/);
});

test("`as` uniqueness: same worker renewing its own `as` across versions is allowed", async () => {
  await deployDemo("DEMO");
  // Normal rollover — not a collision.
  const dep = await adminPost(`/ns/__platform__/worker/platform-demo/deploy`, {
    code: PLATFORM_DEMO_SRC,
    exports: [
      {
        entrypoint: "Echo",
        as: "DEMO",
        allowedCallers: ["*"],
        requiredCallerSecrets: ["ALLOWED_KEY"],
      },
      {
        entrypoint: "Ops",
        as: "DEMO_OPS",
        allowedCallers: ["*"],
        requiredCallerSecrets: [],
      },
    ],
  });
  assert.equal(dep.status, 201);
  const prom = await adminPost(`/ns/__platform__/worker/platform-demo/promote`, {
    version: dep.json.version,
  });
  assert.equal(prom.status, 200);
});

test("Path A ACL: per-entrypoint allowed_callers enforced at platform-binding deploy", async () => {
  // Covers the linker's own ACL call site — service-bindings-rpc tests
  // cover Path B. If the two paths drift, this fails loudly.
  const allowedNs = uniqueNs("pbyes");
  const deniedNs = uniqueNs("pbno");
  await deployAndPromote("__platform__", "platform-demo", {
    code: PLATFORM_DEMO_SRC,
    exports: [
      {
        entrypoint: "Echo",
        as: "DEMO",
        allowedCallers: [allowedNs],
        requiredCallerSecrets: [],
      },
      {
        entrypoint: "Ops",
        as: "DEMO_OPS",
        allowedCallers: ["*"],
        requiredCallerSecrets: [],
      },
    ],
  });

  await deployAndPromote(allowedNs, "app", {
    code: workerFetchCallerSource(`return Response.json(await env.DEMO.echo("ok"));`),
    platformBindings: [{ binding: "DEMO" }],
  });
  const allowed = await gatewayFetch(allowedNs, "/app/");
  const body = await responseJson(allowed);
  assert.deepEqual(body.args, ["ok"]);
  assert.equal(body.callerNs, allowedNs);

  const rejected = await adminPost(`/ns/${deniedNs}/worker/app/deploy`, {
    code: workerFetchCallerSource(`return new Response("x");`),
    platformBindings: [{ binding: "DEMO" }],
  });
  assert.equal(rejected.status, 403);
  assert.match(rejected.json.message, /does not allow ns/);
  assert.match(rejected.json.message, new RegExp(RegExp.escape(deniedNs)));

  // DEMO_OPS stays reachable — ACL decision is per-entrypoint, not per-worker.
  const opsOk = await adminPost(`/ns/${deniedNs}/worker/ops-app/deploy`, {
    code: workerFetchCallerSource(`return Response.json(await env.OPS.whoami());`),
    platformBindings: [{ binding: "OPS", platform: "DEMO_OPS" }],
  });
  assert.equal(opsOk.status, 201);
});
