// Tests needing richer framework behavior (JSRPC dispatch, etc.) inline
// their own.

import { moduleDataUrl } from "../load-shared-module.js";

export const CLOUDFLARE_WORKERS_URL = moduleDataUrl(`
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`);
