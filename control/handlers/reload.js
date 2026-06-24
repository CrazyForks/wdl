import { jsonResponse, publishReload } from "control-shared";

/** @param {unknown} result */
function publishResultForResponse(result) {
  const record = result && typeof result === "object"
    ? /** @type {Record<string, unknown>} */ (result)
    : {};
  /** @type {{ ok: boolean, channel: string | null, durationMs: number, receivers?: number, error?: string }} */
  const out = {
    ok: Boolean(record.ok),
    channel: typeof record.channel === "string" ? record.channel : null,
    durationMs: Number.isFinite(record.duration_ms) ? Number(record.duration_ms) : 0,
  };
  if (typeof record.receivers === "number") out.receivers = record.receivers;
  if (typeof record.error === "string") out.error = record.error;
  return out;
}

/** @param {unknown} result */
function reloadResultForResponse(result) {
  const record = result && typeof result === "object"
    ? /** @type {Record<string, unknown>} */ (result)
    : {};
  return {
    ok: Boolean(record.ok),
    declarations: repairResultForResponse(record.declarations),
    routes: publishResultForResponse(record.routes),
    patterns: publishResultForResponse(record.patterns),
  };
}

/** @param {unknown} result */
function repairResultForResponse(result) {
  const record = result && typeof result === "object"
    ? /** @type {Record<string, unknown>} */ (result)
    : {};
  /** @type {{ ok: boolean, durationMs: number, declaredHosts?: number, declarationKeysRemoved?: number, error?: string }} */
  const out = {
    ok: Boolean(record.ok),
    durationMs: Number.isFinite(record.duration_ms) ? Number(record.duration_ms) : 0,
  };
  if (typeof record.declaredHosts === "number") out.declaredHosts = record.declaredHosts;
  if (typeof record.declarationKeysRemoved === "number") {
    out.declarationKeysRemoved = record.declarationKeysRemoved;
  }
  if (typeof record.error === "string") out.error = record.error;
  return out;
}

/** @param {{ requestId: string }} args */
export async function handle({ requestId }) {
  const publishResult = await publishReload(requestId);
  const status = publishResult.ok ? 200 : 502;
  return jsonResponse(status, { reload: reloadResultForResponse(publishResult) });
}
