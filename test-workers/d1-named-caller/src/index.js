export default {
  async fetch(request, env) {
    await env.API.init();
    const batch = await env.API.add("named-1", "from-named");
    const row = await env.API.get("named-1");
    const viaFetchResponse = await env.API.fetch(new Request(request));
    const viaFetch = await viaFetchResponse.json();
    return Response.json({ batch, row, viaFetch });
  }
};