// Consumer fixture — stashes every delivered queue message in KV keyed by
// msg.id, so `GET /` lists what arrived and `GET /?id=<msg-id>` prints
// the full record. `?id=poison` is the magic id that throws, exercising
// the retry + DLQ path end-to-end.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (id) {
      return Response.json(JSON.parse((await env.KV.get(id)) || "null"));
    }
    const list = await env.KV.list();
    return Response.json({
      count: list.keys.length,
      ids: list.keys.map((k) => k.name),
    });
  },
  async queue(batch, env) {
    for (const msg of batch.messages) {
      if (msg.id === "poison") {
        throw new Error("poison message — will retry until DLQ");
      }
      await env.KV.put(msg.id, JSON.stringify({
        id: msg.id,
        body: msg.body,
        attempts: msg.attempts,
        queue: batch.queue,
        timestamp: msg.timestamp instanceof Date ? msg.timestamp.getTime() : null,
        storedAt: Date.now(),
      }));
      msg.ack();
    }
  },
};
