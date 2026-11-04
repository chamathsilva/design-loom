// Import-boundary rules for workspace packages (backlog B01).
// Kept separate from the tests so negative cases can exercise the checker directly.

import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

export const SCOPE = "@design-loom/";

/** Packages allowed to perform I/O. Everything else is pure logic over supplied data (design doc 02). */
export const MAY_DO_IO: ReadonlySet<string> = new Set(["cli", "integrations"]);

/** Node built-ins that touch files, the network, processes or threads. */
const IO_BUILTINS: ReadonlySet<string> = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "net",
  "readline",
  "tls",
  "worker_threads",
]);

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Every module specifier in a source file: static, re-export, side-effect, dynamic and require forms. */
export function findSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** Calls to network globals that bypass module imports. */
export function usesNetworkGlobals(source: string): boolean {
  return /\b(?:fetch|WebSocket|EventSource)\s*\(/.test(source) || /\bnew\s+(?:WebSocket|EventSource)\b/.test(source);
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
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(ctx.file), specifier);
    const fromRoot = relative(ctx.packageRoot, target);
    if (fromRoot.startsWith("..") || fromRoot.startsWith(sep)) {
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
    if (IO_BUILTINS.has(builtin) && !MAY_DO_IO.has(ctx.packageDir)) {
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
  if (!MAY_DO_IO.has(ctx.packageDir) && usesNetworkGlobals(source)) {
    reasons.push(`pure package ${ctx.packageDir} calls a network global`);
  }
  return reasons;
}
