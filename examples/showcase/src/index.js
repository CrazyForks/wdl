const MSG_KEY = "messages";
const VISITS_KEY = "visits";
const MAX_MSGS = 20;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function readMessages(env) {
  const raw = await env.DB.get(MSG_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function bumpVisits(env) {
  const raw = await env.DB.get(VISITS_KEY);
  const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
  const current = Number.isFinite(parsed) ? parsed : 0;
  const n = current + 1;
  await env.DB.put(VISITS_KEY, String(n));
  return n;
}

async function renderIndex(env, workerId) {
  const [msgs, visits] = await Promise.all([readMessages(env), bumpVisits(env)]);
  const [cssUrl, jsUrl] = await Promise.all([
    env.ASSETS.url("style.css"),
    env.ASSETS.url("app.js"),
  ]);

  const items = msgs.length
    ? msgs.map((m) => `
        <li>
          <div class="meta"><b>${esc(m.name)}</b> <time>${esc(m.ts)}</time></div>
          <div class="body">${esc(m.text)}</div>
        </li>`).join("")
    : `<li class="empty">Be the first to leave a message.</li>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(env.SITE_TITLE)}</title>
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body>
  <main>
    <header>
      <h1>${esc(env.SITE_TITLE)}</h1>
      <p class="sub">Served by <code>${esc(workerId)}</code> · total visits: <b>${visits}</b></p>
    </header>

    <form id="f">
      <input name="name" placeholder="Your name" maxlength="40" required>
      <textarea name="text" placeholder="Your message" maxlength="280" rows="3" required></textarea>
      <button type="submit">Post</button>
      <p class="hint">Stored in the KV binding (backed by Valkey). Last ${MAX_MSGS} kept.</p>
    </form>

    <ul id="msgs">${items}</ul>
  </main>
  <script src="${jsUrl}" defer></script>
</body>
</html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const workerId = req.headers.get("x-worker-id") || "unknown";

    if (req.method === "POST" && url.pathname.endsWith("/post")) {
      const form = await req.formData();
      const name = String(form.get("name") || "").trim().slice(0, 40);
      const text = String(form.get("text") || "").trim().slice(0, 280);
      if (!name || !text) {
        return new Response(JSON.stringify({
          error: "invalid_request",
          message: "name and text required",
        }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const msgs = await readMessages(env);
      msgs.unshift({ name, text, ts: new Date().toISOString() });
      const trimmed = msgs.slice(0, MAX_MSGS);
      await env.DB.put(MSG_KEY, JSON.stringify(trimmed));
      return new Response(JSON.stringify({ ok: true, count: trimmed.length }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.endsWith("/api/messages")) {
      const msgs = await readMessages(env);
      return new Response(JSON.stringify(msgs), {
        headers: { "content-type": "application/json" },
      });
    }

    const html = await renderIndex(env, workerId);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
