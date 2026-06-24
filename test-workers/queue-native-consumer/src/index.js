let lastBatch = null;
export default {
  async fetch() {
    if (!lastBatch) return new Response("{}");
    return Response.json({
      queue: lastBatch.queue,
      messages: lastBatch.messages.map((m) => ({
        id: m.id,
        attempts: m.attempts,
        timestampMs: m.timestamp instanceof Date ? m.timestamp.getTime() : null,
        bodyKind:
          m.body instanceof Uint8Array ? "bytes" :
          typeof m.body,
        bodyPreview:
          m.body instanceof Uint8Array ? Array.from(m.body) :
          m.body,
      })),
    });
  },
  async queue(batch) {
    lastBatch = {
      queue: batch.queue,
      messages: batch.messages.map((m) => ({
        id: m.id,
        attempts: m.attempts,
        timestamp: m.timestamp,
        body: m.body,
      })),
    };
    let anyExplicit = false;
    for (const msg of batch.messages) {
      if (msg.id === "ack-me")   { msg.ack();                      anyExplicit = true; }
      if (msg.id === "retry-me") { msg.retry({ delaySeconds: 5 }); anyExplicit = true; }
    }
    if (!anyExplicit) batch.ackAll();
  },
};
