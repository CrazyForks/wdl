import { DurableObject } from "cloudflare:workers";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {URLSearchParams} params @param {string} name @param {number} fallback */
function numberParamOr(params, name, fallback) {
  const raw = params.get(name);
  const value = raw == null || raw === "" ? fallback : raw;
  return Number(value);
}

export class SlowCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.memory = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS slow_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS lease_budget_events (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const readEvent = (name) => [...sql.exec("SELECT value FROM lease_budget_events WHERE name = ?", name)][0]?.value ?? 0;
    const writeEvent = (name, value) => sql.exec(
      "INSERT INTO lease_budget_events (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name,
      value
    );
    if (url.pathname === "/lease-state") {
      return Response.json({
        started: readEvent("started"),
        after: readEvent("after"),
      });
    }
    if (url.pathname === "/post-await-write") {
      writeEvent("started", readEvent("started") + 1);
      await sleep(numberParamOr(url.searchParams, "ms", 1000));
      writeEvent("after", readEvent("after") + 1);
      return Response.json({
        started: readEvent("started"),
        after: readEvent("after"),
      });
    }
    const row = [...sql.exec("SELECT value FROM slow_counters WHERE name = ?", "main")][0];
    const storage = (row?.value ?? 0) + 1;
    sql.exec(
      "INSERT INTO slow_counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      "main",
      storage
    );
    this.memory += 1;
    if (url.pathname === "/sleep") {
      await sleep(numberParamOr(url.searchParams, "ms", 1000));
    }
    return Response.json({ memory: this.memory, storage });
  }
}

export default {
  async fetch(request, env) {
    const id = env.SLOW.idFromName("main");
    return await env.SLOW.get(id).fetch(request);
  },
};
