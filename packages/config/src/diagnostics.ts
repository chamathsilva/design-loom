/**
 * Diagnostics shared by every command (design doc 07, "Result envelope and exit codes").
 * The shape matches a diagnostic in run.schema.json, so a command can copy it into its run report.
 */

import { compareCodePoints } from "./canonical-json.ts";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  /** Stable code, for example `CONFIG_UNKNOWN_WORKFLOW` or `DL004`. */
  code: string;
  severity: Severity;
  message: string;
  /** Repository-relative file, optionally followed by `#` and a JSON Pointer; "" when nothing applies. */
  path: string;
  /** Short facts behind the message, such as the expected and actual digests. */
  evidence: string[];
  remediation: string;
}

export function diagnostic(
  code: string,
  severity: Severity,
  message: string,
  details: { path?: string; evidence?: string[]; remediation: string },
): Diagnostic {
  return {
    code,
    severity,
    message,
    path: details.path ?? "",
    evidence: details.evidence ?? [],
    remediation: details.remediation,
  };
}

/** Appends a JSON Pointer to a file path: `pointerPath(".design-loom/app.json", "/limits")`. */
export function pointerPath(file: string, pointer: string): string {
  return pointer === "" ? file : `${file}#${pointer}`;
}

/** Escapes one reference token for a JSON Pointer (RFC 6901). */
export function pointerToken(token: string | number): string {
  return String(token).replaceAll("~", "~0").replaceAll("/", "~1");
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Orders diagnostics by severity, then path, code and message, so output never depends on discovery order. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareCodePoints(a.path, b.path) ||
      compareCodePoints(a.code, b.code) ||
      compareCodePoints(a.message, b.message),
  );
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === "error");
}
