/**
 * Planning for `change init` and `artifact register` (backlog B06; design doc 07, "Command surface",
 * and doc 03, "Storage conventions" and "Consumed context").
 *
 * These functions decide what to write and refuse what must not be written. They do no I/O: the
 * caller passes the repository index and the digests of files it read, and writes the planned files.
 * Every planned record is validated against its schema before it is returned.
 *
 * Refusals are errors in `diagnostics`; a plan with any error has no files.
 */

import {
  caseFoldKey,
  type Diagnostic,
  diagnostic,
  type EffectiveConfiguration,
  hasErrors,
  normalizeRelativePath,
  sortDiagnostics,
} from "@design-loom/config";
import { type SchemaKind, validateAgainstSchema } from "@design-loom/validation";
import { type ArtifactSemanticInput, artifactSemanticDigest } from "./semantic-digest.ts";
import type { ContextReference, IndexedArtifact, StoreIndex } from "./store-index.ts";
import { ownedFolderFor } from "./store-layout.ts";

const ID = /^[A-Za-z][A-Za-z0-9._-]{1,79}$/;
const SCHEMA_VERSION = "1.0";

export interface PlannedFile {
  /** Repository-relative path. */
  path: string;
  bytes: Uint8Array;
}

export interface Plan {
  /** Empty when any diagnostic is an error. Written in order: records others point at come first. */
  files: PlannedFile[];
  diagnostics: Diagnostic[];
}

export interface ArtifactPlan extends Plan {
  /** artifact-semantic-v1 of the planned record; null when nothing is planned. */
  semanticDigest: string | null;
}

/** The parts of the effective configuration registration needs. */
export interface RegistrationConfig {
  applicationId: string;
  frameworkVersion: string;
  /** Roles the application names, used as the default owners of a new change. */
  knownRoles: string[];
  repositoryIds: string[];
  artifactTypes: string[];
  workflows: { id: string; version: string; steps: { id: string; requiredOutputs: string[] }[] }[];
  templates: { id: string; version: string; artifactType: string }[];
  templateSelections: Record<string, string>;
}

type Obj = Record<string, unknown>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" ? (value as Obj) : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] => asArray(value).filter((item): item is string => typeof item === "string");

/** Reads the registration view from a resolved (and therefore schema-valid) configuration. */
export function registrationConfigOf(configuration: EffectiveConfiguration): RegistrationConfig {
  const application = asObject(configuration.application);
  const roles = new Set<string>(Object.keys(asObject(application.reviewer_roles)));
  for (const repository of asArray(application.repositories)) {
    const role = asString(asObject(repository).owner_role);
    if (role !== "") roles.add(role);
  }
  return {
    applicationId: asString(application.application_id),
    frameworkVersion: asString(application.framework_version),
    knownRoles: [...roles].sort(),
    repositoryIds: asArray(application.repositories).map((repository) => asString(asObject(repository).id)),
    artifactTypes: configuration.artifact_types,
    workflows: configuration.workflows.map((workflow) => ({
      id: asString(workflow.id),
      version: asString(workflow.version),
      steps: asArray(workflow.steps).map((step) => ({
        id: asString(asObject(step).id),
        requiredOutputs: strings(asObject(step).required_outputs),
      })),
    })),
    templates: configuration.templates.map((template) => ({
      id: asString(template.id),
      version: asString(template.version),
      artifactType: asString(template.artifact_type),
    })),
    templateSelections: Object.fromEntries(
      Object.entries(asObject(application.template_selections)).map(([type, id]) => [type, asString(id)]),
    ),
  };
}

/** Pretty-printed JSON with a trailing newline, the way the design's examples are stored. */
export function serializeRecord(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

class Findings {
  readonly list: Diagnostic[] = [];
  error(code: string, message: string, remediation: string, path = "", evidence: string[] = []): void {
    this.list.push(diagnostic(code, "error", message, { path, evidence, remediation }));
  }
  get failed(): boolean {
    return hasErrors(this.list);
  }
}

function checkIds(out: Findings, label: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!ID.test(id)) {
      out.error(
        "REGISTER_INVALID_ID",
        `${label} "${id}" is not a valid ID`,
        "Use a letter first, then letters, digits, dot, underscore or hyphen, 2 to 80 characters.",
      );
    } else if (seen.has(caseFoldKey(id))) {
      out.error("REGISTER_DUPLICATE_ID", `${label} "${id}" is listed twice`, "List each ID once.");
    }
    seen.add(caseFoldKey(id));
  }
}

