// Provides both `metrics` and `recordBindingOperation` so a single rewrite
// covers the two import shapes. Tests that drive metric spies inline their
// own variant.

import { moduleDataUrl } from "../load-shared-module.js";

export const RUNTIME_METRICS_NOOP_URL = moduleDataUrl(`
export const metrics = {
  increment() {},
  observe() {},
  setGauge() {},
};
export async function recordBindingOperation(_service, _binding, _operation, fn) {
  return await fn();
}
`);
