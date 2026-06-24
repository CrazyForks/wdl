// Producer fixture — POST any JSON body or `?delay=<seconds>&n=<count>` to
// enqueue. With no body, sends one message with a synthetic payload.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const delay = Number(url.searchParams.get("delay") ?? 0);
    const n = Math.max(1, Number(url.searchParams.get("n") ?? 1));

    // Buffer the body once — reading via .json() consumes the stream even
    // when parsing fails, so a subsequent .text() would throw.
    let payload;
    const raw = req.method === "POST" ? await req.text() : "";
    if (raw) {
      try { payload = JSON.parse(raw); }
      catch { payload = raw; }
    } else {
      payload = { hello: "queue", at: Date.now() };
    }

    if (n === 1) {
      await env.SMOKE_Q.send(payload, delay > 0 ? { delaySeconds: delay } : undefined);
    } else {
      const batch = Array.from({ length: n }, (_, i) => ({
        body: typeof payload === "object" ? { ...payload, i } : `${payload}#${i}`,
        ...(delay > 0 ? { delaySeconds: delay } : {}),
      }));
      await env.SMOKE_Q.sendBatch(batch);
    }

    return Response.json({ ok: true, enqueued: n, delaySeconds: delay });
  },
};
