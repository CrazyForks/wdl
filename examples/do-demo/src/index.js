import { DurableObject } from "cloudflare:workers";

function json(data, init = {}) {
  return Response.json(data, init);
}

/** @param {URLSearchParams} params @param {string} name @param {number} fallback */
function numberParamOr(params, name, fallback) {
  const raw = params.get(name);
  const value = raw == null || raw === "" ? fallback : raw;
  return Number(value);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.memory = 0;
  }

  ensureTables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)"
    );
  }

  readCounter(name) {
    this.ensureTables();
    const row = [...this.ctx.storage.sql.exec("SELECT value FROM counters WHERE name = ?", name)][0];
    return row?.value ?? 0;
  }

  bumpCounter(name) {
    const value = this.readCounter(name) + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name,
      value
    );
    return value;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") || String(this.ctx.id);

    if (url.pathname === "/hit") {
      this.memory += 1;
      return json({
        room,
        memory: this.memory,
        storageHits: this.bumpCounter("hits"),
        alarmCount: this.readCounter("alarms"),
      });
    }

    if (url.pathname === "/status" || url.pathname === "/") {
      return json({
        room,
        memory: this.memory,
        storageHits: this.readCounter("hits"),
        wsMessages: this.readCounter("ws"),
        alarmCount: this.readCounter("alarms"),
        pendingAlarm: await this.ctx.storage.getAlarm(),
        props: this.ctx.props,
      });
    }

    if (url.pathname === "/alarm") {
      const delayMs = Math.max(0, numberParamOr(url.searchParams, "delay_ms", 1000));
      const scheduledAt = Date.now() + delayMs;
      await this.ctx.storage.setAlarm(scheduledAt);
      return json({
        room,
        scheduledAt,
        pendingAlarm: await this.ctx.storage.getAlarm(),
      });
    }

    if (url.pathname === "/ws") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      server.addEventListener("message", (event) => {
        this.memory += 1;
        server.send(JSON.stringify({
          room,
          memory: this.memory,
          wsMessages: this.bumpCounter("ws"),
          text: typeof event.data === "string" ? event.data : "<binary>",
        }));
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "not_found", message: "route not found", path: url.pathname }, { status: 404 });
  }

  async alarm() {
    this.bumpCounter("alarms");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") || "main";
    const id = env.ROOMS.idFromName(room);
    return await env.ROOMS.get(id).fetch(request);
  },
};
