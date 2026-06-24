const SCHEMA = `
create table if not exists inspections (
  id text primary key,
  image_key text not null,
  image_name text not null,
  image_type text not null,
  image_size integer not null,
  comment text not null,
  created_at text not null
)`;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorJson(error, message, init) {
  return json({ error, message }, init);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFileName(name) {
  return String(name || "upload")
    .replace(/[/\\]/g, "-")
    .replace(/[^\w. -]/g, "")
    .trim()
    .slice(0, 80) || "upload";
}

async function ensureSchema(env) {
  await env.DB.exec(SCHEMA);
}

async function incrementCounter(env, key) {
  const raw = await env.COUNTERS.get(key);
  const current = counterValue(raw);
  const next = current + 1;
  await env.COUNTERS.put(key, String(next));
  return next;
}

/** @param {string | null} value */
function counterValue(value) {
  if (value == null) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function counters(env) {
  const [visits, submissions] = await Promise.all([
    env.COUNTERS.get("visits"),
    env.COUNTERS.get("submissions"),
  ]);
  return {
    visits: counterValue(visits),
    submissions: counterValue(submissions),
  };
}

function rowToInspection(row) {
  return {
    id: row.id,
    imageKey: row.image_key,
    imageName: row.image_name,
    imageType: row.image_type,
    imageSize: row.image_size,
    imageUrl: `images/${encodeURIComponent(row.image_key)}`,
    comment: row.comment,
    createdAt: row.created_at,
  };
}

async function listInspections(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(`
    select id, image_key, image_name, image_type, image_size, comment, created_at
    from inspections
    order by created_at desc
    limit 30
  `).all();
  return results.map(rowToInspection);
}

async function createInspection(request, env) {
  await ensureSchema(env);
  const form = await request.formData();
  const image = form.get("image");
  const comment = String(form.get("comment") || "").trim();

  if (!(image instanceof File)) {
    return errorJson("invalid_request", "image is required", { status: 400 });
  }
  if (!image.type.startsWith("image/")) {
    return errorJson("invalid_request", "image must be an image/* file", { status: 400 });
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return errorJson("invalid_request", "image must be 25 MiB or smaller", { status: 400 });
  }
  if (!comment) {
    return errorJson("invalid_request", "comment is required", { status: 400 });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const imageName = safeFileName(image.name);
  // R2 overwrites by key; the UUID segment keeps same-name uploads separate.
  const imageKey = `inspections/${id}/${imageName}`;

  await env.IMAGES.put(imageKey, image.stream(), {
    httpMetadata: {
      contentType: image.type,
      cacheControl: "private, max-age=300",
    },
    customMetadata: {
      inspectionId: id,
      originalName: image.name || imageName,
    },
  });

  try {
    await env.DB.prepare(`
      insert into inspections
        (id, image_key, image_name, image_type, image_size, comment, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, imageKey, imageName, image.type, image.size, comment, createdAt).run();
  } catch (err) {
    await env.IMAGES.delete(imageKey).catch(() => {});
    throw err;
  }

  await incrementCounter(env, "submissions");
  const inspectionRow = {
    id,
    image_key: imageKey,
    image_name: imageName,
    image_type: image.type,
    image_size: image.size,
    comment,
    created_at: createdAt,
  };
  return json({
    inspection: rowToInspection(inspectionRow),
    counters: await counters(env),
  }, { status: 201 });
}

async function imageResponse(env, encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", obj.httpMetadata.cacheControl || "private, max-age=300");
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

async function page(env) {
  const [cssUrl, jsUrl] = await Promise.all([
    env.ASSETS.url("style.css"),
    env.ASSETS.url("app.js"),
  ]);
  await incrementCounter(env, "visits");

  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>巡检图片记录</title>
  <link rel="stylesheet" href="${escapeHtml(cssUrl)}">
</head>
<body>
  <main class="shell">
    <section class="panel compose">
      <div class="intro">
        <p class="eyebrow">Inspection Demo</p>
        <h1>巡检图片记录</h1>
        <p class="lede">上传现场图片和备注，图片写入 R2，记录写入 D1，访问和提交计数写入 KV。</p>
      </div>

      <form id="inspection-form" class="form">
        <label class="file-picker">
          <input id="image" name="image" type="file" accept="image/*" required>
          <span class="file-copy">
            <span>巡检图片</span>
            <strong id="file-name">未选择文件</strong>
          </span>
          <span class="file-button">选择图片</span>
        </label>
        <label class="field">
          <span>Comments</span>
          <textarea name="comment" rows="4" maxlength="600" required
            placeholder="例如：东侧机房门禁正常，温湿度读数稳定。"></textarea>
        </label>
        <div class="actions">
          <button type="submit">提交巡检</button>
          <span id="status" role="status"></span>
        </div>
      </form>
    </section>

    <section class="stats" aria-label="Counters">
      <div><span id="visit-count">0</span><small>visits</small></div>
      <div><span id="submit-count">0</span><small>submissions</small></div>
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>最新巡检</h2>
        <button id="refresh" type="button">刷新</button>
      </div>
      <div id="list" class="list"></div>
    </section>
  </main>
  <script type="module" src="${escapeHtml(jsUrl)}"></script>
</body>
</html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return page(env);
      }
      if (request.method === "GET" && url.pathname === "/api/inspections") {
        return json({ inspections: await listInspections(env), counters: await counters(env) });
      }
      if (request.method === "POST" && url.pathname === "/api/inspections") {
        return createInspection(request, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/images/")) {
        return imageResponse(env, url.pathname.slice("/images/".length));
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(JSON.stringify({
        service: "inspection-demo",
        event: "request_failed",
        error: err instanceof Error ? err.message : String(err),
      }));
      return errorJson("internal_error", "internal error", { status: 500 });
    }
  },
};
