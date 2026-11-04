/**
 * `config resolve` (design doc 07): the effective configuration with provenance. Read-only and
 * offline. A lock mismatch still returns the configuration, so the skill can explain it, but the run
 * is blocked (exit 4) because certified commands would refuse it (design doc 06).
 */

import { type CliContext, openRoot, type Resolution, resolveConfiguration } from "../context.ts";
import { EXIT, type ExitCode, type RunStatus } from "../envelope.ts";

export interface CommandOutcome {
  status: RunStatus;
  exitCode: ExitCode;
  resolution: Resolution | null;
  diagnostics: Resolution["diagnostics"];
  result: unknown;
}

export async function configResolve(options: { root?: string }, context: CliContext): Promise<CommandOutcome> {
  const app = await openRoot(options.root);
  const resolution = await resolveConfiguration(app, context);
  const { result } = resolution;
  const diagnostics = [...resolution.diagnostics, ...(result?.diagnostics ?? [])];
  if (!result?.envelope) {
    return {
      status: "failed",
      // A broken plugin install is an internal failure; anything else is the application's configuration.
      exitCode: resolution.releaseLoaded ? EXIT.invalid : EXIT.internal,
      resolution,
      diagnostics,
      result: { effective_config_digest: null, lock: result?.lock ?? null, effective_config: null },
    };
  }
  const lock = result.lock;
  const states = lock ? [lock.framework_version, lock.engine, lock.resources, lock.extensions] : [];
  let status: RunStatus = "passed";
  let exitCode: ExitCode = EXIT.ok;
  if (states.includes("mismatch")) {
    status = "blocked";
    exitCode = EXIT.stale;
  } else if (states.includes("unknown")) {
    status = "degraded";
  }
  return {
    status,
    exitCode,
    resolution,
    diagnostics,
    result: { effective_config_digest: result.digest, lock, effective_config: result.envelope },
  };
}
