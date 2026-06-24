# Contributing

Thanks for your interest in WDL. This repository uses the Apache License, Version 2.0.
Unless you explicitly say otherwise, contributions intentionally submitted for this
project are licensed under Apache-2.0 without extra terms or conditions.

No copyright assignment, CLA, or DCO sign-off is required for ordinary contributions.

## Before You Start

For architecture and review expectations, read:

- [Architecture](docs/architecture.md)
- [Project standards](docs/project-standards.md)
- [Contributor reading path](docs/contributing.md)
- [Testing contract](docs/testing.md)

`CLAUDE.md` is an agent and maintainer checklist. It is useful context, but it is not
the first-stop contributor guide.

## Pull Requests

- Keep changes scoped to one behavior, protocol, infrastructure, or refactor boundary.
- Update the owning active docs when behavior, Redis ownership, deployment shape, or
  protocol contracts change.
- Keep English and Chinese active docs aligned when touching paired docs.
- Add or update tests for changed behavior and known drift patterns.
- Do not include generated archives, local credentials, local Docker state, or private
  deployment inventory.

Run the smallest meaningful checks locally. For JavaScript-only changes this is usually:

```bash
npm run lint
npm run test:unit
```

For Rust changes, also run the relevant Cargo checks from `rust/`.

## Integration Tests

Local Docker Compose integration runs need Docker and the WDL CLI. CI-hosted
integration uses Docker Hub and Docker Build Cloud credentials for remote image builds.
Pull requests do not run the full integration suite by default. Maintainers run or opt
into integration tests on trusted branches before release-sensitive changes merge.

See [Testing](docs/testing.md) for local integration setup and CI behavior.
