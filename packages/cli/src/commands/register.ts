/**
 * `change init` and `artifact register` (backlog B06; design doc 07). They plan with the pure
 * functions in @design-loom/artifacts, then write the planned files with create-only atomic writes:
 * an existing file is never replaced.
 */

import {
  type ArtifactRequest,
  type Plan,
  type PlannedFile,
  planArtifact,
  planChange,
  type RegistrationConfig,
  registrationConfigOf,
  type StoreIndex,
  uncheckableStoreProblems,
} from "@design-loom/artifacts";
import { type Diagnostic, diagnostic, normalizeRelativePath, PathPolicyError, sha256Hex } from "@design-loom/config";
import {
  DEFAULT_MAX_REFERENCED_BYTES,
  osErrorCode,
  readStoreIndex,
  type SafeFileSystem,
  SafeFsError,
} from "@design-loom/integrations";
import { type CliContext, CommandFailure, openRoot, type Resolution, resolveConfiguration } from "../context.ts";
import { EXIT, type ExitCode } from "../envelope.ts";
import type { Options } from "../options.ts";
import type { CommandOutcome } from "./config-resolve.ts";

interface Prepared {
  fs: SafeFileSystem;
  resolution: Resolution;
  config: RegistrationConfig;
  index: StoreIndex;
}

const invalid = (code: string, message: string, remediation: string): CommandFailure =>
  new CommandFailure(EXIT.invalid, [diagnostic(code, "error", message, { remediation })]);

function required(options: Options, names: readonly ("id" | "title" | "workflow" | "type" | "content")[]): void {
  for (const name of names) {
    if (options[name] === undefined || options[name] === "") {
      throw invalid("CLI_MISSING_OPTION", `--${name} is required`, "Run the command with every required option.");
    }
  }
}

function refused(
  resolution: Resolution | null,
  exitCode: ExitCode,
  diagnostics: Diagnostic[],
  status: "failed" | "blocked" = "failed",
): CommandOutcome {
  return { status, exitCode, resolution, diagnostics, result: { written: [] } };
}

/** Resolves the configuration and reads the store. A write is refused unless both are sound. */
async function prepare(options: Options, context: CliContext): Promise<Prepared | CommandOutcome> {
  const fs = await openRoot(options.root);
  const resolution = await resolveConfiguration(fs, context);
  const { result } = resolution;
  const diagnostics = [...resolution.diagnostics, ...(result?.diagnostics ?? [])];
  if (!result?.envelope) {
    return refused(resolution, resolution.releaseLoaded ? EXIT.invalid : EXIT.internal, diagnostics);
  }
  const lock = result.lock;
  if (lock && [lock.framework_version, lock.engine, lock.resources, lock.extensions].includes("mismatch")) {
    return refused(resolution, EXIT.stale, diagnostics, "blocked");
  }
  const configuration = result.envelope.configuration;
  const config = registrationConfigOf(result.envelope);
  const limits = (configuration.application.limits ?? {}) as { max_artifacts?: number; max_metadata_bytes?: number };
  const index = await readStoreIndex(fs, {
    applicationId: config.applicationId,
    limits: {
      ...(limits.max_artifacts === undefined ? {} : { maxArtifacts: limits.max_artifacts }),
      ...(limits.max_metadata_bytes === undefined ? {} : { maxMetadataBytes: limits.max_metadata_bytes }),
    },
  });
  // A record the index couldn't read might be the very ID being registered, so don't write.
  const unsound = uncheckableStoreProblems(index);
  if (unsound.length > 0) return refused(resolution, EXIT.invalid, unsound);
  return { fs, resolution, config, index };
}

const isOutcome = (value: Prepared | CommandOutcome): value is CommandOutcome => "status" in value;

interface Written {
  path: string;
  sha256: string;
  bytes: number;
}

/** Writes the planned files in order. A failure stops the run and says what was already written. */
async function writeFiles(prepared: Prepared, plan: Plan): Promise<{ written: Written[]; failure: Diagnostic | null }> {
  const written: Written[] = [];
  for (const file of plan.files) {
    try {
      await prepared.fs.writeAtomic(file.path, file.bytes);
    } catch (error) {
      return { written, failure: writeFailure(error, file, written) };
    }
    written.push({ path: file.path, sha256: sha256Hex(file.bytes), bytes: file.bytes.byteLength });
  }
  return { written, failure: null };
}

function writeFailure(error: unknown, file: PlannedFile, written: readonly Written[]): Diagnostic {
  const partial =
    written.length > 0
      ? ` Already written: ${written.map((entry) => entry.path).join(", ")}; remove them before retrying.`
      : "";
  if (error instanceof SafeFsError) {
    const reason = error.code === "exists" ? "already exists" : `was refused (${error.code})`;
    return diagnostic("REGISTER_WRITE_REFUSED", "error", `${file.path} ${reason}.${partial}`, {
      path: file.path,
      remediation: "Existing files are never overwritten. Choose another ID.",
    });
  }
  if (error instanceof PathPolicyError) {
    return diagnostic("REGISTER_UNPORTABLE_ID", "error", `${file.path} is not a portable path.${partial}`, {
      path: file.path,
      remediation: "Choose an ID that is valid on every operating system.",
    });
  }
  const code = osErrorCode(error);
  if (code === null) throw error;
  return diagnostic("CLI_WRITE_FAILED", "error", `${file.path} can't be written (${code}).${partial}`, {
    path: file.path,
    remediation: "Check that the design repository is writable.",
  });
}

