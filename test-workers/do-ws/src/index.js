import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.memory = 0;
  }

  nextStorage() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS ws_counts (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const row = [...sql.exec("SELECT value FROM ws_counts WHERE name = ?", "main")][0];
    const storage = (row?.value ?? 0) + 1;
    sql.exec(
      "INSERT INTO ws_counts (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      "main",
      storage
    );
    return storage;
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("need websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const objectId = String(this.ctx.id);
    server.addEventListener("message", (evt) => {
      this.memory += 1;
      server.send(JSON.stringify({
        objectId,
        memory: this.memory,
        storage: this.nextStorage(),
        text: String(evt.data),
      }));
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = env.ROOM.idFromName(url.searchParams.get("name") || "main");
    return await env.ROOM.get(id).fetch(request);
  },
};
