/**
 * Parse every metric line in a Prometheus text body into a flat map.
 * Skips comment lines and empty lines. Each key is the full metric line
 * up to the last space (including label braces if present).
 *
 * @param {string} body
 * @returns {Map<string, number>}
 */
export function parseCounters(body) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.lastIndexOf(" ");
    if (idx < 0) continue;
    const value = Number(line.slice(idx + 1));
    if (Number.isFinite(value)) map.set(line.slice(0, idx), value);
  }
  return map;
}

/**
 * Look up a single Prometheus counter by metric name and exact label set.
 * Returns the numeric value, or 0 when the metric is absent.
 *
 * @param {string} body
 * @param {string} name
 * @param {Record<string, string>} labels
 * @returns {number}
 */
export function prometheusCounter(body, name, labels) {
  const expectedLabels = Object.entries(labels).toSorted(([a], [b]) => a.localeCompare(b));
  for (const line of body.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([0-9.eE+-]+)$/);
    if (!match) continue;
    const actualLabels = Object.fromEntries(
      match[2].split(",").map((/** @type {string} */ part) => {
        const [key, rawValue] = part.split("=");
        return [key, rawValue.slice(1, -1)];
      })
    );
    if (
      expectedLabels.every(([key, value]) => actualLabels[key] === value) &&
      Object.keys(actualLabels).length === expectedLabels.length
    ) {
      return Number(match[3]);
    }
  }
  return 0;
}
