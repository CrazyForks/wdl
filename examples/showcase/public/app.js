const form = document.getElementById("f");
const list = document.getElementById("msgs");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function render(msgs) {
  if (!msgs.length) {
    list.innerHTML = `<li class="empty">Be the first to leave a message.</li>`;
    return;
  }
  list.innerHTML = msgs.map((m) => `
    <li>
      <div class="meta"><b>${esc(m.name)}</b> <time>${esc(m.ts)}</time></div>
      <div class="body">${esc(m.text)}</div>
    </li>`).join("");
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const fd = new FormData(form);
    const res = await fetch("post", { method: "POST", body: fd });
    if (!res.ok) throw new Error("post failed: " + res.status);
    form.reset();
    const msgs = await (await fetch("api/messages")).json();
    render(msgs);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});
