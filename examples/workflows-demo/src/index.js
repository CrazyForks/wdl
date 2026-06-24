import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

function json(data, init = {}) {
  return Response.json(data, init);
}

function boolParam(url, name) {
  const value = url.searchParams.get(name);
  return value === "1" || value === "true" || value === "";
}

function intParam(url, name, fallback = 0) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function instanceId(url) {
  return url.searchParams.get("id") || "order-1";
}

async function readJson(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) return {};
  return await request.json();
}

function callbackDescriptor(url) {
  if (!boolParam(url, "callback")) return undefined;
  return {
    kind: "do",
    binding: "PROGRESS",
    idFromName: url.searchParams.get("callbackId") || "main",
  };
}

export class OrderWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload || {};
    const mode = payload.mode || "default";

    if (payload.sleepMs > 0) {
      await step.sleep("settle", payload.sleepMs);
    }

    if (mode === "retry") {
      return await step.do(
        "flaky",
        { retries: { limit: 2, delayMs: 250, backoff: "constant" } },
        async ({ attempt }) => {
          if (attempt === 1) throw new Error("try again");
          return {
            mode,
            attempt,
            id: payload.id,
            label: this.env.LABEL,
          };
        }
      );
    }

    if (mode === "nonretryable") {
      return await step.do(
        "non-retryable",
        { retries: { limit: 5, delayMs: 250, backoff: "constant" } },
        async () => {
          throw new NonRetryableError("fatal validation");
        }
      );
    }

    if (mode === "parallel") {
      const order = await step.do("load-order", async () => ({
        id: payload.id,
        sku: payload.sku || "sku-demo",
        cents: payload.cents || 4200,
        label: this.env.LABEL,
      }));
      const [inventory, payment, risk] = await Promise.all([
        step.do("reserve-inventory", async () => ({
          orderId: order.id,
          sku: payload.sku || "sku-demo",
          reserved: true,
          label: this.env.LABEL,
        })),
        step.do("authorize-payment", async () => ({
          orderId: order.id,
          cents: payload.cents || 4200,
          authorized: true,
          label: this.env.LABEL,
        })),
        step.do("score-risk", async () => ({
          orderId: order.id,
          score: 7,
          accepted: true,
          label: this.env.LABEL,
        })),
      ]);
      const [fulfillment, audit] = await Promise.all([
        step.do("plan-fulfillment", async () => ({
          orderId: order.id,
          inventoryReserved: inventory.reserved,
          paymentAuthorized: payment.authorized,
        })),
        step.do("record-audit", async () => ({
          orderId: order.id,
          paymentAuthorized: payment.authorized,
          riskAccepted: risk.accepted,
        })),
      ]);
      return await step.do("finish-order", async () => ({
        id: order.id,
        mode,
        graph: {
          order,
          inventory,
          payment,
          risk,
          fulfillment,
          audit,
        },
        finished: true,
      }));
    }

    let approval = null;
    if (payload.wait) {
      approval = await step.waitForEvent("approval", {
        type: "approval",
        timeout: payload.waitTimeoutMs > 0 ? `${payload.waitTimeoutMs}ms` : "60s",
      });
    }

    return await step.do("record", async () => ({
      id: payload.id,
      mode,
      approval,
      label: this.env.LABEL,
      source: payload.source || "workflows-demo",
      completedAt: new Date().toISOString(),
    }));
  }
}

