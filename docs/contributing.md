# Contributor Reading Path

This document is the practical reading path for contributors and reviewers. It does
not replace module docs or tests; it tells you which contract to read before touching a
given part of WDL.

## License And Contributions

WDL is licensed under the Apache License, Version 2.0. Unless you explicitly state
otherwise, any contribution intentionally submitted for inclusion in this project by
you, as defined in the Apache-2.0 license, is licensed under Apache-2.0 without any
additional terms or conditions.

No copyright assignment is required for ordinary contributions.

## First Pass

Read these in order before making cross-module changes:

1. `docs/architecture.md` for service, state, trust-boundary, and rollout shape.
2. `docs/security.md` for trust zones and private mesh assumptions.
3. `docs/project-standards.md` for cross-language error, observability, validation,
   and review rules.
4. `docs/protocol-contracts.md` for schema, payload, binding registry, and
   state-machine protocol direction.
5. `docs/source-map.md` to locate the owning source tree.
6. The owning module doc under `docs/modules/`.
7. `docs/testing.md` for the smallest meaningful check and the PR/integration gate.
8. `CLAUDE.md` for the short agent and maintainer invariant checklist.

## Change Playbooks

### Control Route Or Admin API

Read `docs/modules/control-auth.md`, `docs/project-standards.md`, and
`docs/protocol-contracts.md`. Update `parseControlRoute()`, auth action mapping, the
handler, the error/return contract, docs, and behavior tests together. Do not infer
permission from URL prefixes inside handlers.

Run unit tests for control helpers and route/error shape. Run targeted control/auth or
gateway integration when route reachability, auth, lifecycle, deploy, promote, delete,
or host behavior changes.

### Runtime Binding Or Bundle Metadata

Read `docs/modules/runtime.md`, `docs/protocol-contracts.md`, and the specific binding
module doc if one exists. A binding change must account for deploy validation, bundle
metadata, runtime env materialization, hidden backend bindings, wrapper behavior,
tenant-visible facade shape, docs, and tests.

Do not add another local switch branch without deciding whether it belongs in a
binding registry entry. Run runtime/load unit tests, facade tests, and targeted
integration for the affected binding.

### Redis Key Or Payload

Read `docs/redis-key-layout.md` and `docs/protocol-contracts.md`. Redis keys should go
through shared helpers; payloads need one writer owner and documented readers. Indexes
and projections should name the authoritative record and stale cleanup path.

Run the source-scan drift guard plus behavior tests for every writer/reader pair. Run
targeted integration whenever Redis state shape affects runtime behavior.

### D1, DO, Scheduler, Or Workflows State Machine

Read the owning module doc, `docs/protocol-contracts.md`, and
`docs/rust-sidecar-standards.md` when Rust is involved. Identify the generation,
lease, token, WATCH, or run-token fence before editing. Add model-ish or
failure-injection tests when the change touches stale writers, owner handoff, retry,
drain, due indexes, or lifecycle blockers.

Run crate-local Rust tests and the smallest integration file that crosses the service
boundary. Run full integration before commit-ready if Redis shape or runtime behavior
changed.

### Observability

Read `docs/modules/log-tail-observability.md` and `docs/project-standards.md`. Logs
carry snake_case diagnostic context; metrics carry only bounded labels. Renaming a log
field, event, metric family, or label is a contract change and must update docs and
tests in the same boundary.

### Infrastructure Or Delivery

Read `docs/modules/infra.md`, `docs/security.md`, `docs/testing.md`, and the relevant
deployment manifest. Keep private service sockets private, preserve the image/runtime
contract, and update CI or runbook docs when validation paths change.

## Review Checklist

Before staging a change, verify:

- the owning active doc was updated when behavior, protocol, Redis ownership, or
  deployment shape changed;
- English and Chinese docs moved together;
- new payload shapes have one writer owner and documented consumers;
- hidden credentials, internal Fetchers, and internal auth headers stay non-tenant
  visible;
- error responses follow the owning protocol domain;
- logs and metrics keep their bounded-label and sensitive-data contract;
- tests cover the boundary that changed, not just the implementation line touched.

Use staged changes as the review boundary. If review feedback is wrong or not worth
the tradeoff, leave the code unchanged and explain the contract that makes it safe.
