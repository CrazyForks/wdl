/** @param {unknown} err */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
