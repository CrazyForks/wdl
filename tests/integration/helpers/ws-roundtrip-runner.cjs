const crypto = require("crypto");
const net = require("net");

if (!process.env.WDL_WS_REQ) throw new Error("WDL_WS_REQ is required");

/** @type {{ host: string, port: number, path: string, message: string, headers?: Record<string, string> }} */
const input = JSON.parse(Buffer.from(process.env.WDL_WS_REQ, "base64").toString("utf8"));

/** @param {string} text */
function encodeClientTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length >= 126) throw new Error("test websocket helper only handles short payloads");
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** @param {string} raw */
function parseHeaders(raw) {
  const lines = raw.split("\r\n");
  const status = Number((lines[0].match(/^HTTP\/1\.1\s+(\d+)/) || [])[1] || 0);
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return { status, headers };
}

/** @param {Buffer} buf */
function parseTextFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  const len = buf[1] & 0x7f;
  if (opcode !== 0x1) throw new Error(`expected text frame, got opcode ${opcode}`);
  if (masked) throw new Error("server frames must be unmasked");
  if (len >= 126) throw new Error("test websocket helper only handles short payloads");
  if (buf.length < 2 + len) return null;
  return buf.slice(2, 2 + len).toString("utf8");
}

let done = false;
const socket = net.connect(input.port, input.host);
const timer = setTimeout(() => finish(3, { error: "timeout" }), 5000);
let buffer = Buffer.alloc(0);
let upgraded = false;

/** @param {number} code @param {Record<string, unknown>} payload */
function finish(code, payload) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  socket.destroy();
  process.stdout.write(JSON.stringify(payload));
  process.exit(code);
}

socket.on("connect", () => {
  const key = crypto.randomBytes(16).toString("base64");
  const headers = {
    Host: input.host,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
    ...(input.headers || {}),
  };
  const request = [
    `GET ${input.path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
  socket.write(request);
});

socket.on("data", (chunk) => {
  try {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buffer.slice(0, end).toString("utf8");
      const parsed = parseHeaders(head);
      buffer = buffer.slice(end + 4);
      if (parsed.status !== 101) {
        finish(0, { status: parsed.status, headers: parsed.headers, body: buffer.toString("utf8") });
        return;
      }
      upgraded = true;
      socket.write(encodeClientTextFrame(input.message));
    }
    const frame = parseTextFrame(buffer);
    if (frame === null) return;
    finish(0, { status: 101, frameText: frame });
  } catch (err) {
    finish(2, { error: err instanceof Error ? err.message : String(err) });
  }
});
socket.on("error", (err) => finish(2, { error: err.message }));
socket.on("end", () => finish(2, { error: "socket ended before frame" }));
