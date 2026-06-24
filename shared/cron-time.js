// Cron time helpers used by control for promote-time slot placement.
// Scheduler advancement lives in Rust croner and treats Redis cron hashes as
// the authority when repairing slot projections. JS stays on croner too so the
// two sides share one parser family, with parity fixtures pinning edge cases.
import { Cron } from "croner";

/** @param {string} cron @param {string} timezone */
export function parseCron(cron, timezone) {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields, got ${parts.length}`);
  }
  if (parts.some((part) => part.includes(":"))) {
    throw new Error("cron expression fields must not contain ':'");
  }
  return new Cron(cron, { timezone, mode: "5-part" });
}

// Throws on invalid expression — upstream validator should have caught it.
/**
 * @param {string} cron
 * @param {string} timezone
 * @param {number} afterMs
 * @returns {number}
 */
export function nextFireMs(cron, timezone, afterMs) {
  const next = parseCron(cron, timezone).nextRun(new Date(afterMs));
  if (!next) throw new Error(`cron has no next fire time: ${cron}`);
  return next.getTime();
}

/**
 * @param {number} ms
 * @returns {number}
 */
export function slotMsFor(ms) {
  return Math.floor(ms / 60_000) * 60_000;
}
