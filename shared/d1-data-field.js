/**
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
export function setDataField(target, key, value) {
  if (key !== "__proto__") {
    target[key] = value;
    return;
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
