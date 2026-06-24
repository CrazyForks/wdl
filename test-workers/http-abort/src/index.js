export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/poll")) {
      const key = url.searchParams.get("key");
      const v = await env.MARKER.get(key);
      return new Response(v == null ? "__null__" : v);
    }
    const key = url.searchParams.get("key");
    const { promise: outcome, resolve: resolveOutcome } = Promise.withResolvers();
    ctx.waitUntil((async () => {
      const state = await outcome;
      await env.MARKER.put(key, state);
    })());

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(enc.encode("first\n"));
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 200));
          try {
            controller.enqueue(enc.encode("tick:" + i + "\n"));
          } catch (e) {
            resolveOutcome("enqueue-threw");
            return;
          }
        }
        try { controller.close(); } catch {}
        resolveOutcome("ended-normally");
      },
      cancel() { resolveOutcome("cancel"); },
    });
    return new Response(stream, { headers: { "content-type": "text/plain" } });
  },
};
