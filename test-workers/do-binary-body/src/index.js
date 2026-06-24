import { DurableObject } from "cloudflare:workers";

export class EchoBody extends DurableObject {
  async fetch(request) {
    return Response.json({ bytes: [...new Uint8Array(await request.arrayBuffer())] });
  }
}

export default {
  async fetch(_request, env) {
    const id = env.ECHO.idFromName("main");
    return await env.ECHO.get(id).fetch("https://do.internal/body", {
      method: "POST",
      body: new Uint8Array([0, 255, 97]),
    });
  },
};
