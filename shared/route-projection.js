// Redis projection encoding for pattern-host route slots. Keep this value
// compact because gateway reads it on the hot path for every pattern-host miss.

export const PATTERN_PROJECTION_VERSION = "v2";
const SEP = "\t";

/**
 * @typedef {{ ns: string, worker: string, version: string, kind: "exact" | "prefix", value: string }} PatternProjection
 */

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function requireProjectionComponent(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.includes(SEP)) {
    throw new TypeError(`invalid pattern projection ${name}`);
  }
  return value;
}

/**
 * @param {PatternProjection} projection
 * @returns {string}
 */
export function encodePatternProjection(projection) {
  const ns = requireProjectionComponent("ns", projection.ns);
  const worker = requireProjectionComponent("worker", projection.worker);
  const version = requireProjectionComponent("version", projection.version);
  const kind = requireProjectionComponent("kind", projection.kind);
  const value = requireProjectionComponent("value", projection.value);
  if (kind !== "exact" && kind !== "prefix") {
    throw new TypeError("invalid pattern projection kind");
  }
  return [PATTERN_PROJECTION_VERSION, ns, worker, version, kind, value].join(SEP);
}

/**
 * @param {unknown} raw
 * @returns {PatternProjection | null}
 */
export function decodePatternProjection(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.split(SEP);
  if (parts.length !== 6 || parts[0] !== PATTERN_PROJECTION_VERSION) return null;
  const [, ns, worker, version, kind, value] = parts;
  if (
    ns.length === 0 ||
    worker.length === 0 ||
    version.length === 0 ||
    value.length === 0 ||
    (kind !== "exact" && kind !== "prefix")
  ) {
    return null;
  }
  return { ns, worker, version, kind, value };
}
