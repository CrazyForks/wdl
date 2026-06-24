import { WorkerEntrypoint } from "cloudflare:workers";

export class Echo extends WorkerEntrypoint {
  async echo(...args) {
    return {
      args,
      callerNs: this.ctx.props.callerNs,
      callerSecrets: this.ctx.props.callerSecrets ?? null,
    };
  }

  async boom(msg = "demo-error") {
    throw new Error(msg);
  }

  async probe() {
    return {
      envKeys: Object.keys(this.env).toSorted(),
      propsKeys: Object.keys(this.ctx.props).toSorted(),
    };
  }
}

export class Ops extends WorkerEntrypoint {
  async whoami() {
    return {
      entrypoint: "Ops",
      callerNs: this.ctx.props.callerNs,
    };
  }
}

export default {
  fetch() {
    return new Response("platform-demo is JSRPC-only", { status: 404 });
  },
};
