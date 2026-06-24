export default {
  fetch() {
    return new Response("cron-writer alive — fires every minute via scheduled()\n");
  },
  async scheduled(controller, env) {
    const body = JSON.stringify({
      slot: controller.scheduledTime,
      cron: controller.cron,
    });
    await env.SINK.fetch(new Request("http://sink/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
  },
};
