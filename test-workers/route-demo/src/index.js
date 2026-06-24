// Reflects the request URL so the test can verify the pattern branch
// forwards the full path without rewrite. `matched` echoes the slot the
// gateway dispatched through (via x-worker-prefix) to disambiguate which
// route was picked.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      worker: "route-demo",
      host: url.hostname,
      path: url.pathname,
      query: url.search,
      matched: request.headers.get("x-worker-prefix") || null,
    });
  },
};
