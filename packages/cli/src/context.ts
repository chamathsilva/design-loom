/**
 * What a command needs from its surroundings. `main.ts` builds the real one; tests pass their own,
 * for example to supply an engine digest that only a built plugin has.
 */

import { isAbsolute } from "node:path";
import {
  type Diagnostic,
  diagnostic,
  type ResolveInput,
  type ResolveResult,
  resolveEffectiveConfig,
} from "@design-loom/config";
import { loadConfiguration, SafeFileSystem, SafeFsError } from "@design-loom/integrations";
import { EXIT, type ExitCode } from "./envelope.ts";

export interface CliContext {
  /** Absolute path of the running release's core resource folder. */
  releaseRoot: string;
  /** SHA-256 of the running engine bundle; null when running from source (until B11 builds one). */
  engineSha256: string | null;
  /** The Node.js version running the CLI, such as "v24.22.2". */
  nodeVersion: string;
  now: () => Date;
}

/** A command stopped early: its exit code and why. */
export class CommandFailure extends Error {
  readonly exitCode: ExitCode;
  readonly diagnostics: Diagnostic[];
  constructor(exitCode: ExitCode, diagnostics: Diagnostic[]) {
    super(diagnostics.map((entry) => entry.message).join("; "));
    this.exitCode = exitCode;
    this.diagnostics = diagnostics;
  }
}

/** Opens the application root given with --root. It must be an absolute path to an existing folder. */
export async function openRoot(root: string | undefined): Promise<SafeFileSystem> {
  const invalid = (message: string): CommandFailure =>
    new CommandFailure(EXIT.invalid, [
      diagnostic("CLI_INVALID_ROOT", "error", message, {
        remediation: "Pass --root with the absolute path of the design repository checkout.",
      }),
    ]);
  if (root === undefined) throw invalid("--root is required");
  if (!isAbsolute(root)) throw invalid(`--root must be an absolute path: ${root}`);
  try {
    return await SafeFileSystem.open(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof SafeFsError || code === "ENOENT" || code === "ENOTDIR") {
      throw invalid(`--root is not an existing folder: ${root}`);
    }
    throw error;
  }
}

async function openRelease(context: CliContext): Promise<SafeFileSystem> {
  try {
    return await SafeFileSystem.open(context.releaseRoot);
  } catch {
    throw new CommandFailure(EXIT.internal, [
      diagnostic("CLI_RELEASE_MISSING", "error", "the plugin's core resources can't be found", {
        remediation: "Reinstall the plugin.",
      }),
    ]);
  }
}

export interface Resolution {
  input: ResolveInput | null;
  result: ResolveResult | null;
  /** Loader diagnostics; resolver diagnostics are in `result`. */
  diagnostics: Diagnostic[];
}

/** Loads and resolves the effective configuration of the application at `app`. */
export async function resolveConfiguration(app: SafeFileSystem, context: CliContext): Promise<Resolution> {
  const release = await openRelease(context);
  const loaded = await loadConfiguration(app, release, context.engineSha256);
  if (!loaded.input) return { input: null, result: null, diagnostics: loaded.diagnostics };
  return { input: loaded.input, result: resolveEffectiveConfig(loaded.input), diagnostics: [] };
}

/** Framework version of the running release, for envelopes; "0.0.0" when it can't be read. */
export function frameworkVersionOf(resolution: Resolution | null): string {
  const value = resolution?.input?.release.manifest.value as { framework_version?: unknown } | undefined;
  return typeof value?.framework_version === "string" ? value.framework_version : "0.0.0";
}

/** Digests a command read, for the envelope's input_digest. */
export function inputDigests(resolution: Resolution | null): { origin: string; sha256: string }[] {
  const input = resolution?.input;
  if (!input) return [];
  const documents = [
    input.release.manifest,
    ...input.release.workflows,
    ...input.release.templates,
    input.application,
    input.lock,
    ...input.extensions.map((extension) => extension.manifest),
  ];
  return [
    ...documents.map(({ origin, sha256 }) => ({ origin, sha256 })),
    { origin: "core/", sha256: input.release.resourcesSha256 },
    ...input.extensions.map((extension) => ({ origin: `${extension.path}/`, sha256: extension.resourcesSha256 })),
    ...(input.release.engineSha256 ? [{ origin: "core/engine", sha256: input.release.engineSha256 }] : []),
  ];
}
