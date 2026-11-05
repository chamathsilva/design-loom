# Development

## Prerequisites

- **Node.js 24.22.2 or a later 24.x** (`.nvmrc` pins the exact release CI uses). With nvm: `nvm install && nvm use`.
- **npm 11.19.1 or a later 11.x**, which ships with that Node release. No other package manager is needed.

`engine-strict` is on, so `npm ci` refuses to install with an older Node or npm. CI uses exactly the pinned versions and fails if they differ.

## Everyday commands

| Command | What it does |
|---|---|
| `npm ci` | Install the exact locked dependencies |
| `npm run verify` | Everything CI runs: format/lint check, typecheck and tests |
| `npm run format` | Apply formatting and safe lint fixes |
| `npm run typecheck` | Type-check all packages and tests |
| `npm test` | Run the test suite |

## Running the CLI from source

Node runs the TypeScript sources directly, so no build is needed:

```sh
node packages/cli/src/main.ts doctor --root /absolute/path/to/design-repo --json
node packages/cli/src/main.ts config resolve --root /absolute/path/to/design-repo --json
```

Two commands write to the design repository (B06). Both refuse a configuration or lock that doesn't resolve, never replace an existing file, and write through a temporary file and an atomic rename:

```sh
# Create changes/CHANGE-100/change.json and an empty traceability.json
node packages/cli/src/main.ts change init --root /abs/design-repo \
  --id CHANGE-100 --workflow core.feature-design --title "Dashboard API" --json

# Register an artifact whose content is already saved in the change's content/ folder
node packages/cli/src/main.ts artifact register --root /abs/design-repo \
  --id DESIGN-100 --type engineering-design --owner-role engineering \
  --change CHANGE-100 --content changes/CHANGE-100/content/design.md --json

# Register a project-scoped (shared) artifact: no change owner, content under shared/content/
node packages/cli/src/main.ts artifact register --root /abs/design-repo \
  --id SHARED-100 --type contract --owner-role architecture \
  --scope project --content shared/content/errors.md --json
```

`change init` defaults the change's owner roles to the roles the application profile names (reviewer roles and repository owner roles); pass `--owner-role` to choose. `artifact register` fills the workflow step from the change's workflow when exactly one step produces the artifact type (otherwise pass `--step`), and builds the context receipt from `--depends-on` and `--source` using the digests the store holds now. New artifacts are always drafts: readiness needs the rule engine (B07).

With `--json`, stdout carries exactly one result envelope: the run-report fields from `run.schema.json` plus `result`, the command's own data. The exit codes follow design doc 07: 0 ok, 1 gate failed, 2 invalid configuration or invocation, 3 capability unavailable, 4 stale or conflicting lock, 5 internal error.

From source there is no engine bundle to hash, so `doctor` always reports the engine as unverified (exit 3). The release build (B11) bundles the CLI and binds the engine digest.

## Toolchain decisions (B01)

| Choice | Why |
|---|---|
| npm workspaces | Ships with Node, so contributors and CI need nothing extra |
| Node's built-in test runner, running TypeScript directly | Node 24 strips types natively, so tests need no framework or build step |
| TypeScript 7 for type-checking only (`noEmit`) | The production CLI is bundled in a later milestone (B11) |
| `erasableSyntaxOnly` | Keeps every source file runnable by Node's type stripping (no enums or namespaces) |
| Biome | One pinned package for formatting and linting |
| Exact version pins and a committed `package-lock.json` | Reproducible installs (design DL-Q01) |
| LF line endings via `.gitattributes` | Design Loom hashes stored bytes, so they must match on every OS |
| GitHub Actions pinned to commit SHAs, read-only permissions | Trusted, repeatable CI (design doc 09) |

## Package boundaries

The eight packages come from design doc 02. `tests/unit/workspace/boundaries.test.ts` enforces these rules, using the checker in `boundary-rules.ts`, whose negative cases live in `boundary-rules.test.ts`:

- Every package is private ESM, exports `src/index.ts`, contains only `.ts` sources, and declares no peer or optional dependencies.
- A package may only import workspace packages it declares, and only by package root: no deep `@design-loom/x/...` imports, and no relative paths that leave the package's `src` folder (only `src` is scanned; `.json` data files may live anywhere in the package). This covers static, type, re-export, side-effect, dynamic and `require` imports.
- Nothing depends on `cli`, and only `cli` may depend on `integrations`.
- **Only `cli` and `integrations` may do I/O.** Other packages may not import file-system, network, process, thread, code-running or machine-specific built-ins (for example `node:fs`, `node:dns/promises`, `node:child_process`, `node:module`, `node:vm`, `node:os`, and `node:path`, whose separators and `resolve` follow the host; `node:path/posix` is allowed), use `fetch` or `globalThis`, use `process.getBuiltinModule` or `createRequire`, or evaluate code from strings (`eval`, `Function`). They work on data passed in, which keeps them pure, testable and deterministic.
- **Pure packages are deterministic.** They may not read `process`, the current time (`Date.now()`, `new Date()`, `Date()`), timers, randomness (`Math.random`, `randomBytes`, `randomFillSync`, `getRandomValues` and similar) the host locale (`localeCompare`, `toLocaleString`, `Intl`), timers (`setTimeout` and friends) or host paths (`import.meta.url`, `import.meta.dirname`). `cli` passes these values in when they are needed.
- `import(...)` and `require(...)` must take a single string literal in every package, so every dependency can be checked.
- The internal dependency graph has no cycles.
- Third-party runtime dependencies must be added to the allowlist in that test. They end up bundled into the plugin, so each one is a deliberate choice.

These checks are a guard rail, not a sandbox. A small lexer first blanks out comments, string contents and regex literals, so prose such as "the build process" doesn't trip a rule and a comment can't hide an import. The rules then match patterns, which catches the usual ways of loading modules and reading globals. Code review covers the rest; the known gaps are listed at the top of `boundary-rules.ts`.

Add internal dependencies only when code actually needs them.

## Writing code

- Use relative imports with the `.ts` extension inside a package, for example `import { x } from "./x.ts"`.
- Import other packages by name, for example `import { y } from "@design-loom/config"`, and declare them in that package's `package.json`.
- Keep policy functions pure. File writes and provider requests belong in adapters.