function checkSchema(out: Findings, kind: SchemaKind, value: unknown, path: string): void {
  const result = validateAgainstSchema(kind, value);
  for (const issue of result.issues) {
    out.error(
      "REGISTER_RECORD_INVALID",
      `the ${kind} record would be invalid: ${issue.message}${issue.instancePath ? ` at ${issue.instancePath}` : ""}`,
      "Report this as a defect; the command should have refused the input earlier.",
      path,
    );
  }
}

const unique = (items: readonly string[]): string[] => [...new Set(items)].sort();

// ---------------------------------------------------------------------------------------------------
// change init

export interface ChangeRequest {
  id: string;
  title: string;
  workflowId: string;
  summary?: string;
  ownerRoles?: string[];
  requirementIds?: string[];
  sourceIds?: string[];
  repositoryIds?: string[];
  exclusions?: string[];
}

/**
 * Creates `changes/<id>/change.json` and an empty `traceability.json`. `existingFolders` are the
 * names already under `changes/`, which may include folders the index could not read as changes.
 */
export function planChange(
  request: ChangeRequest,
  config: RegistrationConfig,
  index: StoreIndex,
  existingFolders: readonly string[],
): Plan {
  const out = new Findings();
  checkIds(out, "change ID", [request.id]);
  checkIds(out, "requirement ID", request.requirementIds ?? []);
  checkIds(out, "owner role", request.ownerRoles ?? []);
  if (request.title.trim() === "") out.error("REGISTER_EMPTY_TITLE", "the change title is empty", "Give it a title.");

  const key = caseFoldKey(request.id);
  const taken = [...existingFolders, ...index.changes.keys()].some((name) => caseFoldKey(name) === key);
  if (taken) {
    out.error(
      "CHANGE_EXISTS",
      `change ${request.id} already exists`,
      "Choose another ID. Existing changes are never overwritten.",
      `changes/${request.id}`,
    );
  }

  const workflow = config.workflows.find((candidate) => candidate.id === request.workflowId);
  if (!workflow) {
    out.error(
      "REGISTER_UNKNOWN_WORKFLOW",
      `workflow ${request.workflowId} is not registered`,
      `Use one of: ${config.workflows.map((candidate) => candidate.id).join(", ") || "(none)"}.`,
    );
  }

  const sourceIds = unique(request.sourceIds ?? []);
  for (const id of sourceIds) {
    if (!index.sources.has(id)) {
      out.error("REGISTER_UNKNOWN_SOURCE", `source ${id} is not registered`, "Capture or register the source first.");
    }
  }
  const repositoryIds = unique(request.repositoryIds ?? []);
  for (const id of repositoryIds) {
    if (!config.repositoryIds.includes(id)) {
      out.error(
        "REGISTER_UNKNOWN_REPOSITORY",
        `repository ${id} is not in the application profile`,
        "Name repositories listed in .design-loom/app.json.",
      );
    }
  }
  const ownerRoles = unique(request.ownerRoles?.length ? request.ownerRoles : config.knownRoles);
  if (ownerRoles.length === 0) {
    out.error(
      "REGISTER_OWNER_ROLE_REQUIRED",
      "the application names no roles, so the change needs an owner role",
      "Pass at least one --owner-role.",
    );
  }
  if (out.failed || !workflow) return { files: [], diagnostics: sortDiagnostics(out.list) };

  const change = {
    schema_version: SCHEMA_VERSION,
    id: request.id,
    application_id: config.applicationId,
    title: request.title.trim(),
    workflow_id: workflow.id,
    workflow_version: workflow.version,
    requirement_ids: unique(request.requirementIds ?? []),
    source_ids: sourceIds,
    target_repository_ids: repositoryIds,
    scope: (request.summary ?? "").trim() === "" ? request.title.trim() : (request.summary ?? "").trim(),
    exclusions: request.exclusions ?? [],
    owner_roles: ownerRoles,
  };
  const traceability = {
    schema_version: SCHEMA_VERSION,
    change_id: request.id,
    requirements: [],
    tests: [],
    design_links: [],
    gaps: [],
  };
  const changePath = `changes/${request.id}/change.json`;
  const tracePath = `changes/${request.id}/traceability.json`;
  checkSchema(out, "change", change, changePath);
  checkSchema(out, "traceability", traceability, tracePath);
  if (out.failed) return { files: [], diagnostics: sortDiagnostics(out.list) };
  // The change record goes last: its presence is what makes the change exist.
  return {
    files: [
      { path: tracePath, bytes: serializeRecord(traceability) },
      { path: changePath, bytes: serializeRecord(change) },
    ],
    diagnostics: [],
  };
}

