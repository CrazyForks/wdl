// Echoes the request so the test can confirm the pattern route still serves.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      worker: "workers-dev-optout",
      host: url.hostname,
      path: url.pathname,
    });
  },
};
