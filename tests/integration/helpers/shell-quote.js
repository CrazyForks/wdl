/** @param {string} value */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