// ---------------------------------------------------------------------------------------------------
// artifact register

export type ArtifactScopeRequest = { kind: "change"; changeId: string } | { kind: "project" };

export interface FileDigest {
  path: string;
  sha256: string;
}

export interface ArtifactRequest {
  id: string;
  type: string;
  title?: string;
  scope: ArtifactScopeRequest;
  /** Changes a QA artifact covers; change scope only. */
  coveredChangeIds?: string[];
  /** Content already in the repository; the caller hashed its bytes. */
  content: FileDigest;
  attachments?: FileDigest[];
  ownerRole?: string;
  workflowStep?: string;
  dependsOn?: string[];
  sourceIds?: string[];
  requirementIds?: string[];
}

function scopeFolder(scope: ArtifactScopeRequest): string {
  return scope.kind === "project" ? "shared/" : ownedFolderFor("change", scope.changeId);
}

/** Registered files must live in the content folder of the scope that owns the artifact. */
function checkFilePlacement(out: Findings, label: string, path: string, scope: ArtifactScopeRequest): void {
  let normalized: string;
  try {
    normalized = normalizeRelativePath(path);
  } catch {
    out.error(
      "REGISTER_UNSAFE_PATH",
      `${label} path is not a safe relative path`,
      "Use a path inside the repository, with forward slashes and no .. parts.",
    );
    return;
  }
  const folder = `${scopeFolder(scope)}content/`;
  if (!normalized.startsWith(folder) || normalized === folder) {
    out.error(
      "REGISTER_CONTENT_OUTSIDE_SCOPE",
      `${label} ${normalized} is not inside ${folder}`,
      `Save the file under ${folder} first; ${scope.kind === "project" ? "project" : "change"}-scoped artifacts keep their content there.`,
      normalized,
    );
  }
}

function selectTemplate(
  out: Findings,
  config: RegistrationConfig,
  type: string,
): { id: string; version: string } | null {
  if (!config.artifactTypes.includes(type)) {
    out.error(
      "REGISTER_UNKNOWN_ARTIFACT_TYPE",
      `artifact type ${type} is not registered`,
      `Use one of: ${config.artifactTypes.join(", ")}.`,
    );
    return null;
  }
  const ofType = config.templates.filter((template) => template.artifactType === type);
  const chosenId = config.templateSelections[type];
  // The application's selection wins; otherwise the release's own template for the type.
  const match =
    chosenId === undefined
      ? ofType.filter((template) => template.id.startsWith("core."))
      : ofType.filter((template) => template.id === chosenId);
  if (match.length !== 1 || !match[0]) {
    out.error(
      "REGISTER_TEMPLATE_UNRESOLVED",
      `no single template resolves for artifact type ${type}`,
      "Select a template for this type in .design-loom/app.json.",
    );
    return null;
  }
  return { id: match[0].id, version: match[0].version };
}

interface ChangeView {
  ownerRoles: string[];
  workflowId: string;
}

function readChange(index: StoreIndex, changeId: string): ChangeView | null {
  const change = index.changes.get(changeId);
  if (!change) return null;
  const record = asObject(change.record);
  return { ownerRoles: strings(record.owner_roles), workflowId: change.record.workflow_id };
}

function checkScope(out: Findings, request: ArtifactRequest, index: StoreIndex): ChangeView | null {
  const { scope } = request;
  if (scope.kind === "project") return null;
  const change = readChange(index, scope.changeId);
  if (!change) {
    out.error(
      "REGISTER_UNKNOWN_CHANGE",
      `change ${scope.changeId} does not exist`,
      "Create it with change init first.",
      `changes/${scope.changeId}`,
    );
  }
  for (const id of request.coveredChangeIds ?? []) {
    if (!index.changes.has(id)) {
      out.error(
        "REGISTER_UNKNOWN_COVERED_CHANGE",
        `covered change ${id} does not exist`,
        "Cover existing changes of this application only.",
      );
    }
  }
  return change;
}

