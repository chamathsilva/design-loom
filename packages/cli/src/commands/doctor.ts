/**
 * `doctor` (design doc 07; doc 03 "Lockfile"; doc 08 "Capability receipt" and "Operation-scoped
 * readiness"). Read-only and offline. It checks:
 *
 * - the Node.js runtime;
 * - the effective configuration and the lock against the running engine, resources and extensions;
 * - the ignored local workspace map, when there is one;
 * - each capability the application declares: local files and local Git checkouts are checked on
 *   disk; anything that needs a live provider is reported as unknown, never as ready.
 *
 * Exit codes: 0 when everything the selected workflow needs is ready (the run is degraded if an
 * optional capability isn't); 2 for invalid configuration; 3 when a needed capability, the runtime or
 * the engine identity can't be confirmed; 4 for a lock mismatch.
 */

import { isAbsolute } from "node:path";
import { type Diagnostic, diagnostic, normalizeRelativePath, parseJson } from "@design-loom/config";
import { SafeFileSystem, SafeFsError } from "@design-loom/integrations";
import { validateAgainstSchema } from "@design-loom/validation";
import { type CliContext, openRoot, resolveConfiguration } from "../context.ts";
import { EXIT, type ExitCode, type RunStatus, worstExit } from "../envelope.ts";
import type { CommandOutcome } from "./config-resolve.ts";

export const WORKSPACE_PATH = ".design-loom/workspace.local.json";
const MINIMUM_NODE_MAJOR = 24;

export type CapabilityState = "ready" | "unavailable" | "unknown";

export interface CapabilityReport {
  id: string;
  provider: string;
  mode: string;
  required: boolean;
  /** True when a step of the selected workflow uses it. */
  used_by_workflow: boolean;
  state: CapabilityState;
  evidence: string[];
}

interface Capability {
  id: string;
  provider: string;
  mode: string;
  required: boolean;
  scopes: string[];
}

interface Workflow {
  id: string;
  steps: { capabilities: string[] }[];
}

type WorkspaceMap = ReadonlyMap<string, string>;

/** Whether a repository-relative path exists inside the root. */
async function pathState(app: SafeFileSystem, path: string): Promise<CapabilityState> {
  try {
    await app.listDirectory(path);
    return "ready";
  } catch (error) {
    if (error instanceof SafeFsError && error.code === "not-a-file") return "ready";
    if (error instanceof SafeFsError) return "unavailable";
    throw error;
  }
}

/** Whether a folder is a Git checkout (it has a `.git` folder or file). */
async function hasGit(folder: SafeFileSystem): Promise<boolean> {
  return (await folder.listDirectory("")).some((entry) => entry.name === ".git");
}

async function probe(
  capability: Capability,
  app: SafeFileSystem,
  designRepositoryId: string,
  workspace: WorkspaceMap | null,
): Promise<{ state: CapabilityState; evidence: string[] }> {
  const evidence: string[] = [];
  if (capability.provider === "local-files") {
    let state: CapabilityState = "ready";
    for (const scope of capability.scopes) {
      let found: CapabilityState;
      try {
        found = await pathState(app, normalizeRelativePath(scope, { allowDirectoryPrefix: true }).replace(/\/$/, ""));
      } catch {
        found = "unavailable";
      }
      evidence.push(`${scope}: ${found === "ready" ? "present" : "missing"}`);
      if (found !== "ready") state = "unavailable";
    }
    return { state, evidence };
  }
  if (capability.provider === "local-git") {
    let state: CapabilityState = "ready";
    for (const repository of capability.scopes) {
      let present = false;
      if (repository === designRepositoryId) {
        present = await hasGit(app);
        evidence.push(`${repository}: ${present ? "this checkout" : "this folder is not a Git checkout"}`);
      } else {
        const checkout = workspace?.get(repository);
        if (checkout === undefined) {
          evidence.push(`${repository}: not mapped in ${WORKSPACE_PATH}`);
        } else {
          try {
            present = await hasGit(await SafeFileSystem.open(checkout));
            evidence.push(`${repository}: ${present ? "checkout found" : "mapped folder is not a Git checkout"}`);
          } catch {
            evidence.push(`${repository}: mapped checkout folder is missing`);
          }
        }
      }
      if (!present) state = "unavailable";
    }
    if (state === "ready") evidence.push("remote identity and revisions are checked when content is read");
    return { state, evidence };
  }
  return {
    state: "unknown",
    evidence: [`provider ${capability.provider} needs a live check; offline doctor can't confirm access`],
  };
}

