import { WorkerEntrypoint } from "cloudflare:workers";

export class Api extends WorkerEntrypoint {
  async fetch(request) {
    const requestId = request.headers.get("x-request-id");
    await this.env.DB.exec("create table if not exists messages (id text, body text)");
    await this.env.DB.prepare("insert into messages (id, body) values (?, ?)")
      .bind("named-fetch", requestId || "missing")
      .run();
    const row = await this.env.DB.prepare("select * from messages where id = ?")
      .bind("named-fetch")
      .first();
    return Response.json({ requestId, row });
  }

  async init() {
    return await this.env.DB.exec("create table if not exists messages (id text, body text)");
  }

  async add(id, body) {
    return await this.env.DB.batch([
      this.env.DB.prepare("insert into messages (id, body) values (?, ?)").bind(id, body),
      this.env.DB.prepare("select * from messages where id = ?").bind(id),
    ]);
  }

  async get(id) {
    return await this.env.DB.prepare("select * from messages where id = ?").bind(id).first();
  }
}

export default {
  async fetch() {
    return new Response("named target");
  }
};