using Workerd = import "/workerd/workerd.capnp";
using Base = import "config.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .Base.gatewayWorker),

    # Local/integration mesh simulation: production uses AWS Service
    # Connect, while compose routes the same component-to-component HTTP
    # calls through the local Envoy service.
    (name = "runtime-user",   external = (address = "envoy:18081", http = ())),
    (name = "runtime-system", external = (address = "envoy:18082", http = ())),
    (name = "control-ext",    external = (address = "envoy:18083", http = ())),

    # Redis stays direct in local because production Valkey is not behind
    # Service Connect.
    (name = "network", network = (
      allow = ["private", "public"],
      tlsOptions = (trustBrowserCas = true),
    )),
  ],

  sockets = [
    (name = "http", address = "*:8080", http = (), service = "gateway"),
  ],
);
