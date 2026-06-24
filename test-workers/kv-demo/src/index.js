// kv-demo — vanilla Cloudflare Worker. Written once, deployable to CF or to
// this platform via wdl deploy. The env.VISITS binding resolves to either
// Cloudflare KV (prod) or our Redis-backed KV shim (here) — user code is the
// same either way.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const segs = url.pathname.split("/").filter(Boolean);
    const name = segs[0] || "visitor";

    const raw = await env.VISITS.get(name);
    const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
    const current = Number.isFinite(parsed) ? parsed : 0;
    const next = current + 1;
    await env.VISITS.put(name, String(next));

    const { keys } = await env.VISITS.list({ limit: 20 });
    const leaderboard = await Promise.all(
      keys.map(async (k) => [k.name, parseInt(await env.VISITS.get(k.name), 10)])
    );
    const sortedLeaderboard = leaderboard.toSorted((a, b) => b[1] - a[1]);

    return Response.json({
      greeting: env.GREETING,
      you: name,
      visits: next,
      leaderboard: Object.fromEntries(sortedLeaderboard),
    });
  },
};
