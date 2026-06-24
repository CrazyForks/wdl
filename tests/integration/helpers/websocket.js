// Minimal RFC 6455 framing for integration tests. Keeping this local avoids
// adding `ws` just to verify platform upgrade paths.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { ROOT, GATEWAY_HOST, GATEWAY_PORT } from "./env.js";
import { runProbeNode } from "./compose.js";
import { parseJsonText, parseStdoutJson } from "./json-payload.js";

const INTERNAL_AUTH_HEADER = "x-wdl-internal-auth";
const INTERNAL_AUTH_TOKEN = process.env.WDL_INTERNAL_AUTH_TOKEN || "local-internal-auth-token";

/** @param {Record<string, string>} headers */
function internalWebSocketHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = { ...headers };
  const hasInternalAuth = Object.keys(out).some((key) => key.toLowerCase() === INTERNAL_AUTH_HEADER);
  if (!hasInternalAuth) out[INTERNAL_AUTH_HEADER] = INTERNAL_AUTH_TOKEN;
  return out;
}

/** @param {string} text */
export function encodeClientTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  if (len >= 126) throw new Error("test websocket helper only handles short payloads");
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | len]);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

export function encodeClientCloseFrame(code = 1000, reason = "") {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  if (payload.length >= 126) throw new Error("test websocket helper only handles short close payloads");
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x88, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// TCP doesn't guarantee one `data` event == one WebSocket frame; accumulate
// chunks until the short-form length fits.
/** @param {import("node:net").Socket} socket @param {{ timeoutMs?: number }} [opts] */
export function readOneServerTextFrame(socket, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for frame (have ${buf.length} bytes)`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    }
    /** @param {unknown} err */
    function onError(err) { cleanup(); reject(err); }
    function onEnd() { cleanup(); reject(new Error("socket ended before full frame")); }
    /** @param {Buffer} chunk */
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      if (opcode !== 0x1) { cleanup(); reject(new Error(`expected text frame, got opcode ${opcode}`)); return; }
      if (masked) { cleanup(); reject(new Error("server frames must be unmasked")); return; }
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        cleanup();
        reject(new Error("test websocket helper does not handle 64-bit payload lengths"));
        return;
      }
      const need = offset + len;
      if (buf.length < need) return;
      const text = buf.slice(offset, need).toString("utf8");
      cleanup();
      if (buf.length > need) {
        reject(new Error(`unexpected trailing ${buf.length - need} bytes after frame`));
        return;
      }
      resolve(text);
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  });
}

/** @param {string} text @param {string} [label] @returns {any} */
export function frameJson(text, label = "WebSocket text frame") {
  return parseJsonText(text, label);
}

/** @param {import("node:net").Socket} socket @param {{ timeoutMs?: number, label?: string }} [opts] */
export async function readJsonServerFrame(socket, { timeoutMs = 5000, label = "WebSocket text frame" } = {}) {
  return frameJson(await readOneServerTextFrame(socket, { timeoutMs }), label);
}

/** @param {import("node:net").Socket} socket @param {{ timeoutMs?: number }} [opts] */
export function readOneServerCloseFrame(socket, { timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for close frame (have ${buf.length} bytes)`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    }
    /** @param {unknown} err */
    function onError(err) { cleanup(); reject(err); }
    function onEnd() { cleanup(); reject(new Error("socket ended before close frame")); }
    /** @param {Buffer} chunk */
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      const len = buf[1] & 0x7f;
      if (opcode !== 0x8) { cleanup(); reject(new Error(`expected close frame, got opcode ${opcode}`)); return; }
      if (masked) { cleanup(); reject(new Error("server close frames must be unmasked")); return; }
      if (len >= 126) { cleanup(); reject(new Error("test websocket helper only handles short close frames")); return; }
      const need = 2 + len;
      if (buf.length < need) return;
      const payload = buf.slice(2, need);
      cleanup();
      if (buf.length > need) {
        reject(new Error(`unexpected trailing ${buf.length - need} bytes after close frame`));
        return;
      }
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
      const reason = payload.length > 2 ? payload.slice(2).toString("utf8") : "";
      resolve({ code, reason });
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  });
}

/** @param {string} ns @param {string} pathWithQuery */
export function wsHandshake(ns, pathWithQuery) {
  return wsHandshakeWithHost(`${ns}.workers.local`, pathWithQuery);
}

/** @param {string} host @param {string} pathWithQuery */
export function hostWsHandshake(host, pathWithQuery) {
  return wsHandshakeWithHost(host, pathWithQuery);
}

/** @param {string} hostHeader @param {string} pathWithQuery */
function wsHandshakeWithHost(hostHeader, pathWithQuery) {
  const key = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: GATEWAY_HOST,
      port: GATEWAY_PORT,
      method: "GET",
      path: pathWithQuery,
      headers: {
        Host: hostHeader,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
      agent: false,
    });
    req.on("upgrade", (res, socket, head) => {
      resolve({ status: res.statusCode, headers: res.headers, socket, head });
    });
    req.on("response", (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        reject(Object.assign(
          new Error(`expected 101, got ${res.statusCode}`),
          { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") },
        ));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * @param {string} host
 * @param {number} port
 * @param {string} pathWithQuery
 * @param {Record<string, string>} headers
 * @param {string} message
 */
export function serviceWebSocketRoundTrip(host, port, pathWithQuery, headers, message) {
  const rewritten = Buffer.from(JSON.stringify({
    host,
    port,
    path: pathWithQuery,
    headers: internalWebSocketHeaders(headers),
    message,
  })).toString("base64");
  const script = readFileSync(path.join(ROOT, "tests/integration/helpers/ws-roundtrip-runner.cjs"), "utf8");
  const out = runProbeNode(script, { env: { WDL_WS_REQ: rewritten } });
  const parsed = parseStdoutJson(out, "internal websocket round trip stdout");
  if (parsed.error) throw new Error(`internal websocket round trip failed: ${parsed.error}`);
  return parsed;
}