function resolveOwnerRole(out: Findings, request: ArtifactRequest, change: ChangeView | null): string {
  if (request.ownerRole !== undefined) {
    if (!ID.test(request.ownerRole)) {
      out.error("REGISTER_INVALID_ID", `owner role "${request.ownerRole}" is not a valid ID`, "Use a role name.");
    } else if (change && !change.ownerRoles.includes(request.ownerRole)) {
      out.error(
        "REGISTER_OWNER_ROLE_NOT_IN_CHANGE",
        `role ${request.ownerRole} is not an owner role of the change`,
        `Use one of: ${change.ownerRoles.join(", ")}.`,
      );
    }
    return request.ownerRole;
  }
  if (change?.ownerRoles.length === 1) return change.ownerRoles[0] as string;
  out.error(
    "REGISTER_OWNER_ROLE_REQUIRED",
    "the owner role can't be chosen automatically",
    change ? `Pass --owner-role; the change allows ${change.ownerRoles.join(", ")}.` : "Pass --owner-role.",
  );
  return "";
}

function resolveStep(
  out: Findings,
  request: ArtifactRequest,
  change: ChangeView | null,
  config: RegistrationConfig,
): string | null {
  if (!change) return null;
  const workflow = config.workflows.find((candidate) => candidate.id === change.workflowId);
  if (!workflow) {
    out.error(
      "REGISTER_CHANGE_WORKFLOW_UNKNOWN",
      `the change's workflow ${change.workflowId} is not registered`,
      "Restore the workflow or the extension that provides it.",
    );
    return null;
  }
  if (request.workflowStep !== undefined) {
    if (workflow.steps.some((step) => step.id === request.workflowStep)) return request.workflowStep;
    out.error(
      "REGISTER_UNKNOWN_STEP",
      `step ${request.workflowStep} is not in workflow ${workflow.id}`,
      `Use one of: ${workflow.steps.map((step) => step.id).join(", ")}.`,
    );
    return null;
  }
  const producers = workflow.steps.filter((step) => step.requiredOutputs.includes(request.type));
  if (producers.length === 1 && producers[0]) return producers[0].id;
  out.error(
    "REGISTER_STEP_REQUIRED",
    producers.length === 0
      ? `no step of workflow ${workflow.id} produces ${request.type}`
      : `several steps of workflow ${workflow.id} produce ${request.type}`,
    `Pass --step with one of: ${(producers.length ? producers : workflow.steps).map((step) => step.id).join(", ")}.`,
  );
  return null;
}

function artifactReference(
  out: Findings,
  id: string,
  request: ArtifactRequest,
  index: StoreIndex,
): ContextReference | null {
  const target: IndexedArtifact | undefined = index.artifacts.get(id);
  if (id === request.id) {
    out.error("REGISTER_SELF_DEPENDENCY", `artifact ${id} can't depend on itself`, "Remove it from --depends-on.");
  } else if (!target) {
    out.error("REGISTER_UNKNOWN_DEPENDENCY", `dependency ${id} is not registered`, "Register it first.");
  } else if (request.scope.kind === "project" && target.scope !== "project") {
    out.error(
      "REGISTER_PROJECT_DEPENDS_ON_CHANGE",
      `project artifact ${request.id} can't depend on change artifact ${id}`,
      "Project artifacts depend only on other project artifacts and sources, so shared context doesn't inherit a workstream's draft.",
    );
  } else if (target.semanticDigest === null) {
    out.error(
      "REGISTER_DEPENDENCY_UNVERIFIED",
      `dependency ${id} has content that doesn't match its recorded digest`,
      "Fix the dependency first; a context receipt needs verified bytes.",
      target.path,
    );
  } else {
    return { kind: "artifact", id, state: "read", sha256: target.semanticDigest };
  }
  return null;
}

function sourceReference(out: Findings, id: string, index: StoreIndex): ContextReference | null {
  const source = index.sources.get(id);
  if (!source) {
    out.error("REGISTER_UNKNOWN_SOURCE", `source ${id} is not registered`, "Capture or register the source first.");
    return null;
  }
  if (source.snapshotVerified === false) {
    out.error(
      "REGISTER_SOURCE_UNVERIFIED",
      `source ${id}'s snapshot doesn't match its recorded digest`,
      "Recapture the source before relying on it.",
      source.path,
    );
    return null;
  }
  const { sha256, revision } = source.record;
  // Without recorded bytes the source was named, not read: say so rather than claim a digest.
  if (sha256 === undefined) return { kind: "source", id, state: "linked" };
  return { kind: "source", id, state: "read", revision, sha256 };
}

