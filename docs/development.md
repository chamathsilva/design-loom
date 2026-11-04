# Development

## Prerequisites

- **Node.js 24** (the version in `.nvmrc`). With nvm: `nvm install && nvm use`.
- **npm 11**, which ships with Node 24. No other package manager is needed.

## Everyday commands

| Command | What it does |
|---|---|
| `npm ci` | Install the exact locked dependencies |
| `npm run verify` | Everything CI runs: format/lint check, typecheck and tests |
| `npm run format` | Apply formatting and safe lint fixes |
| `npm run typecheck` | Type-check all packages and tests |
| `npm test` | Run the test suite |

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
- A package may only import workspace packages it declares, and only by package root: no deep `@design-loom/x/...` imports, and no relative paths that leave the package. This covers static, type, re-export, side-effect, dynamic and `require` imports.
- Nothing depends on `cli`, and only `cli` may depend on `integrations`.
- **Only `cli` and `integrations` may do I/O.** Other packages may not import file-system, network, process or thread modules (for example `node:fs`, `node:https`, `node:child_process`) or call `fetch`. They work on data passed in, which keeps them pure and testable.
- The internal dependency graph has no cycles.
- Third-party runtime dependencies must be added to the allowlist in that test. They end up bundled into the plugin, so each one is a deliberate choice.

Imports are found by pattern matching, not by parsing, so the check is deliberately strict: an import-like string in a comment can also be flagged.

Add internal dependencies only when code actually needs them.

## Writing code

- Use relative imports with the `.ts` extension inside a package, for example `import { x } from "./x.ts"`.
- Import other packages by name, for example `import { y } from "@design-loom/config"`, and declare them in that package's `package.json`.
- Keep policy functions pure. File writes and provider requests belong in adapters.
