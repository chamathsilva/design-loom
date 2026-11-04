/**
 * Result envelope and exit codes (design doc 07, "Result envelope and exit codes").
 *
 * With `--json`, every command prints exactly one envelope to stdout. Its fields are the run report
 * (run.schema.json) plus `result`, the command's own data. A persisted run report leaves `result`
 * out, so the rest of the envelope validates against run.schema.json as it is.
 */

import { randomBytes } from "node:crypto";
import { canonicalDigest, compareCodePoints, type Diagnostic, sortDiagnostics } from "@design-loom/config";

export type RunStatus = "passed" | "failed" | "blocked" | "degraded";

/** Exit codes from design doc 07. */
export const EXIT = {
  ok: 0,
  gateFailed: 1,
  invalid: 2,
  unavailable: 3,
  stale: 4,
  internal: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** When several outcomes apply, the most serious decides the exit code. */
const PRECEDENCE: readonly ExitCode[] = [
  EXIT.internal,
  EXIT.invalid,
  EXIT.stale,
  EXIT.unavailable,
  EXIT.gateFailed,
  EXIT.ok,
];

export function worstExit(codes: readonly ExitCode[]): ExitCode {
  return PRECEDENCE.find((code) => codes.includes(code)) ?? EXIT.ok;
}

export interface ResultEnvelope {
  schema_version: "1.0";
  command: string;
  status: RunStatus;
  run_id: string;
  /** The application root exactly as given; never written into shared artifacts. */
  root: string;
  framework_version: string;
  /** SHA-256 over the command, its options and the digests of the inputs it read. */
  input_digest: string;
  diagnostics: Diagnostic[];
  /** Files the command wrote, relative to the root. */
  outputs: string[];
  created_at: string;
  result: unknown;
}

/** A run ID valid for run.schema.json: time-ordered and unique enough for local reports. */
export function newRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `run-${stamp}-${randomBytes(4).toString("hex")}`;
}

export interface EnvelopeParts {
  command: string;
  status: RunStatus;
  root: string;
  frameworkVersion: string;
  /** Command options that change the result, without the root path. */
  options: Record<string, string | boolean | null>;
  /** Digests of what the command read, for example the effective-config provenance. */
  inputs: ReadonlyArray<{ origin: string; sha256: string }>;
  diagnostics: readonly Diagnostic[];
  outputs?: readonly string[];
  result: unknown;
  now: Date;
}

export function buildEnvelope(parts: EnvelopeParts): ResultEnvelope {
  const inputs = [...parts.inputs].sort((a, b) => compareCodePoints(a.origin, b.origin));
  return {
    schema_version: "1.0",
    command: parts.command,
    status: parts.status,
    run_id: newRunId(parts.now),
    root: parts.root,
    framework_version: parts.frameworkVersion,
    input_digest: canonicalDigest({ command: parts.command, options: parts.options, inputs }),
    diagnostics: sortDiagnostics(parts.diagnostics),
    outputs: [...(parts.outputs ?? [])],
    created_at: parts.now.toISOString().replace(/\.\d+Z$/, "Z"),
    result: parts.result,
  };
}