/**
 * Creates the sidecar for an artifact whose content already sits in its scope's content folder.
 * Context receipts bind every dependency and source named, at the digests the index holds now.
 */
export function planArtifact(request: ArtifactRequest, config: RegistrationConfig, index: StoreIndex): ArtifactPlan {
  const out = new Findings();
  const { scope } = request;
  checkIds(out, "artifact ID", [request.id]);
  checkIds(out, "dependency", request.dependsOn ?? []);
  checkIds(out, "source", request.sourceIds ?? []);
  checkIds(out, "requirement ID", request.requirementIds ?? []);
  if (
    index.artifacts.has(request.id) ||
    [...index.artifacts.keys()].some((id) => caseFoldKey(id) === caseFoldKey(request.id))
  ) {
    out.error(
      "ARTIFACT_EXISTS",
      `artifact ${request.id} already exists`,
      "Choose another ID. Existing artifacts are never overwritten.",
    );
  }
  const coveredIds = request.coveredChangeIds ?? [];
  if (scope.kind === "project" && coveredIds.length > 0) {
    out.error(
      "REGISTER_COVERED_CHANGES_NEED_CHANGE_SCOPE",
      "project artifacts can't list covered changes",
      "Covered changes apply to change-scoped QA artifacts only.",
    );
  }
  checkIds(out, "covered change ID", coveredIds);
  const covered = unique(coveredIds);

  const template = selectTemplate(out, config, request.type);
  const change = checkScope(out, request, index);
  checkFilePlacement(out, "content", request.content.path, scope);
  for (const attachment of request.attachments ?? []) checkFilePlacement(out, "attachment", attachment.path, scope);
  const ownerRole = resolveOwnerRole(out, request, change);
  const step = scope.kind === "change" ? resolveStep(out, request, change, config) : null;

  const dependsOn = unique(request.dependsOn ?? []);
  const sourceIds = unique(request.sourceIds ?? []);
  const references = [
    ...sourceIds.map((id) => sourceReference(out, id, index)),
    ...dependsOn.map((id) => artifactReference(out, id, request, index)),
  ].filter((reference): reference is ContextReference => reference !== null);
  if (out.failed || !template) return { files: [], diagnostics: sortDiagnostics(out.list), semanticDigest: null };

  const base = {
    schema_version: SCHEMA_VERSION,
    id: request.id,
    application_id: config.applicationId,
    ...(scope.kind === "change" ? { change_id: scope.changeId } : {}),
    type: request.type,
    title: (request.title ?? "").trim() === "" ? request.id : (request.title ?? "").trim(),
    state: "draft",
    ...(step === null ? {} : { workflow_step: step }),
    template_id: template.id,
    template_version: template.version,
    framework_version: config.frameworkVersion,
    content: { path: normalizeRelativePath(request.content.path), sha256: request.content.sha256 },
    attachments: (request.attachments ?? []).map((item) => ({
      path: normalizeRelativePath(item.path),
      sha256: item.sha256,
    })),
    source_ids: sourceIds,
    requirement_ids: unique(request.requirementIds ?? []),
    depends_on: dependsOn,
    owner_role: ownerRole,
    applicability: "applicable",
    ...(covered.length > 0 ? { covered_change_ids: covered } : {}),
    ...(scope.kind === "project" ? { scope: "project" } : {}),
    context: { schema_version: SCHEMA_VERSION, references, gaps: [] },
  };
  const path =
    scope.kind === "project"
      ? `shared/artifacts/${request.id}.json`
      : `changes/${scope.changeId}/artifacts/${request.id}.json`;
  checkSchema(out, "artifact", base, path);
  if (out.failed) return { files: [], diagnostics: sortDiagnostics(out.list), semanticDigest: null };
  return {
    files: [{ path, bytes: serializeRecord(base) }],
    diagnostics: [],
    semanticDigest: artifactSemanticDigest(base as ArtifactSemanticInput),
  };
}
