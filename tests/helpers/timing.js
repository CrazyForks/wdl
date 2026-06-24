/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} label
 * @param {() => boolean | Promise<boolean | undefined | void>} check
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 */
export async function waitUntil(label, check, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  /** @type {unknown} */
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr instanceof Error ? `: ${lastErr.message}` : ""}`);
}
