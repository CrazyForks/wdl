let active = 0;
let opened = 0;
let closed = 0;
let lastClose = null;

export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ active, opened, closed, lastClose });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    let finished = false;
    active += 1;
    opened += 1;
    server.accept();
    server.addEventListener("message", (evt) => {
      server.send("echo:" + evt.data);
    });
    server.addEventListener("close", (evt) => {
      if (finished) return;
      finished = true;
      active -= 1;
      closed += 1;
      lastClose = { code: evt.code, reason: evt.reason };
    });
    server.addEventListener("error", () => {
      if (finished) return;
      finished = true;
      active -= 1;
      closed += 1;
      lastClose = { code: null, reason: "error" };
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
