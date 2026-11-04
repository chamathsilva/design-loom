# Design Loom

Design Loom is a GitHub Copilot plugin with a bundled CLI. It helps teams turn requirements into engineering designs, QA test designs and scoped coding-agent handoffs, while keeping shared project context traceable in Git.

**Status:** early implementation. Milestone M1 (backlog B00–B06) is in progress. Nothing here is usable as a plugin yet.

## Design source

This code implements the Design Loom implementation design package, edition 0.1.0, which lives next to this repository at `../Design-Loom-Implementation-Design/`. It is the source of truth for behaviour; this repository records which revision it follows.

| | |
|---|---|
| Design package revision | `SHA256SUMS.txt` sha256 `0d9f1f38afa5a564a1004681df38492068052a6c8ba221c0a85e8e6203c8a4e5` |
| Authorized scope | M1 only: B00 (app-route spike) and B01–B06 |

If the code and the design disagree, record the discrepancy and resolve it in the design package before building incompatible behaviour.

## Repository layout

| Path | Contents |
|---|---|
| `packages/config` | Application profile, framework lock and effective-configuration resolution |
| `packages/artifacts` | Artifact and source records, scopes, digests and the reference graph |
| `packages/workflow` | Advisory workflows and independent maturity/status |
| `packages/validation` | Rule engine and template descriptors |
| `packages/baseline` | Optional reviewed baselines and lineage |
| `packages/handoff` | Snapshot handoff packaging and verification |
| `packages/integrations` | Provider adapters (the only package that talks to external services) |
| `packages/cli` | Command surface used by skills and CI |
| `tests/` | Unit, integration, fixture and acceptance tests |
| `docs/` | Maintainer and contributor documentation |

The plugin itself (`plugins/design-loom/`) and the marketplace catalog arrive in later milestones.

## Getting started

See [docs/development.md](docs/development.md).
