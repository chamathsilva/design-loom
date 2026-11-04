# Contributing

Design Loom follows **GitHub Flow**: `main` is always releasable, and every change reaches it through a small pull request that passes CI.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Protected. Only changes through PRs with passing CI. No direct pushes, force pushes or deletion. |
| `<type>/<slug>` | Short-lived work branch, created from the latest `main` and deleted after merge |

Name work branches `<type>/<backlog-id>-<short-description>` in lower-case kebab case. Leave out the backlog ID when the work isn't a backlog item.

| Type | Use for | Example |
|---|---|---|
| `feat` | Backlog deliverables and new behaviour | `feat/b03-canonical-hashing` |
| `fix` | Bug fixes | `fix/b05-case-fold-collision` |
| `spike` | Throwaway experiments that are never merged as product code | `spike/b00-app-route` |
| `test` | Tests only | `test/b02-schema-fixtures` |
| `docs` | Documentation only | `docs/onboarding-guide` |
| `chore` | Tooling, CI and repository settings | `chore/repo-conventions` |
| `refactor` | Restructuring without behaviour change | `refactor/b07-rule-registry` |

There are no long-lived `develop` or release branches. Releases are tags on `main` (design doc 11).

## Pull requests

- **One backlog item per PR**, kept small enough to review in one sitting.
- **Title** uses [Conventional Commits](https://www.conventionalcommits.org/) with the backlog ID at the end, for example `feat(artifacts): canonical JSON and semantic digests (B03)`. The title becomes the squash-commit message on `main`.
- **Description** follows the PR template: what changed, which design sections it implements, and which checks actually ran.
- **Merging:** squash merge only, after CI passes on Linux, macOS and Windows. The branch is deleted automatically.
- **Review:** Claude reviews each PR automatically. Treat its comments as advice. A human decides and merges.
- Keep branches current by rebasing on `main`, never by merging `main` into them.

## Design changes

This code implements the Design Loom design package. If implementation reveals a gap or contradiction in the design, record it in the PR and resolve it in the design package before building incompatible behaviour.

## Local checks

Run `npm run verify` before pushing. It runs the same checks as CI. See [docs/development.md](docs/development.md).
