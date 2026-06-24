import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

export class OrderWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return await step.do("record", async () => ({
      createdBy: event.payload.createdBy,
      id: event.payload.id,
      fromEnv: this.env.LABEL,
    }));
  }
}

export class Launcher extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "from-do";
    if (url.pathname.endsWith("/status")) {
      const instance = await this.env.ORDERS.get(id);
      return Response.json(await instance.status({ includeSteps: true }));
    }
    const instance = await this.env.ORDERS.create({
      id,
      params: { id, createdBy: "durable-object" },
      callback: { kind: "do", binding: "PROGRESS", idFromName: "main" },
    });
    return Response.json({
      id: instance.id,
      status: await instance.status(),
    });
  }
}

export class Progress extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)");
    if (request.method === "POST") {
      const body = await request.json();
      this.ctx.storage.sql.exec("INSERT INTO progress (event) VALUES (?)", body.progress?.event || "unknown");
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/events")) {
      const rows = [...this.ctx.storage.sql.exec("SELECT event FROM progress ORDER BY id")];
      return Response.json({ events: rows.map((row) => row.event) });
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/progress/events")) {
      const id = env.PROGRESS.idFromName("main");
      return await env.PROGRESS.get(id).fetch(request);
    }
    const id = env.LAUNCHER.idFromName("main");
    return await env.LAUNCHER.get(id).fetch(request);
  },
};
