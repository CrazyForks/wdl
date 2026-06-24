// HTTP + WebSocket + streaming smoke fixture; deployable against any env
// to exercise the upgrade / streaming / cancel code paths live.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "") {
      return Response.json({
        ok: true,
        worker: "ws-echo",
        workerId: request.headers.get("x-worker-id"),
        requestId: request.headers.get("x-request-id"),
        path: url.pathname,
      });
    }

    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      server.addEventListener("message", (evt) => {
        const data = typeof evt.data === "string" ? evt.data : "<binary>";
        if (data === "bye") {
          server.close(1000, "bye");
          return;
        }
        server.send("echo:" + data);
      });
      server.addEventListener("close", () => {
        console.log("ws-echo: server close");
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/stream") {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 10; i++) {
            controller.enqueue(enc.encode(`data: chunk ${i} @ ${Date.now()}\n\n`));
            await new Promise((r) => setTimeout(r, 150));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }

    if (path === "/wait") {
      const enc = new TextEncoder();
      const { promise: outcome, resolve: resolveOutcome } = Promise.withResolvers();
      // Register waitUntil up-front; scheduling from inside cancel races
      // IoContext teardown and the side effect may not complete.
      ctx.waitUntil((async () => {
        const state = await outcome;
        console.log(`ws-echo: /wait outcome=${state}`);
      })());
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(enc.encode("ready\n"));
          for (let i = 0; i < 600; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try { controller.enqueue(enc.encode(`tick:${i}\n`)); }
            catch { resolveOutcome("enqueue-threw"); return; }
          }
          try { controller.close(); } catch {}
          resolveOutcome("ended-normally");
        },
        cancel() { resolveOutcome("cancel"); },
      });
      return new Response(stream, { headers: { "content-type": "text/plain" } });
    }

    return new Response("not found", { status: 404 });
  },
};
