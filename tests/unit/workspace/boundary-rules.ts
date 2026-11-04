// Import-boundary rules for workspace packages (backlog B01).
// Kept separate from the tests so negative cases can exercise the checker directly.
//
// This is a pattern-based guard rail, not a sandbox: it catches the usual ways of
// importing or loading I/O modules, and code review covers anything more creative
// (for example an aliased global such as `const f = fetch; f(url)`).

import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const SCOPE = "@design-loom/";

/** Packages allowed to perform I/O. Everything else is pure logic over supplied data (design doc 02). */
export const MAY_DO_IO: ReadonlySet<string> = new Set(["cli", "integrations"]);

/**
 * Top-level Node built-ins that touch files, the network, processes or threads, load or run code
 * dynamically (`module`, `vm`, `wasi`), or expose machine-specific state that breaks determinism
 * (`os`, `tty`, `v8`). Sub-paths such as `dns/promises` are matched by their top-level name.
 */
const IO_BUILTINS: ReadonlySet<string> = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "perf_hooks",
  "process",
  "readline",
  "repl",
  "sqlite",
  "tls",
  "tty",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Globals and helpers that perform I/O or load modules without a static import. */
const IO_GLOBAL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // The lookbehind skips ordinary methods such as store.fetch(...); global receivers are listed explicitly.
  [/(?<![.\w$])(?:fetch|WebSocket|EventSource)\s*\(/, "calls a network global"],
  [/\b(?:globalThis|self|window|global)\s*\.\s*(?:fetch|WebSocket|EventSource)\b/, "uses a network global"],
  [/\bnew\s+(?:WebSocket|EventSource)\b/, "constructs a network client"],
  [/\bgetBuiltinModule\b/, "loads a built-in through process.getBuiltinModule"],
  [/\bcreateRequire\b/, "creates a require function"],
];

/**
 * Sources of non-determinism that pure packages must not read (design DL-Q01: same inputs, same
 * outputs). Time, randomness, environment and host details are passed in by cli or integrations.
 */
const NONDETERMINISTIC_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![.\w$])process\s*\./, "reads the process object"],
  [/\bDate\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)/, "reads the current time"],
  [/\bperformance\s*\.\s*now\b/, "reads a timer"],
  [
    /\bMath\s*\.\s*random\b|\bcrypto\s*\.\s*(?:randomUUID|getRandomValues)\b|\brandom(?:Bytes|UUID|Int)\s*\(/,
    "uses randomness",
  ],
];

/** import(...) or require(...) calls whose whole first argument isn't one string literal. */
export function hasNonLiteralModuleLoad(source: string): boolean {
  const calls = /(?<![.\w$])(?:import|require)\s*\(/g;
  for (const call of source.matchAll(calls)) {
    const rest = source.slice((call.index ?? 0) + call[0].length);
    if (!/^\s*(["'`])[^"'`]*\1\s*[,)]/.test(rest)) return true;
  }
  return false;
}

/** Every module specifier in a source file: static, re-export, side-effect, dynamic and require forms. */
export function findSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/g;
  return [...source.matchAll(pattern)].map((match) => match[2] ?? "");
}

export interface FileContext {
  /** Directory name of the package that owns the file, for example "config". */
  packageDir: string;
  /** Absolute path of the package root. */
  packageRoot: string;
  /** Absolute path of the source file. */
  file: string;
  /** Every dependency name declared by the package. */
  declared: ReadonlySet<string>;
}

/** Returns a reason when a specifier breaks a boundary rule, otherwise undefined. */
export function specifierViolation(specifier: string, ctx: FileContext): string | undefined {
  if (specifier.includes("${")) return `non-literal import specifier "${specifier}"`;

  if (specifier.startsWith(".")) {
    const target = resolve(dirname(ctx.file), specifier);
    const fromRoot = relative(ctx.packageRoot, target);
    // isAbsolute covers Windows paths on another drive, where relative() returns "D:\...".
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return `relative import "${specifier}" leaves package ${ctx.packageDir}`;
    }
    return undefined;
  }

  if (specifier.startsWith(SCOPE)) {
    const [name = "", ...rest] = specifier.slice(SCOPE.length).split("/");
    if (rest.length > 0) return `deep import "${specifier}"; import the package root instead`;
    if (name === ctx.packageDir) return `package imports itself by name: "${specifier}"`;
    if (!ctx.declared.has(`${SCOPE}${name}`)) return `undeclared workspace dependency "${specifier}"`;
    return undefined;
  }

  const builtin = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  if (BUILTINS.has(builtin) || specifier.startsWith("node:")) {
    const topLevel = builtin.split("/")[0] ?? builtin;
    if (IO_BUILTINS.has(topLevel) && !MAY_DO_IO.has(ctx.packageDir)) {
      return `pure package ${ctx.packageDir} imports I/O module "${specifier}"`;
    }
    return undefined;
  }

  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  if (!ctx.declared.has(packageName ?? "")) return `undeclared third-party dependency "${specifier}"`;
  return undefined;
}

/** All boundary violations in one source file. */
export function sourceViolations(source: string, ctx: FileContext): string[] {
  const reasons = findSpecifiers(source)
    .map((specifier) => specifierViolation(specifier, ctx))
    .filter((reason): reason is string => reason !== undefined);
  if (hasNonLiteralModuleLoad(source)) {
    reasons.push(`${ctx.packageDir} loads a module from a non-literal specifier, which can't be checked`);
  }
  if (!MAY_DO_IO.has(ctx.packageDir)) {
    for (const [pattern, description] of [...IO_GLOBAL_PATTERNS, ...NONDETERMINISTIC_PATTERNS]) {
      if (pattern.test(source)) reasons.push(`pure package ${ctx.packageDir} ${description}`);
    }
  }
  return reasons;
}
