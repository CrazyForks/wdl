export default {
  async fetch(request, env) {
    const [cssUrl, logoUrl] = await Promise.all([
      env.ASSETS.url("style.css"),
      env.ASSETS.url("hello.txt"),
    ]);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>pages-assets demo</title>
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body>
  <h1>Hello from pages-assets</h1>
  <p>Static file lives on the CDN, not inside the worker bundle.</p>
  <p>Fetch it directly: <a href="${logoUrl}">${logoUrl}</a></p>
</body>
</html>`;

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
