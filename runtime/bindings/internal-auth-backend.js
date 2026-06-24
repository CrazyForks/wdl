import { WorkerEntrypoint } from "cloudflare:workers";
import { withInternalAuthEntries } from "shared-internal-auth";

const ALLOWED_BACKEND_BINDINGS = new Set([
  "DO_BACKEND",
  "DO_OWNER_NETWORK",
  "WORKFLOWS_BACKEND",
]);

/**
 * Cloneable host-side fetch capability for generated tenant facades.
 *
 * Loaded workers cannot receive plain objects with function properties in env.
 * This WorkerEntrypoint keeps the mesh token in the host binding realm and lets
 * workerd pass a JSRPC stub across the workerLoader boundary.
 */
export class InternalAuthBackend extends WorkerEntrypoint {
  /**
   * @param {RequestInfo | URL | string} input
   * @param {RequestInit} [init]
   */
  async fetch(input, init = undefined) {
    const binding = /** @type {{ binding?: unknown }} */ (this.ctx.props || {}).binding;
    if (typeof binding !== "string" || !ALLOWED_BACKEND_BINDINGS.has(binding)) {
      throw new Error("Internal auth backend binding is not configured");
    }
    const backend = this.env[binding];
    if (!backend || typeof /** @type {{ fetch?: unknown }} */ (backend).fetch !== "function") {
      throw new Error(`${binding} service binding is not configured`);
    }
    if (input instanceof Request) {
      const request = new Request(input, {
        ...init,
        headers: withInternalAuthEntries(init?.headers || input.headers, this.env),
      });
      return await /** @type {{ fetch(input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> }} */ (backend).fetch(request);
    }
    return await /** @type {{ fetch(input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> }} */ (backend).fetch(
      input,
      {
        ...init,
        headers: withInternalAuthEntries(init?.headers, this.env),
      }
    );
  }
}
