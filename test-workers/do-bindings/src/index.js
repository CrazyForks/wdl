import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || "main";
    const current = Number((await this.env.KV.get(key)) ?? 0);
    const next = current + 1;
    await this.env.KV.put(key, String(next));
    return Response.json({ current, next });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = env.ROOM.idFromName(url.searchParams.get("name") || "main");
    return await env.ROOM.get(id).fetch("https://do.internal/count?key=inside-do");
  },
};
