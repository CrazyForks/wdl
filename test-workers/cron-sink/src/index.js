export default {
  async fetch(req, env) {
    if (req.method === "GET") {
      const list = await env.KV.list();
      const rows = await Promise.all(
        list.keys.map(async (k) => ({
          key: k.name,
          value: JSON.parse(await env.KV.get(k.name)),
        }))
      );
      return Response.json({ count: rows.length, rows });
    }
    const { slot, cron } = await req.json();
    await env.KV.put(String(slot), JSON.stringify({
      slot, cron, storedAt: Date.now(),
    }));
    return Response.json({ ok: true, key: String(slot) });
  },
};
