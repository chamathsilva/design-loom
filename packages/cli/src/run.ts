/**
 * Command-line entry: parses arguments, runs one command and prints its result (design doc 07).
 * With --json, stdout carries exactly one envelope and nothing else. Without it, stdout carries a
 * short human-readable summary. Never prompts.
 */

import { type Diagnostic, diagnostic } from "@design-loom/config";
import { osErrorCode } from "@design-loom/integrations";
import { type CommandOutcome, configResolve } from "./commands/config-resolve.ts";
import { doctor } from "./commands/doctor.ts";
import { artifactRegister, changeInit } from "./commands/register.ts";
import { type CliContext, CommandFailure, frameworkVersionOf, inputDigests } from "./context.ts";
import { buildEnvelope, EXIT, type ExitCode, type ResultEnvelope } from "./envelope.ts";
import { type Options, parseOptions, recordedOptions } from "./options.ts";

function internalErrorMessage(error: unknown): string {
  const code = osErrorCode(error);
  return code === null ? "unexpected internal error" : `unexpected internal error (${code})`;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage:
  design-loom config resolve --root <absolute-path> [--json]
  design-loom doctor --root <absolute-path> [--workflow <id>] [--json]
  design-loom change init --root <absolute-path> --id <id> --workflow <id> --title <text>
      [--summary <text>] [--owner-role <role>]... [--requirement <id>]... [--source <id>]...
      [--repository <id>]... [--exclude <text>]... [--json]
  design-loom artifact register --root <absolute-path> --id <id> --type <type> --content <path>
      (--change <id> | --scope project) [--title <text>] [--owner-role <role>] [--step <id>]
      [--depends-on <id>]... [--source <id>]... [--requirement <id>]...
      [--covered-change <id>]... [--attachment <path>]... [--json]
`;

const COMMANDS: Record<string, (options: Options, context: CliContext) => Promise<CommandOutcome>> = {
  "config resolve": configResolve,
  doctor,
  "change init": changeInit,
  "artifact register": artifactRegister,
};

function summarize(envelope: ResultEnvelope): string {
  const lines = [`${envelope.command}: ${envelope.status}`];
  for (const entry of envelope.diagnostics) {
    lines.push(`  ${entry.severity} ${entry.code}${entry.path ? ` ${entry.path}` : ""}: ${entry.message}`);
  }
  const result = envelope.result as {
    effective_config_digest?: string | null;
    capabilities?: { id: string; state: string }[];
    written?: { path: string }[];
  };
  if (result?.effective_config_digest) lines.push(`  effective_config_digest ${result.effective_config_digest}`);
  for (const capability of result?.capabilities ?? []) lines.push(`  capability ${capability.id}: ${capability.state}`);
  for (const file of result?.written ?? []) lines.push(`  wrote ${file.path}`);
  return `${lines.join("\n")}\n`;
}

/** Runs the CLI and returns its exit code. */
export async function runCli(argv: readonly string[], io: CliIo, context: CliContext): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${USAGE}`);
    // --json promises one envelope on stdout, even when the arguments can't be parsed.
    if (argv.includes("--json")) {
      const envelope = buildEnvelope({
        command: "(invalid)",
        status: "failed",
        root: "",
        frameworkVersion: "0.0.0",
        options: {},
        inputs: [],
        diagnostics: [
          diagnostic("CLI_INVALID_ARGS", "error", (error as Error).message, {
            remediation: "Run one of the commands in the usage text.",
          }),
        ],
        result: null,
        now: context.now(),
      });
      io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    }
    return EXIT.invalid;
  }
  const { options } = parsed;
  const name = parsed.positionals.join(" ");
  const command = COMMANDS[name];
  const json = options.json === true;

  let outcome: CommandOutcome;
  if (!command) {
    const message = name === "" ? "no command given" : `unknown command: ${name}`;
    outcome = failed(EXIT.invalid, [
      diagnostic("CLI_UNKNOWN_COMMAND", "error", message, {
        remediation: "Run one of the commands in the usage text.",
      }),
    ]);
    io.stderr(USAGE);
  } else {
    try {
      outcome = await command(options, context);
    } catch (error) {
      if (error instanceof CommandFailure) {
        outcome = failed(error.exitCode, error.diagnostics);
      } else {
        io.stderr(`${(error as Error).stack ?? String(error)}\n`);
        outcome = failed(EXIT.internal, [
          // OS error messages carry absolute local paths, so the envelope gets the error code only;
          // the full message and stack stay on stderr.
          diagnostic("CLI_INTERNAL_ERROR", "error", internalErrorMessage(error), {
            remediation: "Report this as a defect, with the stderr output.",
          }),
        ]);
      }
    }
  }

  const envelope = buildEnvelope({
    command: name || "(none)",
    status: outcome.status,
    root: options.root ?? "",
    frameworkVersion: frameworkVersionOf(outcome.resolution),
    options: recordedOptions(options),
    inputs: [...inputDigests(outcome.resolution), ...(outcome.additionalInputs ?? [])],
    diagnostics: outcome.diagnostics,
    result: outcome.result,
    now: context.now(),
  });
  io.stdout(json ? `${JSON.stringify(envelope, null, 2)}\n` : summarize(envelope));
  return outcome.exitCode;
}

function failed(exitCode: ExitCode, diagnostics: Diagnostic[]): CommandOutcome {
  return { status: "failed", exitCode, resolution: null, diagnostics, result: null };
}
