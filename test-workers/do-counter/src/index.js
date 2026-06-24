import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.memory = 0;
  }

  async fetch(request) {
    this.memory += 1;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const row = [...sql.exec("SELECT value FROM counters WHERE name = ?", "main")][0];
    const storage = (row?.value ?? 0) + 1;
    sql.exec(
      "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      "main",
      storage
    );
    return Response.json({
      objectId: String(this.ctx.id),
      memory: this.memory,
      storage,
      body: await request.text(),
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") || "main";
    const id = env.COUNTER.idFromName(name);
    const stub = env.COUNTER.get(id);
    return await stub.fetch("https://do.internal/increment", {
      method: "POST",
      body: "from-worker",
    });
  },
};