function invalidWorkspace(
  diagnostics: Diagnostic[],
  message: string,
  path = WORKSPACE_PATH,
): { state: "invalid"; map: null } {
  diagnostics.push(
    diagnostic("DOCTOR_WORKSPACE_INVALID", "error", message, {
      path,
      remediation: "Fix the local workspace map: each repository ID mapped to an absolute checkout path.",
    }),
  );
  return { state: "invalid", map: null };
}

/** Reads the ignored local workspace map, if any. */
async function readWorkspace(
  app: SafeFileSystem,
  diagnostics: Diagnostic[],
): Promise<{ state: "absent" | "valid" | "invalid"; map: WorkspaceMap | null }> {
  let bytes: Uint8Array;
  try {
    bytes = await app.readBytes(WORKSPACE_PATH);
  } catch (error) {
    if (error instanceof SafeFsError && error.code === "not-found") return { state: "absent", map: null };
    // A folder, an escaping symlink or an unreadable file: the user can fix it, so it's invalid input.
    const code = (error as NodeJS.ErrnoException).code;
    if (!(error instanceof SafeFsError) && !(typeof code === "string" && /^E[A-Z]+$/.test(code))) throw error;
    return invalidWorkspace(diagnostics, `${WORKSPACE_PATH} can't be read: ${(error as Error).message}`);
  }
  const invalid = (message: string, path = WORKSPACE_PATH): { state: "invalid"; map: null } =>
    invalidWorkspace(diagnostics, message, path);
  let value: unknown;
  try {
    value = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return invalid(`${WORKSPACE_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  const schema = validateAgainstSchema("workspace", value);
  if (!schema.valid)
    return invalid(
      `workspace: ${schema.issues[0]?.message ?? "invalid"}`,
      `${WORKSPACE_PATH}#${schema.issues[0]?.instancePath ?? ""}`,
    );
  const map = new Map<string, string>();
  for (const [index, entry] of (
    value as { repositories: { id: string; checkout_path: string }[] }
  ).repositories.entries()) {
    if (!isAbsolute(entry.checkout_path))
      return invalid("checkout_path must be absolute", `${WORKSPACE_PATH}#/repositories/${index}/checkout_path`);
    if (map.has(entry.id))
      return invalid(`repository ${entry.id} is mapped twice`, `${WORKSPACE_PATH}#/repositories/${index}/id`);
    map.set(entry.id, entry.checkout_path);
  }
  return { state: "valid", map };
}

export async function doctor(
  options: { root?: string; workflow?: string },
  context: CliContext,
): Promise<CommandOutcome> {
  const diagnostics: Diagnostic[] = [];
  const exits: ExitCode[] = [];
  let degraded = false;

  // Runtime.
  const major = Number(/^v(\d+)\./.exec(context.nodeVersion)?.[1] ?? 0);
  const runtimeSupported = major >= MINIMUM_NODE_MAJOR;
  if (!runtimeSupported) {
    exits.push(EXIT.unavailable);
    diagnostics.push(
      diagnostic(
        "DOCTOR_RUNTIME_UNSUPPORTED",
        "error",
        `Node.js ${context.nodeVersion} is older than ${MINIMUM_NODE_MAJOR}`,
        {
          evidence: [context.nodeVersion],
          remediation: `Use Node.js ${MINIMUM_NODE_MAJOR} or later in this session.`,
        },
      ),
    );
  }

  // Configuration and lock.
  const app = await openRoot(options.root);
  const resolution = await resolveConfiguration(app, context);
  const result = resolution.result;
  diagnostics.push(...resolution.diagnostics, ...(result?.diagnostics ?? []));
  const lock = result?.lock ?? null;
  if (!resolution.releaseLoaded) exits.push(EXIT.internal);
  else if (!result?.envelope) exits.push(EXIT.invalid);
  if (lock) {
    const states = [lock.framework_version, lock.engine, lock.resources, lock.extensions];
    if (states.includes("mismatch")) exits.push(EXIT.stale);
    if (lock.engine === "unknown") {
      exits.push(EXIT.unavailable);
      diagnostics.push(
        diagnostic("DOCTOR_ENGINE_UNVERIFIED", "error", "the engine's identity can't be checked against the lock", {
          path: ".design-loom/framework.lock.json#/engine_sha256",
          evidence: ["running from source, not from a built plugin"],
          remediation: "Run doctor from the installed plugin. Certified commands need a verified engine.",
        }),
      );
    }
  }

  // Workspace map.
  const workspace = await readWorkspace(app, diagnostics);
  if (workspace.state === "invalid") exits.push(EXIT.invalid);

  // Capabilities, scoped to the selected workflow (design doc 08).
  const capabilities: CapabilityReport[] = [];
  let workflowId: string | null = null;
  const configuration = result?.envelope?.configuration;
  if (configuration) {
    const application = configuration.application as unknown as {
      design_repository_id: string;
      default_workflow: string;
      capabilities: Capability[];
    };
    workflowId = options.workflow ?? application.default_workflow;
    const workflow = (configuration.workflows as unknown as Workflow[]).find((entry) => entry.id === workflowId);
    if (!workflow) {
      exits.push(EXIT.invalid);
      diagnostics.push(
        diagnostic("DOCTOR_UNKNOWN_WORKFLOW", "error", `workflow ${workflowId} is not registered`, {
          remediation: "Pick a workflow from the effective configuration.",
        }),
      );
    }
    const used = new Set(workflow?.steps.flatMap((step) => step.capabilities) ?? []);
    for (const capability of application.capabilities) {
      const probed = await probe(capability, app, application.design_repository_id, workspace.map);
      const report: CapabilityReport = {
        id: capability.id,
        provider: capability.provider,
        mode: capability.mode,
        required: capability.required,
        used_by_workflow: used.has(capability.id),
        state: probed.state,
        evidence: probed.evidence,
      };
      capabilities.push(report);
      if (report.state === "ready") continue;
      const needed = report.required && report.used_by_workflow;
      if (needed) exits.push(EXIT.unavailable);
      else degraded = true;
      diagnostics.push(
        diagnostic(
          report.state === "unknown" ? "DOCTOR_CAPABILITY_UNKNOWN" : "DOCTOR_CAPABILITY_UNAVAILABLE",
          needed ? "error" : "warning",
          `capability ${report.id} (${report.provider}) is ${report.state}${needed ? " and the workflow requires it" : ""}`,
          {
            evidence: report.evidence,
            remediation: needed
              ? "Set it up using the application's setup reference, then run doctor again."
              : "Optional for this workflow; set it up before a step that uses it.",
          },
        ),
      );
    }
  }

  const exitCode = worstExit(exits);
  let status: RunStatus = "passed";
  if (exitCode === EXIT.invalid || exitCode === EXIT.internal) status = "failed";
  else if (exitCode !== EXIT.ok) status = "blocked";
  else if (degraded || diagnostics.some((entry) => entry.severity === "warning")) status = "degraded";

  return {
    status,
    exitCode,
    resolution,
    diagnostics,
    result: {
      runtime: { node: context.nodeVersion, supported: runtimeSupported },
      effective_config_digest: result?.digest ?? null,
      lock,
      workspace: workspace.state,
      workflow: workflowId,
      capabilities,
    },
  };
}