async function finish(
  prepared: Prepared,
  plan: Plan,
  extra: Record<string, unknown>,
  inputs: { origin: string; sha256: string }[] = [],
): Promise<CommandOutcome> {
  const { written, failure } = await writeFiles(prepared, plan);
  if (failure) {
    const exit = failure.code === "CLI_WRITE_FAILED" ? EXIT.unavailable : EXIT.invalid;
    return { ...refused(prepared.resolution, exit, [failure]), result: { written } };
  }
  return {
    status: "passed",
    exitCode: EXIT.ok,
    resolution: prepared.resolution,
    additionalInputs: inputs,
    diagnostics: [],
    result: { ...extra, written },
  };
}

/** Names already under changes/, including folders the index could not read as changes. */
async function changeFolders(fs: SafeFileSystem): Promise<string[]> {
  try {
    return (await fs.listDirectory("changes")).map((entry) => entry.name);
  } catch (error) {
    if ((error instanceof SafeFsError && error.code === "not-found") || osErrorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/** Why a plan was refused, with the store's own problems added for context. */
function refusal(prepared: Prepared, plan: Plan): CommandOutcome {
  const storeErrors = prepared.index.diagnostics.filter((entry) => entry.severity === "error");
  return refused(prepared.resolution, EXIT.invalid, [...plan.diagnostics, ...storeErrors]);
}

export async function changeInit(options: Options, context: CliContext): Promise<CommandOutcome> {
  required(options, ["id", "title", "workflow"]);
  const prepared = await prepare(options, context);
  if (isOutcome(prepared)) return prepared;
  const plan = planChange(
    {
      id: options.id as string,
      title: options.title as string,
      workflowId: options.workflow as string,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ownerRoles: options.ownerRole,
      requirementIds: options.requirement,
      sourceIds: options.source,
      repositoryIds: options.repository,
      exclusions: options.exclude,
    },
    prepared.config,
    prepared.index,
    await changeFolders(prepared.fs),
  );
  if (plan.diagnostics.length > 0) return refusal(prepared, plan);
  return finish(prepared, plan, { change_id: options.id });
}

/** Reads and hashes a file the artifact points at. Throws a refusal when it can't be used. */
async function digestOf(fs: SafeFileSystem, label: string, path: string): Promise<{ path: string; sha256: string }> {
  let normalized: string;
  try {
    normalized = normalizeRelativePath(path);
  } catch {
    throw invalid(
      "REGISTER_UNSAFE_PATH",
      `${label} path is not a safe relative path`,
      "Use a path inside the repository, with forward slashes and no .. parts.",
    );
  }
  try {
    if ((await fs.sizeOf(normalized)) > DEFAULT_MAX_REFERENCED_BYTES) {
      throw invalid(
        "REGISTER_CONTENT_TOO_LARGE",
        `${label} ${normalized} is too large`,
        "Keep large binaries external.",
      );
    }
    return { path: normalized, sha256: sha256Hex(await fs.readBytes(normalized)) };
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    const missing = error instanceof SafeFsError && error.code === "not-found";
    const code = osErrorCode(error);
    if (!(error instanceof SafeFsError) && code === null) throw error;
    throw invalid(
      missing ? "REGISTER_CONTENT_MISSING" : "REGISTER_CONTENT_UNREADABLE",
      missing
        ? `${label} ${normalized} does not exist`
        : `${label} ${normalized} can't be read (${code ?? (error as SafeFsError).code})`,
      "Save the file in the design repository first, then register it.",
    );
  }
}

function artifactScope(options: Options): ArtifactRequest["scope"] {
  const hasChange = options.change !== undefined;
  const hasScope = options.scope !== undefined;
  if (hasChange === hasScope) {
    throw invalid(
      "CLI_OWNERSHIP_REQUIRED",
      "pass exactly one of --change <id> or --scope project",
      "--change registers a change artifact; --scope project registers a shared one.",
    );
  }
  if (hasScope && options.scope !== "project") {
    throw invalid("CLI_INVALID_SCOPE", `--scope must be "project"`, "Use --change <id> for change artifacts.");
  }
  return hasChange ? { kind: "change", changeId: options.change as string } : { kind: "project" };
}

export async function artifactRegister(options: Options, context: CliContext): Promise<CommandOutcome> {
  required(options, ["id", "type", "content"]);
  const scope = artifactScope(options);
  if (options.ownerRole.length > 1) {
    throw invalid("CLI_TOO_MANY_OPTIONS", "an artifact has one owner role", "Pass --owner-role once.");
  }
  const prepared = await prepare(options, context);
  if (isOutcome(prepared)) return prepared;
  let content: { path: string; sha256: string };
  let attachments: { path: string; sha256: string }[];
  try {
    content = await digestOf(prepared.fs, "content", options.content as string);
    attachments = await Promise.all(options.attachment.map((path) => digestOf(prepared.fs, "attachment", path)));
  } catch (error) {
    if (!(error instanceof CommandFailure)) throw error;
    return refused(prepared.resolution, error.exitCode, error.diagnostics);
  }
  const plan = planArtifact(
    {
      id: options.id as string,
      type: options.type as string,
      scope,
      content,
      attachments,
      coveredChangeIds: options.coveredChange,
      dependsOn: options.dependsOn,
      sourceIds: options.source,
      requirementIds: options.requirement,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.ownerRole[0] === undefined ? {} : { ownerRole: options.ownerRole[0] }),
      ...(options.step === undefined ? {} : { workflowStep: options.step }),
    },
    prepared.config,
    prepared.index,
  );
  if (plan.diagnostics.length > 0) return refusal(prepared, plan);
  return finish(
    prepared,
    plan,
    { artifact_id: options.id, scope: scope.kind, semantic_digest: plan.semanticDigest },
    [content, ...attachments].map((file) => ({ origin: file.path, sha256: file.sha256 })),
  );
}