export class Progress extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  ensureTable() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL, status TEXT, body TEXT NOT NULL)"
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.ensureTable();

    if (request.method === "POST") {
      const body = await request.json();
      this.ctx.storage.sql.exec(
        "INSERT INTO progress (ts, event, status, body) VALUES (?, ?, ?, ?)",
        Date.now(),
        body.progress?.event || "unknown",
        body.progress?.status || null,
        JSON.stringify(body)
      );
      return new Response(null, { status: 204 });
    }

    if (url.pathname.endsWith("/clear")) {
      this.ctx.storage.sql.exec("DELETE FROM progress");
      return json({ cleared: true });
    }

    if (url.pathname.endsWith("/events")) {
      const limit = Math.min(100, Math.max(1, intParam(url, "limit", 50)));
      const rows = [
        ...this.ctx.storage.sql.exec(
          "SELECT id, ts, event, status, body FROM progress ORDER BY id DESC LIMIT ?",
          limit
        ),
      ];
      return json({
        events: rows.toReversed().map((row) => ({
          id: row.id,
          ts: row.ts,
          event: row.event,
          status: row.status,
          body: JSON.parse(row.body),
        })),
      });
    }

    return json({ error: "not_found", message: "route not found", path: url.pathname }, { status: 404 });
  }
}

async function workflowStatus(env, id, includeSteps = false) {
  const instance = await env.ORDERS.get(id);
  return await instance.status({ includeSteps });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/") {
    return json({
      worker: "workflows-demo",
      routes: [
        "/start?id=order-1&callback=1",
        "/start?id=dag-1&mode=parallel&steps=1",
        "/status?id=order-1&steps=1",
        "/event?id=order-1&message=approved",
        "/pause?id=order-1",
        "/resume?id=order-1",
        "/restart?id=order-1",
        "/terminate?id=order-1",
        "/progress/events",
        "/progress/clear",
      ],
    });
  }

  if (path === "/start") {
    const body = await readJson(request);
    const id = body.id || instanceId(url);
    const instance = await env.ORDERS.create({
      id,
      params: {
        id,
        source: body.source || "workflows-demo",
        mode: body.mode || url.searchParams.get("mode") || "default",
        wait: body.wait ?? boolParam(url, "wait"),
        waitTimeoutMs: body.waitTimeoutMs ?? intParam(url, "waitTimeoutMs", 0),
        sleepMs: body.sleepMs ?? intParam(url, "sleepMs", 0),
      },
      callback: body.callback || callbackDescriptor(url),
    });
    return json({
      id: instance.id,
      status: await instance.status({ includeSteps: boolParam(url, "steps") }),
    });
  }

  if (path === "/status") {
    return json(await workflowStatus(env, instanceId(url), boolParam(url, "steps")));
  }

  if (path === "/event") {
    const body = await readJson(request);
    const id = body.id || instanceId(url);
    const instance = await env.ORDERS.get(id);
    await instance.sendEvent({
      type: body.type || url.searchParams.get("type") || "approval",
      payload: {
        message: body.message || url.searchParams.get("message") || "approved",
        label: env.LABEL,
      },
    });
    return json(await instance.status({ includeSteps: true }));
  }

  if (path === "/pause" || path === "/resume" || path === "/restart" || path === "/terminate") {
    const id = instanceId(url);
    const instance = await env.ORDERS.get(id);
    if (path === "/pause") await instance.pause();
    if (path === "/resume") await instance.resume();
    if (path === "/restart") await instance.restart();
    if (path === "/terminate") await instance.terminate();
    return json(await instance.status({ includeSteps: true }));
  }

  if (path === "/batch") {
    const instances = await env.ORDERS.createBatch([
      { id: "batch-a", params: { mode: "default", id: "batch-a" } },
      { id: "batch-a", params: { mode: "default", id: "batch-a-duplicate" } },
      { id: "batch-b", params: { mode: "default", id: "batch-b" } },
    ]);
    return json({ ids: instances.map((instance) => instance.id) });
  }

  if (path === "/progress/events" || path === "/progress/clear") {
    const id = env.PROGRESS.idFromName(url.searchParams.get("callbackId") || "main");
    return await env.PROGRESS.get(id).fetch(request);
  }

  return json({ error: "not_found", message: "route not found", path }, { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      return json({
        error: err?.name || "Error",
        message: err?.message || String(err),
      }, { status: 500 });
    }
  },
};
