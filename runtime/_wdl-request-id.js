/**
 * Resolve the request id options shared by loaded-isolate host facades.
 *
 * Provider-first is the runtime wrapper contract: a class-style entrypoint keeps
 * a stable env wrapper and swaps the current request id through the provider.
 *
 * @param {unknown} options
 * @param {{ providerFirst?: boolean }} [resolution]
 * @returns {string | null}
 */
export function requestIdFromOptions(options, { providerFirst = true } = {}) {
  if (!options || typeof options !== "object") return null;
  const record = /** @type {{ requestIdProvider?: unknown, requestId?: unknown }} */ (options);
  const fromProvider = () => {
    if (typeof record.requestIdProvider !== "function") return null;
    const id = record.requestIdProvider();
    return typeof id === "string" && id ? id : null;
  };
  const fromValue = () => typeof record.requestId === "string" && record.requestId ? record.requestId : null;
  return providerFirst ? fromProvider() || fromValue() : fromValue() || fromProvider();
}
