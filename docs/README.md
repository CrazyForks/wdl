# Documentation Index

This directory is the working home for project design and development-constraint
documentation. The current source code and tests remain authoritative; these docs
explain the implementation, the contracts it relies on, and the constraints future
changes must preserve.

## Start Here

- [Architecture overview](architecture.md) gives the high-level service, state,
  trust-boundary, and rollout map.
- [Security model](security.md) records the current trust zones, tenant/runtime
  boundaries, internal mesh assumptions, and infrastructure security contracts.
- [Workers compatibility matrix](compatibility.md) records supported, partial, and
  unsupported Workers surfaces.
- [Redis key layout](redis-key-layout.md) records the cross-module Valkey DB split,
  global control keys, and key ownership rules.
- [Protocol contracts](protocol-contracts.md) records the schema, payload, binding
  registry, state-machine test, and known-constraint runbook posture.
- [Source map](source-map.md) records the current source tree ownership map.
- [Module map](modules/README.md) lists the current module-level design docs and the
  source material for each module.
- [CLI and Wrangler input](modules/cli.md) records the `wdl` command surface,
  Wrangler config subset, and bundling contract.
- [Testing](testing.md) records the unit, typecheck, integration, and runner artifact
  contracts.
- [Contributor reading path](contributing.md) records which contracts to read before
  changing control routes, bindings, Redis payloads, state machines, observability, or
  delivery paths.
- [Project standards](project-standards.md) define cross-language conventions for
  contracts, security boundaries, observability, JS, Rust, tests, docs, and deployment
  code.
- [Workerd JavaScript standards](workerd-js-standards.md) define the JavaScript/workerd
  tier structure and testing standards.
- [Rust service and sidecar standards](rust-sidecar-standards.md) define the Rust
  structure and testing standards used by the Rust crates.

## Module Docs

See the [module map](modules/README.md) for the current module docs and the source
material used to refresh each one.

## Documentation Rules

- Keep English and Chinese docs at comparable depth for the same scope.
- Prefer design contracts over tutorials for internals: ownership, interfaces,
  Redis/storage keys, failure modes, rollout notes, observability, and tests.
- Batch documentation work by module or cross-cutting concern.
- Keep developer constraints close to the module they protect.
