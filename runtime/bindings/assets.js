// ASSETS binding shim — sibling to runtime/bindings/kv.js. prefix is
// pulled from __meta__.assets at load time so rollback flips URLs
// automatically.

import { WorkerEntrypoint } from "cloudflare:workers";
import { buildAssetUrl } from "runtime-lib";

export class Assets extends WorkerEntrypoint {
  /**
   * @param {unknown} path
   * @returns {string}
   */
  url(path) {
    const { cdnBase, prefix } = this.ctx.props;
    return buildAssetUrl(cdnBase, prefix, path);
  }
}
